"""Pain point detectors (spec §5.4).

Each detector reads *concepts* (not file names), computes its metrics deterministically, cites the
exact rows or lines it used, and states its confidence. A signal that rests on no source data is
returned with `is_hypothesis=True` so it is always shown as "hypothèse à valider".
"""

from __future__ import annotations

import re
import statistics
from collections import Counter, defaultdict
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date, datetime

from app.domain.enums import Criticality as Cr
from app.domain.enums import PainPointType as T
from app.engine.benchmarks import BENCHMARKS, bench
from app.engine.context import AnalysisContext, Dataset, is_true, mean, median, to_float
from app.engine.extract import Extraction, ProcessInfo
from app.engine.fmt import mad, n0, n1, pct
from app.engine.semantics import canonical_tool
from app.models import Evidence

EMAIL_LIKE = (
    "ventes",
    "finance",
    "operations",
    "support",
    "contrats",
    "reporting",
    "rh",
    "achats",
    "autre",
    "qualite",
    "maintenance",
)


@dataclass
class MetricSpec:
    key: str
    label: str
    value: float
    unit: str
    formula: str
    nature: str = "calcul"  # fait | calcul | hypothese
    inputs: dict = field(default_factory=dict)
    evidence: list[Evidence] = field(default_factory=list)


@dataclass
class RiskSpec:
    title: str
    description: str
    kind: str
    severity: str
    likelihood: float
    exposure: float | None = None


@dataclass
class Finding:
    code: str
    title: str
    description: str
    type: str
    criticality: str
    confidence: float
    department: str | None = None
    scope: str | None = None
    process: str | None = None
    frequency: str | None = None
    frequency_per_month: float | None = None
    impact: str | None = None
    impact_mad_per_year: float | None = None
    is_hypothesis: bool = False
    evidence: list[Evidence] = field(default_factory=list)
    metrics: list[MetricSpec] = field(default_factory=list)
    risk: RiskSpec | None = None
    signals: dict = field(default_factory=dict)
    severity: float = 0.0  # raw 0-1 score set by `grade_finding`


@dataclass
class Env:
    ctx: AnalysisContext
    ex: Extraction
    params: dict
    ref_date: date

    def process_for(self, ds: Dataset | None = None, name: str | None = None) -> ProcessInfo | None:
        for p in self.ex.processes:
            if (ds is not None and p.dataset is ds) or (name and p.name == name):
                return p
        return None


def graded(score: float) -> dict:
    """Keyword arguments for a Finding: criticality and the raw severity score it came from."""
    return {"criticality": grade(score), "severity": round(min(1.0, score), 3)}


def grade(score: float) -> str:
    """Criticality from a 0-1 severity score (see `calibrate` for the mission-level adjustment)."""
    if score >= 0.85:
        return Cr.critique
    if score >= 0.65:
        return Cr.elevee
    if score >= 0.4:
        return Cr.moyenne
    return Cr.faible


def _dates(ds: Dataset) -> list[date]:
    if not ds.has("date"):
        return []
    out = []
    for v in ds.values("date"):
        try:
            out.append(datetime.strptime(v[:10], "%Y-%m-%d").date())
        except ValueError:
            continue
    return out


def period_months(ds: Dataset) -> float | None:
    """Months covered by a dataset with a date column (None when the period is unknown)."""
    d = _dates(ds)
    if len(d) < 2:
        return None
    return round(max(1.0, ((max(d) - min(d)).days + 1) / 30.44), 1)


def reference_date(ctx: AnalysisContext) -> date:
    candidates: list[date] = []
    for ds in ctx.datasets:
        candidates += _dates(ds)
    for t in ctx.texts:
        raw = str(t.document.meta.get("date") or "")
        m = re.search(r"(\d{4})-(\d{2})-(\d{2})", raw)
        if m:
            candidates.append(date(int(m.group(1)), int(m.group(2)), int(m.group(3))))
    return max(candidates) if candidates else date.today()


def corroborate(
    env: Env,
    pattern: str,
    summary: str,
    detector: str,
    limit: int = 3,
    categories: tuple[str, ...] | None = None,
) -> tuple[list[Evidence], int]:
    """Cite up to `limit` documents whose lines match `pattern`; return evidence and match count."""
    hits = env.ctx.grep(pattern, categories)
    evidence = [env.ctx.cite_lines(t, lines, summary, detector, relevance=0.6) for t, lines in hits[:limit]]
    return evidence, len(hits)


def _owner(env: Env, ds: Dataset | None = None, name: str | None = None) -> tuple[str | None, str | None]:
    proc = env.process_for(ds, name)
    return (proc.owner_department, proc.name) if proc else (None, name)


# --------------------------------------------------------------------------------------------------
# Structured-data detectors
# --------------------------------------------------------------------------------------------------


def detect_manual_entry(env: Env) -> list[Finding]:
    out = []
    for ds in env.ctx.datasets:
        if not ds.has("manual_flag") or ds.n < 10:
            continue
        code = f"manual_entry:{ds.kind or ds.table.name}"
        i = ds.idx("manual_flag")
        yes = ds.where(lambda r, i=i: is_true(r[i]))
        rate = len(yes) / ds.n
        if rate < 0.3:
            continue
        label = ds.label.lower()
        c = env.ctx
        ev_rows = c.cite_rows(
            ds, yes, ["manual_flag"], f"{len(yes)} {label} sur {ds.n} avec ressaisie manuelle", code
        )
        metrics = [
            MetricSpec(
                "manual_rate",
                f"Part de {label} ressaisis manuellement",
                round(rate, 4),
                "ratio",
                f"count({ds.column('manual_flag')}=yes) / count(*) = {len(yes)} / {ds.n}",
                inputs={"oui": len(yes), "total": ds.n},
                evidence=[ev_rows],
            ),
            MetricSpec(
                "volume",
                f"Nombre de {label} dans les données",
                ds.n,
                "",
                f"count(*) sur {ds.document.filename}",
                nature="fait",
                evidence=[
                    c.cite_aggregate(
                        ds,
                        f"{ds.n} {label} analysés",
                        f"count(*) = {ds.n}",
                        {"count": ds.n},
                        list(ds.concepts)[:2],
                        code,
                    )
                ],
            ),
        ]
        parts = [f"{pct(rate, 0)} ressaisis"]
        templates = Counter(ds.values("template")) if ds.has("template") else Counter()
        templates.pop("", None)
        if len(templates) >= 2:
            ev = c.cite_aggregate(
                ds,
                f"{len(templates)} modèles différents utilisés",
                " ; ".join(f"{k} : {v}" for k, v in templates.most_common()),
                dict(templates),
                ["template"],
                code,
            )
            metrics.append(
                MetricSpec(
                    "templates",
                    "Modèles différents en circulation",
                    len(templates),
                    "",
                    f"count(distinct {ds.column('template')})",
                    nature="fait",
                    inputs=dict(templates),
                    evidence=[ev],
                )
            )
            parts.append(f"{len(templates)} modèles différents")
        med = median(ds.numbers("prep_minutes")) if ds.has("prep_minutes") else None
        manual_hours = None
        if med is not None:
            minutes = [to_float(ds.cell(n, "prep_minutes")) or 0 for n in yes]
            manual_hours = sum(minutes) / 60
            ev = c.cite_aggregate(
                ds,
                f"Temps médian de préparation : {n0(med)} min",
                f"median({ds.column('prep_minutes')}) = {med:g} min",
                {"median": med, "mean": round(mean(ds.numbers("prep_minutes")) or 0, 1)},
                ["prep_minutes"],
                code,
            )
            metrics.append(
                MetricSpec(
                    "median_minutes",
                    "Temps médian de préparation",
                    med,
                    "min",
                    f"median({ds.column('prep_minutes')})",
                    evidence=[ev],
                )
            )
            metrics.append(
                MetricSpec(
                    "manual_hours",
                    f"Heures passées sur les {label} ressaisis (données)",
                    round(manual_hours, 1),
                    "h",
                    f"sum({ds.column('prep_minutes')} | ressaisie) / 60",
                    evidence=[ev_rows],
                )
            )
            parts.append(f"{n0(med)} min médianes")
        text_ev, text_hits = corroborate(
            env,
            r"ressaisi|à la main|a la main|ancien mod[eè]le|v[ée]rifier les prix",
            "Témoignage de saisie manuelle",
            code,
        )
        dept, proc = _owner(env, ds)
        score = (
            0.45 * rate
            + 0.2 * (len(templates) >= 3)
            + 0.2 * min(1, ds.n / 100)
            + 0.15 * min(1, text_hits / 2)
        )
        out.append(
            Finding(
                code=code,
                title=f"{ds.label} préparés manuellement : {', '.join(parts)}",
                description=(
                    f"Sur {ds.n} {label} analysés ({ds.document.filename}), {len(yes)} ont nécessité une ressaisie manuelle "
                    f"({pct(rate)})."
                    + (
                        f" {len(templates)} modèles différents circulent ({', '.join(list(templates)[:4])})."
                        if len(templates) >= 2
                        else ""
                    )
                    + (f" Temps médian de préparation : {n0(med)} min." if med is not None else "")
                    + (
                        f" {text_hits} document(s) confirment des vérifications ou ressaisies à la main."
                        if text_hits
                        else ""
                    )
                ),
                type=T.double_saisie,
                **graded(score),
                confidence=round(min(0.95, 0.8 + 0.05 * bool(text_hits) + 0.05 * (med is not None)), 2),
                department=dept,
                process=proc,
                scope=f"{ds.label} — {ds.document.filename}",
                frequency=f"{len(yes)} {label} sur {ds.n} ({pct(rate, 0)})",
                impact=f"{n1(manual_hours)} h de préparation sur les enregistrements ressaisis du jeu de données"
                if manual_hours
                else None,
                evidence=[ev_rows, *text_ev],
                metrics=metrics,
                signals={
                    "volume": ds.n,
                    "manual_rate": rate,
                    "median_minutes": med,
                    "templates": len(templates),
                    "dataset": ds.label,
                    "period_months": period_months(ds),
                },
            )
        )
    return out


def detect_lost_quotes(env: Env) -> list[Finding]:
    ds = env.ctx.dataset("quotes")
    if ds is None or not ds.has("status"):
        return []
    status = [v.strip().lower() for v in ds.values("status")]
    lost = [i + 1 for i, s in enumerate(status) if s in ("lost", "perdu", "refuse", "refusé")]
    pending = [i + 1 for i, s in enumerate(status) if s in ("pending", "en attente", "envoye", "envoyé")]
    won = [i + 1 for i, s in enumerate(status) if s in ("won", "gagne", "gagné", "accepte", "accepté")]
    if len(lost) / ds.n < 0.25:
        return []
    code = "commercial:quotes_conversion"
    amounts = ds.numbers("amount") if ds.has("amount") else [None] * ds.n
    lost_value = sum(amounts[n - 1] or 0 for n in lost)
    pending_value = sum(amounts[n - 1] or 0 for n in pending)
    decided = len(won) + len(lost)
    win_rate = len(won) / decided if decided else 0
    c = env.ctx
    ev_lost = c.cite_rows(
        ds, lost, ["status", "amount"], f"{len(lost)} devis perdus ({mad(lost_value)})", code
    )
    ev_pending = c.cite_rows(
        ds, pending, ["status", "amount"], f"{len(pending)} devis en attente ({mad(pending_value)})", code
    )
    dept, proc = _owner(env, ds)
    return [
        Finding(
            code=code,
            title=f"Potentiel commercial non exploité : {pct(len(lost) / ds.n, 0)} de devis perdus, {pct(len(pending) / ds.n, 0)} sans décision",
            description=(
                f"{len(lost)} devis perdus ({mad(lost_value)}) et {len(pending)} en attente ({mad(pending_value)}). "
                f"Taux de transformation sur devis décidés : {pct(win_rate)}. Aucune donnée de relance ou de motif de perte "
                "n'est disponible dans les sources : le suivi commercial semble non outillé (à confirmer en entretien)."
            ),
            type=T.potentiel_commercial,
            **graded(0.3 + 0.4 * len(lost) / ds.n + 0.2 * len(pending) / ds.n),
            confidence=0.7,
            department=dept,
            process=proc,
            scope=f"Devis — {ds.document.filename}",
            frequency=f"{len(lost)} perdus, {len(pending)} en attente sur {ds.n}",
            impact=f"{mad(pending_value)} de devis en attente à sécuriser",
            evidence=[ev_lost, ev_pending],
            metrics=[
                MetricSpec(
                    "win_rate",
                    "Taux de transformation (devis décidés)",
                    round(win_rate, 4),
                    "ratio",
                    f"gagnés / (gagnés + perdus) = {len(won)} / {decided}",
                    inputs={"gagnes": len(won), "perdus": len(lost)},
                    evidence=[ev_lost],
                ),
                MetricSpec(
                    "pending_value",
                    "Montant des devis en attente",
                    round(pending_value),
                    "MAD",
                    "sum(montant | en attente)",
                    evidence=[ev_pending],
                ),
            ],
            signals={
                "lost": len(lost),
                "pending": len(pending),
                "won": len(won),
                "pending_value": pending_value,
                "win_rate": win_rate,
                "volume": ds.n,
            },
        )
    ]


def detect_receivables(env: Env) -> list[Finding]:
    ds = env.ctx.dataset("receivables")
    if ds is None:
        return []
    code = "finance:receivables"
    days = ds.numbers("days_overdue")
    amounts = ds.numbers("amount")
    if ds.has(
        "status"
    ):  # the status says what is currently unpaid; days_overdue alone also covers late payments
        status = [v.strip().lower() for v in ds.values("status")]
        overdue = [
            i + 1 for i in range(ds.n) if re.search(r"overdue|retard|impay|echu|échu|unpaid", status[i])
        ]
    else:
        overdue = [i + 1 for i in range(ds.n) if (days[i] or 0) > 0]
    if not overdue:
        return []
    overdue_amount = sum(amounts[n - 1] or 0 for n in overdue)
    total_amount = sum(a or 0 for a in amounts)
    share = len(overdue) / ds.n
    late60 = [n for n in overdue if (days[n - 1] or 0) >= 60]
    late60_amount = sum(amounts[n - 1] or 0 for n in late60)
    c = env.ctx
    ev_overdue = c.cite_rows(
        ds,
        overdue,
        ["status", "days_overdue", "amount"],
        f"{len(overdue)} factures échues ({mad(overdue_amount)})",
        code,
    )
    metrics = [
        MetricSpec(
            "overdue_amount",
            "Montant des créances échues",
            round(overdue_amount),
            "MAD",
            "sum(montant | statut échu)",
            nature="fait",
            evidence=[ev_overdue],
        ),
        MetricSpec(
            "overdue_share",
            "Part des factures échues",
            round(share, 4),
            "ratio",
            f"{len(overdue)} / {ds.n}",
            evidence=[ev_overdue],
        ),
        MetricSpec(
            "late60_amount",
            "Créances échues depuis 60 jours ou plus",
            round(late60_amount),
            "MAD",
            "sum(montant | retard ≥ 60 j)",
            evidence=[
                c.cite_rows(
                    ds, late60, ["days_overdue", "amount"], f"{len(late60)} factures à 60 jours ou plus", code
                )
            ],
        ),
    ]
    findings_text = []
    # Prioritisation test: are high-margin invoices followed up faster than low-margin ones?
    no_priority = None
    if ds.has("margin_pct"):
        margins = ds.numbers("margin_pct")
        cut = median(margins)
        high = [days[n - 1] for n in overdue if (margins[n - 1] or 0) >= (cut or 0)]
        low = [days[n - 1] for n in overdue if (margins[n - 1] or 0) < (cut or 0)]
        mh, ml = mean(high) or 0, mean(low) or 0
        gap = abs(mh - ml) / max(mh, ml, 1)
        no_priority = gap < 0.15
        ev = c.cite_aggregate(
            ds,
            "Retard moyen selon la marge des factures échues",
            f"retard moyen marge ≥ médiane ({pct(cut or 0)}) : {n1(mh)} j ; marge < médiane : {n1(ml)} j",
            {"high_margin_days": round(mh, 1), "low_margin_days": round(ml, 1), "median_margin": cut},
            ["margin_pct", "days_overdue"],
            code,
            rows=overdue,
        )
        metrics.append(
            MetricSpec(
                "margin_priority_gap",
                "Écart de retard entre factures à forte et faible marge",
                round(gap, 3),
                "ratio",
                "|retard moyen forte marge − faible marge| / max",
                inputs={"forte_marge_j": round(mh, 1), "faible_marge_j": round(ml, 1)},
                evidence=[ev],
            )
        )
        if no_priority:
            findings_text.append(
                f"les factures à forte marge ne sont pas relancées plus tôt (retard moyen {n1(mh)} j contre {n1(ml)} j)"
            )
    systems = Counter()
    if ds.has("source_system"):
        for v in ds.values("source_system"):
            tool = canonical_tool(v)
            systems[tool[0] if tool else v] += 1
        if len(systems) >= 2:
            ev = c.cite_aggregate(
                ds,
                f"Factures saisies dans {len(systems)} systèmes",
                " ; ".join(f"{k} : {v}" for k, v in systems.most_common()),
                dict(systems),
                ["source_system"],
                code,
            )
            metrics.append(
                MetricSpec(
                    "systems",
                    "Systèmes d'origine des factures",
                    len(systems),
                    "",
                    "count(distinct source)",
                    nature="fait",
                    inputs=dict(systems),
                    evidence=[ev],
                )
            )
            findings_text.append(f"les factures proviennent de {len(systems)} sources ({', '.join(systems)})")
    text_ev, hits = corroborate(
        env, r"relance|copie de la facture|impay", "Échange sur une relance ou une facture", code
    )
    coc = bench("cost_of_capital", env.params)
    financing = overdue_amount * coc
    metrics.append(
        MetricSpec(
            "financing_cost",
            "Coût de financement annuel des créances échues",
            round(financing),
            "MAD/an",
            f"{n0(overdue_amount)} × {pct(coc, 0)}",
            inputs={
                "creances_echues": {"value": round(overdue_amount), "nature": "fait"},
                "cout_du_capital": {"value": coc, "nature": "hypothese"},
            },
        )
    )
    revenue = env.ctx.mission.organization.revenue_mad or total_amount
    weight = overdue_amount / (revenue / 12) if revenue else share
    dept, proc = _owner(env, ds)
    months = period_months(ds)
    return [
        Finding(
            code=code,
            title=f"Relances d'impayés non priorisées : {mad(overdue_amount)} de créances échues",
            description=(
                f"{len(overdue)} factures sur {ds.n} sont échues ({pct(share)}), pour {mad(overdue_amount)} dont {mad(late60_amount)} à 60 jours ou plus. "
                + ("Constat : " + " ; ".join(findings_text) + ". " if findings_text else "")
                + "Les relances ne semblent pas croiser marge, risque et historique client."
            ),
            type=T.stock_cash_immobilise,
            **graded(0.35 + 0.3 * min(1, weight) + 0.2 * bool(no_priority) + 0.15 * min(1, hits / 2)),
            confidence=round(0.8 + 0.05 * bool(no_priority is not None) + 0.05 * bool(hits), 2),
            department=dept,
            process=proc,
            scope=f"Factures clients — {ds.document.filename}",
            frequency=f"{len(overdue)} factures échues"
            + (f" sur {n1(months)} mois de données" if months else ""),
            frequency_per_month=round(len(overdue) / months, 1) if months else None,
            impact=f"Cash immobilisé : {mad(overdue_amount)} (coût de financement estimé {mad(financing)}/an, hypothèse {pct(coc, 0)})",
            impact_mad_per_year=round(financing),
            evidence=[ev_overdue, *text_ev],
            metrics=metrics,
            risk=RiskSpec(
                "Risque de créances irrécouvrables",
                f"{mad(late60_amount)} échus depuis 60 jours ou plus.",
                "financier",
                Cr.elevee if late60_amount > overdue_amount / 3 else Cr.moyenne,
                0.4,
                round(late60_amount),
            ),
            signals={
                "overdue_count": len(overdue),
                "overdue_amount": overdue_amount,
                "late60_amount": late60_amount,
                "volume": ds.n,
                "period_months": months,
                "no_priority": bool(no_priority),
                "systems": len(systems),
                "invoices_per_month": round(ds.n / months, 1) if months else None,
            },
        )
    ]


def detect_dormant_stock(env: Env) -> list[Finding]:
    ds = env.ctx.dataset("inventory")
    if ds is None:
        return []
    code = "inventory:dormant_stock"
    threshold = bench("dormant_days", env.params)
    days = ds.numbers("days_since_movement")
    if ds.has("stock_value"):
        values = ds.numbers("stock_value")
        value_formula = f"sum({ds.column('stock_value')})"
    else:
        q, u = ds.numbers("qty"), ds.numbers("unit_cost") if ds.has("unit_cost") else [None] * ds.n
        values = [(a or 0) * (b or 0) for a, b in zip(q, u, strict=False)]
        value_formula = "sum(quantité × coût unitaire)"
    dormant = [i + 1 for i, d in enumerate(days) if (d or 0) >= threshold]
    if not dormant:
        return []
    dormant_value = sum(values[n - 1] or 0 for n in dormant)
    total_value = sum(v or 0 for v in values)
    share = dormant_value / total_value if total_value else 0
    very_old = [n for n in dormant if (days[n - 1] or 0) >= 2 * threshold]
    c = env.ctx
    ev = c.cite_rows(
        ds,
        dormant,
        ["item", "days_since_movement", "stock_value" if ds.has("stock_value") else "qty"],
        f"{len(dormant)} références sans vente depuis {n0(threshold)} jours ou plus",
        code,
    )
    holding = bench("stock_holding_rate", env.params)
    cost = dormant_value * holding
    text_ev, hits = corroborate(
        env, r"sans mouvement|provisionn|stock dormant|obsol", "Échange sur le stock sans mouvement", code
    )
    dept, proc = _owner(env, ds)
    return [
        Finding(
            code=code,
            title=f"Stock dormant : {mad(dormant_value)} immobilisés (> {n0(threshold)} jours sans vente)",
            description=(
                f"{len(dormant)} références sur {ds.n} n'ont pas été vendues depuis au moins {n0(threshold)} jours, soit {mad(dormant_value)} "
                f"({pct(share)} de la valeur du stock). {len(very_old)} d'entre elles dépassent {n0(2 * threshold)} jours."
            ),
            type=T.stock_cash_immobilise,
            **graded(0.3 + 0.6 * min(1, share * 2) + 0.1 * bool(hits)),
            confidence=0.9,
            department=dept,
            process=proc,
            scope=f"Stock — {ds.document.filename}",
            frequency=f"{len(dormant)} références sur {ds.n}",
            impact=f"Cash immobilisé : {mad(dormant_value)} ; coût de détention estimé {mad(cost)}/an (hypothèse {pct(holding, 0)})",
            impact_mad_per_year=round(cost),
            evidence=[ev, *text_ev],
            metrics=[
                MetricSpec(
                    "dormant_value",
                    "Valeur du stock dormant",
                    round(dormant_value),
                    "MAD",
                    f"{value_formula} | jours sans vente ≥ {n0(threshold)}",
                    nature="fait",
                    inputs={"seuil_jours": {"value": threshold, "nature": "hypothese"}},
                    evidence=[ev],
                ),
                MetricSpec(
                    "dormant_share",
                    "Part de la valeur du stock",
                    round(share, 4),
                    "ratio",
                    f"{n0(dormant_value)} / {n0(total_value)}",
                    evidence=[ev],
                ),
                MetricSpec(
                    "holding_cost",
                    "Coût annuel de détention du stock dormant",
                    round(cost),
                    "MAD/an",
                    f"{n0(dormant_value)} × {pct(holding, 0)}",
                    inputs={
                        "stock_dormant": {"value": round(dormant_value), "nature": "fait"},
                        "taux_detention": {"value": holding, "nature": "hypothese"},
                    },
                ),
            ],
            risk=RiskSpec(
                "Risque d'obsolescence et de dépréciation",
                f"{len(very_old)} références au-delà de {n0(2 * threshold)} jours.",
                "financier",
                Cr.elevee if share > 0.3 else Cr.moyenne,
                0.5,
                round(sum(values[n - 1] or 0 for n in very_old)),
            ),
            signals={
                "dormant_value": dormant_value,
                "dormant_count": len(dormant),
                "total_value": total_value,
                "references": ds.n,
            },
        )
    ]


def detect_support_dispersion(env: Env) -> list[Finding]:
    ds = env.ctx.dataset("tickets")
    if ds is None or not ds.has("channel"):
        return []
    code = "support:dispersion"
    channels = Counter()
    by_channel: dict[str, list[int]] = defaultdict(list)
    for n, v in enumerate(ds.values("channel"), start=1):
        tool = canonical_tool(v)
        name = tool[0] if tool else v
        channels[name] += 1
        by_channel[name].append(n)
    hours = [h for h in ds.numbers("resolution_hours") if h is not None]
    cv = (
        statistics.pstdev(hours) / statistics.fmean(hours)
        if len(hours) > 1 and statistics.fmean(hours)
        else 0
    )
    issues = Counter(v for v in ds.values("issue")) if ds.has("issue") else Counter()
    missing = (
        ds.where(lambda r, i=ds.idx("issue"): bool(re.search(r"history|historique", r[i], re.I)))
        if ds.has("issue")
        else []
    )
    duplicate = (
        ds.where(lambda r, i=ds.idx("issue"): bool(re.search(r"duplicate|doublon", r[i], re.I)))
        if ds.has("issue")
        else []
    )
    routing = (
        ds.where(lambda r, i=ds.idx("issue"): bool(re.search(r"routing|routage|aiguillage", r[i], re.I)))
        if ds.has("issue")
        else []
    )
    if len(channels) < 3 and not missing:
        return []
    c = env.ctx
    informal = [n for name in ("WhatsApp", "Téléphone") for n in by_channel.get(name, [])]
    evidence = []
    if informal:
        evidence.append(
            c.cite_rows(
                ds, informal, ["channel"], f"{len(informal)} tickets reçus par WhatsApp ou téléphone", code
            )
        )
    if missing:
        evidence.append(
            c.cite_rows(ds, missing, ["issue"], f"{len(missing)} tickets avec historique manquant", code)
        )
    if duplicate or routing:
        evidence.append(
            c.cite_rows(
                ds,
                duplicate + routing,
                ["issue"],
                f"{len(duplicate)} doublons et {len(routing)} routages manuels",
                code,
            )
        )
    med = median(hours)
    p90 = statistics.quantiles(hours, n=10)[-1] if len(hours) >= 10 else max(hours or [0])
    ev_time = c.cite_aggregate(
        ds,
        f"Délai de résolution : médiane {n0(med or 0)} h, 90e centile {n0(p90)} h",
        f"median = {med:g} h ; p90 = {p90:.0f} h ; coefficient de variation = {cv:.2f}",
        {"median": med, "p90": round(p90, 1), "cv": round(cv, 2)},
        ["resolution_hours"],
        code,
    )
    evidence.append(ev_time)
    text_ev, hits = corroborate(
        env, r"whatsapp|ne trouve pas le dernier [ée]change", "Échange sur un canal informel", code, limit=2
    )
    open_share = None
    if ds.has("status"):
        open_rows = ds.where(
            lambda r, i=ds.idx("status"): r[i].strip().lower() in ("open", "ouvert", "en cours")
        )
        open_share = len(open_rows) / ds.n
    dept, proc = _owner(env, ds)
    months = None
    return [
        Finding(
            code=code,
            title=f"Support éclaté sur {len(channels)} canaux, historique incomplet ({pct(len(missing) / ds.n, 0)} des tickets)",
            description=(
                f"{ds.n} tickets arrivent par {len(channels)} canaux ({', '.join(f'{k} {v}' for k, v in channels.most_common())}). "
                f"{len(missing)} tickets signalent un historique manquant, {len(duplicate)} des doublons, {len(routing)} un routage manuel. "
                f"Délai de résolution très variable (médiane {n0(med or 0)} h, 90e centile {n0(p90)} h)."
            ),
            type=T.rupture_flux,
            **graded(
                0.3
                + 0.15 * min(1, (len(channels) - 2) / 2)
                + 0.25 * min(1, len(missing) / ds.n * 5)
                + 0.2 * min(1, cv)
                + 0.1 * bool(hits)
            ),
            confidence=0.85,
            department=dept,
            process=proc,
            scope=f"Support — {ds.document.filename}",
            frequency=f"{ds.n} tickets dans les données",
            frequency_per_month=months,
            impact=f"{len(missing) + len(duplicate) + len(routing)} tickets avec ressaisie, doublon ou historique perdu",
            evidence=evidence + text_ev,
            metrics=[
                MetricSpec(
                    "channels",
                    "Canaux d'entrée des demandes",
                    len(channels),
                    "",
                    "count(distinct canal)",
                    nature="fait",
                    inputs=dict(channels),
                    evidence=evidence[:1],
                ),
                MetricSpec(
                    "missing_history_share",
                    "Tickets avec historique manquant",
                    round(len(missing) / ds.n, 4),
                    "ratio",
                    f"{len(missing)} / {ds.n}",
                    evidence=evidence[1:2] if missing else [],
                ),
                MetricSpec(
                    "resolution_median_h",
                    "Délai médian de résolution",
                    med or 0,
                    "h",
                    "median(délai de résolution)",
                    evidence=[ev_time],
                ),
                MetricSpec(
                    "resolution_cv",
                    "Variabilité du délai (coefficient de variation)",
                    round(cv, 3),
                    "",
                    "écart-type / moyenne",
                    evidence=[ev_time],
                ),
            ],
            signals={
                "volume": ds.n,
                "channels": dict(channels),
                "missing": len(missing),
                "duplicate": len(duplicate),
                "routing": len(routing),
                "median_hours": med,
                "open_share": open_share,
                "issues": dict(issues),
            },
        )
    ]


def _penalty_exposure(env: Env) -> tuple[float, list[Evidence], list[str]]:
    exposure, evidence, lines = 0.0, [], []
    for c in env.ex.contracts:
        if c.annual_amount and c.penalty_pct:
            value = c.annual_amount * c.penalty_pct / 100
            exposure += value
            lines.append(f"{c.label} : {mad(c.annual_amount)} × {c.penalty_pct:g} % = {mad(value)}")
            ln = [x for x in (c.amount_line, c.sla_line, c.penalty_line) if x]
            evidence.append(
                env.ctx.cite_lines(
                    c.doc,
                    ln,
                    f"{c.label} : SLA {c.sla_hours:g} h, pénalité {c.penalty_pct:g} %",
                    "sla",
                    relevance=0.8,
                )
            )
    return exposure, evidence, lines


def detect_sla(env: Env) -> list[Finding]:
    c = env.ctx
    ds = next(
        (
            d
            for d in c.datasets
            if d.has("sla_breached") or (d.has("sla_hours") and d.has("resolution_hours"))
        ),
        None,
    )
    code = "sla:breaches"
    late_ev, late_hits = corroborate(
        env,
        r"d[ée]lai contractuel|approche du d[ée]lai|qui peut reprendre",
        "Alerte SLA tardive par email",
        code,
    )
    exposure, contract_ev, contract_lines = _penalty_exposure(env)
    if ds is not None:
        if ds.has("sla_breached"):
            breached = ds.where(lambda r, i=ds.idx("sla_breached"): is_true(r[i]))
            formula = f"count({ds.column('sla_breached')}=yes) / count(*)"
        else:
            sla, res = ds.numbers("sla_hours"), ds.numbers("resolution_hours")
            breached = [i + 1 for i in range(ds.n) if (res[i] or 0) > (sla[i] or 1e9)]
            formula = "count(résolution > SLA) / count(*)"
        rate = len(breached) / ds.n
        if rate < 0.2:
            return []
        overrun = []
        if ds.has("sla_hours") and ds.has("resolution_hours"):
            sla, res = ds.numbers("sla_hours"), ds.numbers("resolution_hours")
            overrun = [(res[n - 1] or 0) - (sla[n - 1] or 0) for n in breached]
        ev = c.cite_rows(
            ds,
            breached,
            [
                "sla_breached" if ds.has("sla_breached") else "resolution_hours",
                "sla_hours",
                "resolution_hours",
            ],
            f"{len(breached)} {ds.label.lower()} hors délai contractuel",
            code,
        )
        metrics = [
            MetricSpec(
                "breach_rate",
                f"Part des {ds.label.lower()} hors SLA",
                round(rate, 4),
                "ratio",
                f"{formula} = {len(breached)} / {ds.n}",
                evidence=[ev],
            )
        ]
        if overrun:
            metrics.append(
                MetricSpec(
                    "mean_overrun_h",
                    "Dépassement moyen",
                    round(statistics.fmean(overrun), 1),
                    "h",
                    "moyenne(résolution − SLA | hors délai)",
                    evidence=[ev],
                )
            )
        by_source = {}
        if ds.has("planning_source") and ds.has("sla_breached"):
            for name in sorted({v for v in ds.values("planning_source")}):
                rows = ds.where(lambda r, i=ds.idx("planning_source"), name=name: r[i] == name)
                hit = sum(1 for n in rows if is_true(ds.cell(n, "sla_breached")))
                by_source[name] = round(hit / len(rows), 3) if rows else 0
        no_alert = []
        tickets = c.dataset("tickets")
        if tickets and tickets.has("issue"):
            no_alert = tickets.where(lambda r, i=tickets.idx("issue"): bool(re.search(r"sla", r[i], re.I)))
        evidence = [ev, *late_ev, *contract_ev[:2]]
        if no_alert:
            evidence.append(
                c.cite_rows(tickets, no_alert, ["issue"], f"{len(no_alert)} tickets sans alerte SLA", code)
            )
        if exposure:
            metrics.append(
                MetricSpec(
                    "penalty_exposure",
                    "Exposition maximale aux pénalités contractuelles",
                    round(exposure),
                    "MAD/an",
                    " + ".join(contract_lines) or "Σ montant annuel × pénalité",
                    inputs={
                        "hypothese": {
                            "value": "pénalité appliquée chaque mois en cas de non-respect répété",
                            "nature": "hypothese",
                        }
                    },
                    evidence=contract_ev,
                )
            )
        dept, proc = _owner(env, ds)
        return [
            Finding(
                code=code,
                title=f"SLA non tenus et suivis trop tard : {pct(rate, 0)} des {ds.label.lower()} hors délai",
                description=(
                    f"{len(breached)} {ds.label.lower()} sur {ds.n} dépassent le délai contractuel"
                    + (f" (dépassement moyen {n1(statistics.fmean(overrun))} h)" if overrun else "")
                    + ". "
                    + (
                        f"Les dépassements ne sont détectés qu'a posteriori : {late_hits} email(s) d'alerte tardive"
                        + (f", {len(no_alert)} tickets sans alerte SLA" if no_alert else "")
                        + ". "
                        if late_hits or no_alert
                        else ""
                    )
                    + (f"Exposition maximale aux pénalités : {mad(exposure)}/an." if exposure else "")
                ),
                type=T.non_respect_sla,
                **graded(0.35 + 0.5 * min(1, rate / 0.6) + 0.15 * bool(late_hits or no_alert)),
                confidence=0.9,
                department=dept,
                process=proc,
                scope=f"{ds.label} — {ds.document.filename}",
                frequency=f"{len(breached)} sur {ds.n} ({pct(rate, 0)})",
                impact=f"Pénalités potentielles jusqu'à {mad(exposure)}/an" if exposure else None,
                impact_mad_per_year=round(exposure) if exposure else None,
                evidence=evidence,
                metrics=metrics,
                risk=RiskSpec(
                    "Pénalités contractuelles SLA",
                    f"{len(env.ex.contracts)} contrats prévoient des pénalités en cas de non-respect répété.",
                    "contractuel",
                    Cr.critique if rate >= 0.5 else Cr.elevee,
                    min(0.9, rate + 0.2),
                    round(exposure) if exposure else None,
                ),
                signals={
                    "volume": ds.n,
                    "breach_rate": rate,
                    "breached": len(breached),
                    "exposure": exposure,
                    "by_source": by_source,
                    "late_alerts": late_hits,
                },
            )
        ]
    # No per-case SLA data: use contracts + "no SLA alert" tickets + late emails.
    tickets = c.dataset("tickets")
    if not env.ex.contracts or tickets is None:
        return []
    no_alert = (
        tickets.where(lambda r, i=tickets.idx("issue"): bool(re.search(r"sla", r[i], re.I)))
        if tickets.has("issue")
        else []
    )
    if not no_alert and late_hits < 2:
        return []
    slas = sorted(c_.sla_hours for c_ in env.ex.contracts if c_.sla_hours)
    # Tickets are not linked to contracts: compare with the most lenient SLA, a conservative estimate.
    ref = max(slas) if slas else None
    over = []
    if ref is not None and tickets.has("resolution_hours"):
        over = tickets.where(lambda r, i=tickets.idx("resolution_hours"): (to_float(r[i]) or 0) > ref)
    evidence = [*contract_ev[:3], *late_ev]
    if no_alert:
        evidence.insert(
            0, c.cite_rows(tickets, no_alert, ["issue"], f"{len(no_alert)} tickets sans alerte SLA", code)
        )
    metrics = []
    if over:
        ev = c.cite_rows(
            tickets, over, ["resolution_hours"], f"{len(over)} tickets résolus au-delà de {ref:g} h", code
        )
        metrics.append(
            MetricSpec(
                "over_sla_share",
                f"Tickets résolus au-delà du SLA le plus souple ({ref:g} h)",
                round(len(over) / tickets.n, 4),
                "ratio",
                f"{len(over)} / {tickets.n}",
                inputs={"sla_reference_h": {"value": ref, "nature": "hypothese"}},
                evidence=[ev],
            )
        )
        evidence.append(ev)
    if exposure:
        metrics.append(
            MetricSpec(
                "penalty_exposure",
                "Exposition maximale aux pénalités contractuelles",
                round(exposure),
                "MAD/an",
                " + ".join(contract_lines),
                inputs={"hypothese": {"value": "pénalité appliquée chaque mois", "nature": "hypothese"}},
                evidence=contract_ev,
            )
        )
    dept, proc = _owner(env, tickets)
    return [
        Finding(
            code="sla:no_alerting",
            title="Délais contractuels suivis sans alerte : risque de pénalités",
            description=(
                f"{len(env.ex.contracts)} contrats imposent des délais de {', '.join(f'{s:g} h' for s in sorted(set(slas)))} avec pénalités. "
                f"{len(no_alert)} tickets signalent l'absence d'alerte SLA et {late_hits} email(s) montrent des alertes de dernière minute. "
                + (
                    f"{len(over)} tickets sur {tickets.n} sont résolus au-delà du délai contractuel le plus souple ({ref:g} h) — estimation prudente, les tickets n'étant pas rattachés aux contrats."
                    if over
                    else ""
                )
            ),
            type=T.risque_contractuel,
            **graded(
                0.4
                + 0.2 * min(1, len(no_alert) / tickets.n * 4)
                + 0.2 * min(1, late_hits / 3)
                + 0.1 * bool(exposure)
            ),
            confidence=0.65,
            department=dept,
            process=proc,
            scope="Contrats clients et support",
            frequency=f"{late_hits} alertes tardives, {len(no_alert)} tickets sans alerte",
            impact=f"Pénalités potentielles jusqu'à {mad(exposure)}/an" if exposure else None,
            impact_mad_per_year=round(exposure) if exposure else None,
            evidence=evidence,
            metrics=metrics,
            risk=RiskSpec(
                "Pénalités contractuelles SLA",
                "Délais contractuels sans dispositif d'alerte.",
                "contractuel",
                Cr.elevee,
                0.4,
                round(exposure) if exposure else None,
            ),
            signals={
                "volume": tickets.n,
                "no_alert": len(no_alert),
                "late_alerts": late_hits,
                "exposure": exposure,
                "over_sla": len(over),
            },
        )
    ]


def detect_manual_planning(env: Env) -> list[Finding]:
    ds = next((d for d in env.ctx.datasets if d.has("planning_source")), None)
    if ds is None:
        return []
    code = "planning:manual"
    by_tool: dict[str, list[int]] = defaultdict(list)
    for n, v in enumerate(ds.values("planning_source"), start=1):
        tool = canonical_tool(v)
        by_tool[tool[0] if tool else v].append(n)
    informal_tools = {"Excel", "WhatsApp", "Téléphone", "Email", "Formulaire papier"}
    informal = sorted(n for t, rows in by_tool.items() if t in informal_tools for n in rows)
    share = len(informal) / ds.n
    if share < 0.5:
        return []
    c = env.ctx
    evidence = [
        c.cite_rows(
            ds, rows, ["planning_source"], f"{len(rows)} {ds.label.lower()} planifiées via {tool}", code
        )
        for tool, rows in sorted(by_tool.items(), key=lambda kv: -len(kv[1]))
    ]
    breach_txt = ""
    metrics = [
        MetricSpec(
            "informal_share",
            "Part planifiée hors outil de planification",
            round(share, 4),
            "ratio",
            f"{len(informal)} / {ds.n}",
            inputs={k: len(v) for k, v in by_tool.items()},
            evidence=evidence[:1],
        )
    ]
    if ds.has("sla_breached"):
        rates = {}
        for tool, rows in by_tool.items():
            rates[tool] = sum(1 for n in rows if is_true(ds.cell(n, "sla_breached"))) / len(rows)
        ev = c.cite_aggregate(
            ds,
            "Taux de dépassement SLA par canal de planification",
            " ; ".join(f"{t} : {pct(r, 0)}" for t, r in sorted(rates.items(), key=lambda kv: -kv[1])),
            {t: round(r, 3) for t, r in rates.items()},
            ["planning_source", "sla_breached"],
            code,
        )
        evidence.append(ev)
        worst = max(rates, key=rates.get)
        breach_txt = f" Le taux de dépassement SLA atteint {pct(rates[worst], 0)} pour les interventions planifiées via {worst}."
        metrics.append(
            MetricSpec(
                "breach_by_source",
                f"Taux de dépassement SLA ({worst})",
                round(rates[worst], 4),
                "ratio",
                "count(hors SLA) / count(*) par canal",
                inputs={t: round(r, 3) for t, r in rates.items()},
                evidence=[ev],
            )
        )
    profile_ev, hits = corroborate(
        env, r"excel intensif|whatsapp utilis", "Outils déclarés dans le profil", code, limit=1
    )
    dept, proc = _owner(env, ds)
    sites = len(set(ds.values("site"))) if ds.has("site") else None
    return [
        Finding(
            code=code,
            title=f"Planification manuelle : {pct(share, 0)} des {ds.label.lower()} planifiées via {', '.join(t for t in by_tool if t in informal_tools)}",
            description=(
                f"Les {ds.n} {ds.label.lower()} analysées sont planifiées dans {', '.join(f'{t} ({len(r)})' for t, r in by_tool.items())}"
                + (f" sur {sites} sites" if sites else "")
                + ", sans outil de planification ni visibilité partagée."
                + breach_txt
            ),
            type=T.tache_manuelle,
            **graded(0.35 + 0.4 * share + 0.15 * bool(breach_txt) + 0.1 * bool(hits)),
            confidence=0.88,
            department=dept,
            process=proc,
            scope=f"{ds.label} — {ds.document.filename}",
            frequency=f"{len(informal)} {ds.label.lower()} sur {ds.n}",
            evidence=evidence + profile_ev,
            metrics=metrics,
            signals={
                "volume": ds.n,
                "informal_share": share,
                "by_tool": {k: len(v) for k, v in by_tool.items()},
                "sites": sites,
            },
        )
    ]


def detect_urgent_purchases(env: Env) -> list[Finding]:
    ds = env.ctx.dataset("purchases")
    if ds is None or not ds.has("urgent_flag"):
        return []
    code = "procurement:urgent"
    urgent = ds.where(lambda r, i=ds.idx("urgent_flag"): is_true(r[i]))
    share = len(urgent) / ds.n
    if share < 0.2:
        return []
    amounts = ds.numbers("amount")
    premium = ds.numbers("price_premium_pct") if ds.has("price_premium_pct") else [0.0] * ds.n
    normal = [n for n in range(1, ds.n + 1) if n not in set(urgent)]
    mean_urgent = mean(premium[n - 1] for n in urgent) or 0
    mean_normal = mean(premium[n - 1] for n in normal) or 0
    extra = sum((amounts[n - 1] or 0) * (premium[n - 1] or 0) / (100 + (premium[n - 1] or 0)) for n in urgent)
    urgent_amount = sum(amounts[n - 1] or 0 for n in urgent)
    c = env.ctx
    ev = c.cite_rows(
        ds,
        urgent,
        ["urgent_flag", "price_premium_pct", "amount"],
        f"{len(urgent)} achats urgents ({mad(urgent_amount)})",
        code,
    )
    ev_prem = c.cite_aggregate(
        ds,
        f"Surcoût moyen : {n1(mean_urgent)} % en urgence contre {n1(mean_normal)} % sinon",
        f"moyenne(premium | urgent) = {mean_urgent:.1f} % ; moyenne(premium | non urgent) = {mean_normal:.1f} %",
        {"urgent": round(mean_urgent, 2), "normal": round(mean_normal, 2)},
        ["urgent_flag", "price_premium_pct"],
        code,
    )
    items = Counter(ds.cell(n, "item") for n in urgent) if ds.has("item") else Counter()
    dept, proc = _owner(env, ds)
    return [
        Finding(
            code=code,
            title=f"Achats urgents coûteux : {pct(share, 0)} des commandes, surcoût moyen {n1(mean_urgent)} %",
            description=(
                f"{len(urgent)} achats sur {ds.n} sont passés en urgence ({mad(urgent_amount)}), avec un surcoût moyen de {n1(mean_urgent)} % "
                f"contre {n1(mean_normal)} % hors urgence. Surcoût payé sur le périmètre des données : {mad(extra)}. "
                + (
                    f"Articles les plus concernés : {', '.join(f'{k} ({v})' for k, v in items.most_common(3))}. "
                    if items
                    else ""
                )
                + "Les besoins ne semblent pas consolidés ni anticipés."
            ),
            type=T.absence_controle,
            **graded(0.3 + 0.4 * min(1, share / 0.5) + 0.3 * min(1, mean_urgent / 15)),
            confidence=0.88,
            department=dept,
            process=proc,
            scope=f"Achats — {ds.document.filename}",
            frequency=f"{len(urgent)} achats urgents sur {ds.n}",
            impact=f"Surcoût payé sur les données : {mad(extra)}",
            evidence=[ev, ev_prem],
            metrics=[
                MetricSpec(
                    "urgent_share",
                    "Part des achats urgents",
                    round(share, 4),
                    "ratio",
                    f"{len(urgent)} / {ds.n}",
                    evidence=[ev],
                ),
                MetricSpec(
                    "urgent_premium",
                    "Surcoût moyen des achats urgents",
                    round(mean_urgent, 2),
                    "%",
                    "moyenne(premium | urgent)",
                    evidence=[ev_prem],
                ),
                MetricSpec(
                    "extra_cost",
                    "Surcoût payé (données)",
                    round(extra),
                    "MAD",
                    "Σ montant × premium / (100 + premium) | urgent",
                    evidence=[ev],
                ),
            ],
            signals={
                "volume": ds.n,
                "urgent": len(urgent),
                "urgent_amount": urgent_amount,
                "extra_cost": extra,
                "premium_urgent": mean_urgent,
                "premium_normal": mean_normal,
                "total_amount": sum(a or 0 for a in amounts),
            },
        )
    ]


def detect_maintenance(env: Env) -> list[Finding]:
    ds = env.ctx.dataset("maintenance")
    if ds is None:
        return []
    code = "maintenance:knowledge"
    c = env.ctx
    unknown = (
        ds.where(lambda r, i=ds.idx("root_cause_known"): not is_true(r[i]))
        if ds.has("root_cause_known")
        else []
    )
    unstructured = []
    formats = Counter()
    if ds.has("report_format"):
        for n, v in enumerate(ds.values("report_format"), start=1):
            formats[v] += 1
            if re.search(r"free|libre|paper|papier", v, re.I):
                unstructured.append(n)
    pairs: dict[tuple[str, str], list[int]] = defaultdict(list)
    if ds.has("machine") and ds.has("issue"):
        for n, r in enumerate(ds.rows, start=1):
            pairs[(r[ds.idx("machine")], r[ds.idx("issue")])].append(n)
    repeats = {k: v for k, v in pairs.items() if len(v) >= 3}
    downtime = ds.numbers("downtime_hours")
    total_down = sum(d or 0 for d in downtime)
    repeat_rows = sorted(n for rows in repeats.values() for n in rows)
    repeat_down = sum(downtime[n - 1] or 0 for n in repeat_rows)
    unknown_share = len(unknown) / ds.n if ds.n else 0
    if unknown_share < 0.3 and not repeats:
        return []
    evidence = []
    if unknown:
        evidence.append(
            c.cite_rows(
                ds,
                unknown,
                ["machine", "issue", "root_cause_known"],
                f"{len(unknown)} pannes sans cause racine identifiée",
                code,
            )
        )
    if unstructured:
        evidence.append(
            c.cite_rows(
                ds,
                unstructured,
                ["report_format"],
                f"{len(unstructured)} comptes rendus en texte libre ou papier",
                code,
            )
        )
    if repeats:
        top = sorted(repeats.items(), key=lambda kv: -len(kv[1]))[:5]
        evidence.append(
            c.cite_aggregate(
                ds,
                f"{len(repeats)} couples machine/symptôme répétés (≥ 3 fois)",
                " ; ".join(f"{m} / {s} : {len(r)} fois" for (m, s), r in top),
                {f"{m} / {s}": len(r) for (m, s), r in top},
                ["machine", "issue", "downtime_hours"],
                code,
                rows=repeat_rows,
            )
        )
    dept, proc = _owner(env, ds)
    return [
        Finding(
            code=code,
            title=f"Pannes répétitives mal capitalisées : {pct(unknown_share, 0)} sans cause identifiée",
            description=(
                f"{len(unknown)} interventions sur {ds.n} n'ont pas de cause racine identifiée ; {len(unstructured)} comptes rendus sont en texte libre ou "
                f"sur papier ({', '.join(f'{k} {v}' for k, v in formats.most_common())}). {len(repeats)} couples machine/symptôme reviennent au moins "
                f"3 fois et totalisent {n0(repeat_down)} h d'arrêt sur {n0(total_down)} h."
            ),
            type=T.manque_tracabilite,
            **graded(
                0.35
                + 0.35 * unknown_share
                + 0.2 * min(1, len(repeats) / 5)
                + 0.1 * min(1, len(unstructured) / ds.n * 2)
            ),
            confidence=0.88,
            department=dept,
            process=proc,
            scope=f"Maintenance — {ds.document.filename}",
            frequency=f"{ds.n} interventions, {n0(total_down)} h d'arrêt",
            impact=f"{n0(repeat_down)} h d'arrêt sur des pannes répétitives",
            evidence=evidence,
            metrics=[
                MetricSpec(
                    "unknown_cause_share",
                    "Pannes sans cause racine identifiée",
                    round(unknown_share, 4),
                    "ratio",
                    f"{len(unknown)} / {ds.n}",
                    evidence=evidence[:1],
                ),
                MetricSpec(
                    "downtime_total_h",
                    "Heures d'arrêt totales (données)",
                    total_down,
                    "h",
                    "sum(downtime)",
                    nature="fait",
                    evidence=evidence[-1:],
                ),
                MetricSpec(
                    "repeat_downtime_h",
                    "Heures d'arrêt sur pannes répétitives",
                    repeat_down,
                    "h",
                    "sum(downtime | couple répété ≥ 3)",
                    evidence=evidence[-1:],
                ),
            ],
            signals={
                "volume": ds.n,
                "unknown_share": unknown_share,
                "downtime_total": total_down,
                "repeat_downtime": repeat_down,
                "unstructured": len(unstructured),
                "repeats": len(repeats),
            },
        )
    ]


def detect_quality(env: Env) -> list[Finding]:
    ds = env.ctx.dataset("non_conformities")
    if ds is None:
        return []
    code = "quality:recurrence"
    c = env.ctx
    repeat = ds.where(lambda r, i=ds.idx("repeat_flag"): is_true(r[i]))
    share = len(repeat) / ds.n
    if share < 0.2:
        return []
    unknown = ds.where(
        lambda r, i=ds.idx("root_cause"): bool(re.search(r"unknown|inconnu|^$|n/?a", r[i], re.I))
    )
    sources = Counter(ds.values("source_system")) if ds.has("source_system") else Counter()
    types = Counter(ds.values("nc_type")) if ds.has("nc_type") else Counter()
    evidence = [
        c.cite_rows(
            ds,
            repeat,
            ["nc_type", "root_cause", "repeat_flag"],
            f"{len(repeat)} non-conformités répétées sous 90 jours",
            code,
        )
    ]
    if unknown:
        evidence.append(
            c.cite_rows(
                ds, unknown, ["root_cause"], f"{len(unknown)} non-conformités sans cause racine", code
            )
        )
    if len(sources) >= 2:
        evidence.append(
            c.cite_aggregate(
                ds,
                f"Causes documentées dans {len(sources)} supports",
                " ; ".join(f"{k} : {v}" for k, v in sources.most_common()),
                dict(sources),
                ["source_system"],
                code,
            )
        )
    dept, proc = _owner(env, ds)
    return [
        Finding(
            code=code,
            title=f"Non-conformités récurrentes : {pct(share, 0)} se répètent sous 90 jours",
            description=(
                f"{len(repeat)} non-conformités sur {ds.n} se répètent dans les 90 jours. {len(unknown)} n'ont pas de cause racine. "
                f"Les analyses sont dispersées entre {', '.join(f'{k} ({v})' for k, v in sources.most_common())}. "
                + (
                    f"Types dominants : {', '.join(f'{k} ({v})' for k, v in types.most_common(3))}."
                    if types
                    else ""
                )
            ),
            type=T.manque_tracabilite,
            **graded(
                0.35
                + 0.45 * min(1, share / 0.5)
                + 0.1 * (len(sources) >= 3)
                + 0.1 * min(1, len(unknown) / ds.n * 4)
            ),
            confidence=0.88,
            department=dept,
            process=proc,
            scope=f"Qualité — {ds.document.filename}",
            frequency=f"{len(repeat)} récurrences sur {ds.n} non-conformités",
            evidence=evidence,
            metrics=[
                MetricSpec(
                    "repeat_share",
                    "Non-conformités répétées sous 90 jours",
                    round(share, 4),
                    "ratio",
                    f"{len(repeat)} / {ds.n}",
                    evidence=evidence[:1],
                ),
                MetricSpec(
                    "sources",
                    "Supports de documentation des causes",
                    len(sources),
                    "",
                    "count(distinct source)",
                    nature="fait",
                    inputs=dict(sources),
                ),
            ],
            signals={
                "volume": ds.n,
                "repeat": len(repeat),
                "repeat_share": share,
                "unknown": len(unknown),
                "sources": dict(sources),
            },
        )
    ]


def detect_production(env: Env) -> list[Finding]:
    ds = env.ctx.dataset("production")
    if ds is None:
        return []
    out = []
    c = env.ctx
    dept, proc = _owner(env, ds)
    planned, actual = ds.numbers("planned_hours"), ds.numbers("actual_hours")
    tol = bench("overrun_tolerance", env.params)
    overrun_rows = [
        i + 1 for i in range(ds.n) if planned[i] and actual[i] and actual[i] > planned[i] * (1 + tol)
    ]
    total_planned, total_actual = sum(p or 0 for p in planned), sum(a or 0 for a in actual)
    drift = (total_actual - total_planned) / total_planned if total_planned else 0
    replans = ds.numbers("replans") if ds.has("replans") else []
    multi = [i + 1 for i, r in enumerate(replans) if (r or 0) >= 2]
    mean_replans = mean(replans) or 0
    if mean_replans >= 1 or len(overrun_rows) / ds.n >= 0.3:
        code = "production:instability"
        evidence = []
        if multi:
            evidence.append(
                c.cite_rows(ds, multi, ["replans"], f"{len(multi)} ordres replanifiés au moins 2 fois", code)
            )
        evidence.append(
            c.cite_rows(
                ds,
                overrun_rows,
                ["planned_hours", "actual_hours"],
                f"{len(overrun_rows)} ordres dépassent le temps prévu de plus de {pct(tol, 0)}",
                code,
            )
        )
        ev_drift = c.cite_aggregate(
            ds,
            f"Dérive globale des temps : {pct(drift)}",
            f"(Σ réel − Σ prévu) / Σ prévu = ({n0(total_actual)} − {n0(total_planned)}) / {n0(total_planned)}",
            {"planned": total_planned, "actual": total_actual},
            ["planned_hours", "actual_hours"],
            code,
        )
        evidence.append(ev_drift)
        out.append(
            Finding(
                code=code,
                title=f"Planning de production instable : {n1(mean_replans)} replanification(s) par ordre, {pct(len(overrun_rows) / ds.n, 0)} en dépassement",
                description=(
                    f"{len(multi)} ordres de fabrication sur {ds.n} ont été replanifiés au moins deux fois (moyenne {n1(mean_replans)}). "
                    f"{len(overrun_rows)} ordres dépassent le temps prévu de plus de {pct(tol, 0)} ; dérive globale {pct(drift)} "
                    f"({n0(total_actual - total_planned)} h au-delà du prévu)."
                ),
                type=T.delai,
                **graded(
                    0.35 + 0.3 * min(1, mean_replans / 2) + 0.35 * min(1, len(overrun_rows) / ds.n / 0.6)
                ),
                confidence=0.88,
                department=dept,
                process=proc,
                scope=f"Production — {ds.document.filename}",
                frequency=f"{len(multi)} ordres replanifiés ≥ 2 fois sur {ds.n}",
                impact=f"{n0(total_actual - total_planned)} h de production au-delà du prévu sur les données",
                evidence=evidence,
                metrics=[
                    MetricSpec(
                        "mean_replans",
                        "Replanifications moyennes par ordre",
                        round(mean_replans, 2),
                        "",
                        "moyenne(replans)",
                        evidence=evidence[:1],
                    ),
                    MetricSpec(
                        "time_drift",
                        "Dérive des temps réels vs prévus",
                        round(drift, 4),
                        "ratio",
                        "(Σ réel − Σ prévu) / Σ prévu",
                        evidence=[ev_drift],
                    ),
                    MetricSpec(
                        "excess_hours",
                        "Heures au-delà du prévu",
                        round(total_actual - total_planned, 1),
                        "h",
                        "Σ réel − Σ prévu",
                        evidence=[ev_drift],
                    ),
                ],
                signals={
                    "volume": ds.n,
                    "mean_replans": mean_replans,
                    "overrun": len(overrun_rows),
                    "excess_hours": total_actual - total_planned,
                    "planned_hours": total_planned,
                    "drift": drift,
                },
            )
        )
    if ds.has("waste_pct"):
        code = "production:material_waste"
        target = bench("waste_target_pct", env.params)
        waste = ds.numbers("waste_pct")
        avg = mean(waste) or 0
        above = [i + 1 for i, w in enumerate(waste) if (w or 0) > target]
        if avg > target:
            by_group = {}
            group_concept = "line" if ds.has("line") else "segment" if ds.has("segment") else None
            if group_concept:
                groups: dict[str, list[float]] = defaultdict(list)
                for r, w in zip(ds.values(group_concept), waste, strict=False):
                    groups[r].append(w or 0)
                by_group = {g: round(statistics.fmean(v), 2) for g, v in groups.items()}
            ev = c.cite_rows(
                ds,
                above,
                ["waste_pct"],
                f"{len(above)} ordres au-dessus du rebut cible de {n1(target)} %",
                code,
            )
            ev_avg = c.cite_aggregate(
                ds,
                f"Rebut moyen : {n1(avg)} %",
                f"moyenne({ds.column('waste_pct')}) = {avg:.2f} %"
                + (" ; " + " ; ".join(f"{g} : {v} %" for g, v in by_group.items()) if by_group else ""),
                {"mean": round(avg, 2), **by_group},
                ["waste_pct"],
                code,
            )
            report_ev, hits = corroborate(
                env, r"mati[eè]re|rebut|[ée]cart", "Mention d'écarts matière", code, limit=2
            )
            out.append(
                Finding(
                    code=code,
                    title=f"Consommation matière mal expliquée : rebut moyen {n1(avg)} % (cible {n1(target)} %)",
                    description=(
                        f"Le taux de rebut matière moyen est de {n1(avg)} % sur {ds.n} ordres ; {len(above)} ordres dépassent la cible de {n1(target)} % "
                        "(benchmark à valider). Aucune analyse des écarts théorique/réel n'apparaît dans les sources : l'analyse est faite a posteriori."
                        + (
                            f" Écarts par {group_concept} : {', '.join(f'{g} {v} %' for g, v in by_group.items())}."
                            if by_group
                            else ""
                        )
                    ),
                    type=T.absence_controle,
                    **graded(0.35 + 0.45 * min(1, (avg - target) / target) + 0.2 * min(1, len(above) / ds.n)),
                    confidence=0.75,
                    department=dept,
                    process=proc,
                    scope=f"Production — {ds.document.filename}",
                    frequency=f"{len(above)} ordres sur {ds.n} au-dessus de la cible",
                    impact=f"{n1(avg - target)} point(s) de rebut au-dessus de la cible",
                    evidence=[ev, ev_avg, *report_ev],
                    metrics=[
                        MetricSpec(
                            "waste_mean",
                            "Taux de rebut matière moyen",
                            round(avg, 2),
                            "%",
                            "moyenne(rebut)",
                            evidence=[ev_avg],
                        ),
                        MetricSpec(
                            "waste_excess_pts",
                            "Écart à la cible",
                            round(avg - target, 2),
                            "pts",
                            f"{avg:.2f} − {target:g}",
                            inputs={"cible": {"value": target, "nature": "hypothese"}},
                            evidence=[ev_avg],
                        ),
                    ],
                    signals={
                        "volume": ds.n,
                        "waste_mean": avg,
                        "waste_target": target,
                        "above": len(above),
                        "by_group": by_group,
                    },
                )
            )
    return out


# --------------------------------------------------------------------------------------------------
# Document-based detectors
# --------------------------------------------------------------------------------------------------


def detect_reporting(env: Env) -> list[Finding]:
    c = env.ctx
    code = "reporting:manual"
    reports = c.grep(
        r"correction(s)? manuelle|rapprochement|pas disponibles au moment de la cl[oô]ture|retraitement",
        ["reporting"],
    )
    mismatch = c.grep(r"ne correspond pas|chiffre [àa] corriger|[ée]cart avec l.erp", None)
    mismatch = [(t, ln) for t, ln in mismatch if t.document.category != "reporting"]
    procs = [
        p
        for p in env.ex.processes
        if p.steps
        and re.search(r"cl[oô]ture|kpi|reporting", p.name, re.I)
        and any(s.is_reentry for s in p.steps)
    ]
    deadlines = [ct for ct in env.ex.contracts if ct.reporting_day]
    signal_types = sum(bool(x) for x in (reports, mismatch, procs))
    if signal_types < 2:
        return []
    evidence = [
        c.cite_lines(t, ln, "Rapport mensuel : corrections manuelles au rapprochement", code, relevance=0.75)
        for t, ln in reports[:2]
    ]
    evidence += [
        c.cite_lines(t, ln, "Email : écart entre reporting et ERP", code, relevance=0.75)
        for t, ln in mismatch[:3]
    ]
    for p in procs[:2]:
        step = next(s for s in p.steps if s.is_reentry)
        evidence.append(
            c.cite_lines(
                p.document, [step.line], f"Procédure « {p.name} » : {step.label}", code, relevance=0.65
            )
        )
    if deadlines:
        d = deadlines[0]
        evidence.append(
            c.cite_lines(
                d.doc,
                [d.reporting_line],
                f"{len(deadlines)} contrat(s) exigent un reporting avant le {d.reporting_day} du mois",
                code,
                relevance=0.6,
            )
        )
    total_reports = len(c.docs_by_category("reporting"))
    dept, proc = _owner(env, name="Reporting de direction")
    return [
        Finding(
            code=code,
            title="Reporting mensuel manuel, avec des écarts récurrents vs l'ERP",
            description=(
                f"{len(reports)} rapport(s) mensuel(s) sur {total_reports} mentionnent des corrections manuelles lors du rapprochement avec l'ERP"
                + (
                    f", {len(mismatch)} email(s) signalent des chiffres à corriger dans l'urgence"
                    if mismatch
                    else ""
                )
                + (f", et {len(procs)} procédure(s) de clôture imposent une ressaisie Excel" if procs else "")
                + "."
                + (
                    f" {len(deadlines)} contrat(s) exigent pourtant un reporting avant le {deadlines[0].reporting_day} du mois."
                    if deadlines
                    else ""
                )
                + " La durée de production du reporting n'est pas mesurée dans les sources (à confirmer en entretien)."
            ),
            type=T.reporting_tardif,
            **graded(0.3 + 0.15 * signal_types + 0.15 * min(1, len(mismatch) / 3) + 0.1 * bool(deadlines)),
            confidence=round(min(0.85, 0.55 + 0.1 * signal_types + 0.05 * min(2, len(mismatch))), 2),
            department=dept,
            process=proc,
            scope="Reporting de direction et clôture",
            frequency=f"{len(reports)}/{total_reports} rapports concernés, {len(mismatch)} email(s) d'écart",
            evidence=evidence,
            metrics=[
                MetricSpec(
                    "reports_with_corrections",
                    "Rapports mentionnant des corrections manuelles",
                    len(reports),
                    "",
                    "count(rapports | corrections)",
                    nature="fait",
                    evidence=evidence[:1],
                ),
                MetricSpec(
                    "mismatch_emails",
                    "Emails d'écart reporting / ERP",
                    len(mismatch),
                    "",
                    "count(emails | écart)",
                    nature="fait",
                ),
            ],
            signals={
                "reports": len(reports),
                "total_reports": total_reports,
                "mismatch_emails": len(mismatch),
                "deadline_day": deadlines[0].reporting_day if deadlines else None,
            },
        )
    ]


def detect_field_reports(env: Env) -> list[Finding]:
    c = env.ctx
    code = "operations:field_reports"
    hits = [
        (t, ln)
        for t, ln in c.grep(r"compte[- ]rendu|rapport d.intervention")
        if re.search(r"whatsapp|pas encore|manqu|n.avons pas", " ".join(t.lines), re.I)
    ]
    if len(hits) < 2:
        return []
    evidence = [
        c.cite_lines(t, ln, "Compte rendu d'intervention manquant ou reçu par WhatsApp", code)
        for t, ln in hits[:3]
    ]
    ds = next((d for d in c.datasets if d.has("planning_source")), None)
    wa = []
    if ds:
        wa = ds.where(
            lambda r, i=ds.idx("planning_source"): (
                canonical_tool(r[i]) == ("WhatsApp", "messagerie instantanée")
            )
        )
        if wa:
            evidence.append(
                c.cite_rows(
                    ds, wa, ["planning_source"], f"{len(wa)} interventions coordonnées par WhatsApp", code
                )
            )
    dept, proc = _owner(env, ds) if ds else (None, None)
    return [
        Finding(
            code=code,
            title="Comptes rendus terrain non structurés (WhatsApp, transmission tardive)",
            description=(
                f"{len(hits)} échanges montrent des interventions terminées sans compte rendu, l'information arrivant par WhatsApp"
                + (f" ; {len(wa)} interventions sont coordonnées via WhatsApp" if wa else "")
                + ". Photos, notes et validations client ne sont "
                "ni structurées ni rattachées à l'intervention."
            ),
            type=T.manque_tracabilite,
            **graded(0.4 + 0.3 * min(1, len(hits) / 4) + 0.2 * bool(wa)),
            confidence=round(0.6 + 0.05 * min(4, len(hits)) + 0.1 * bool(wa), 2),
            department=dept,
            process=proc,
            scope="Interventions terrain",
            frequency=f"{len(hits)} échanges concernés"
            + (f", {len(wa)} interventions via WhatsApp" if wa else ""),
            evidence=evidence,
            metrics=[
                MetricSpec(
                    "missing_report_emails",
                    "Échanges signalant un compte rendu manquant",
                    len(hits),
                    "",
                    "count(emails)",
                    nature="fait",
                )
            ],
            signals={"emails": len(hits), "whatsapp_interventions": len(wa), "volume": ds.n if ds else None},
        )
    ]


def detect_invoicing_delay(env: Env) -> list[Finding]:
    c = env.ctx
    field = next((d for d in c.datasets if d.kind == "interventions"), None)
    receivables = c.dataset("receivables")
    reports = [
        (t, ln)
        for t, ln in c.grep(r"compte[- ]rendu")
        if re.search(r"pas encore|manqu|n.avons pas", " ".join(t.lines), re.I)
    ]
    if field is None or receivables is None or len(reports) < 2:
        return []
    code = "finance:invoicing_delay"
    evidence = [
        c.cite_lines(t, ln, "Intervention terminée sans justificatif transmis", code) for t, ln in reports[:2]
    ]
    copies, _ = corroborate(
        env,
        r"copie de la facture|dernier [ée]change",
        "Client réclamant une facture / échange introuvable",
        code,
        limit=1,
    )
    clauses, _ = corroborate(
        env,
        r"justificatifs? doivent",
        "Clause contractuelle : justificatifs à fournir",
        code,
        limit=1,
        categories=("contrats",),
    )
    manual = []
    if receivables.has("source_system"):
        manual = receivables.where(
            lambda r, i=receivables.idx("source_system"): (
                (canonical_tool(r[i]) or ("",))[0] in ("Email", "Excel")
            )
        )
        if manual:
            evidence.append(
                c.cite_rows(
                    receivables,
                    manual,
                    ["source_system"],
                    f"{len(manual)} factures établies hors ERP (Email/Excel)",
                    code,
                )
            )
    dept, proc = _owner(env, receivables)
    return [
        Finding(
            code=code,
            title="Facturation retardée : justificatifs d'intervention transmis tardivement à la finance",
            description=(
                f"Les comptes rendus d'intervention arrivent tardivement ({len(reports)} échanges), alors que les contrats exigent des justificatifs. "
                + (
                    f"{len(manual)} factures sur {receivables.n} sont établies hors ERP (email ou Excel). "
                    if manual
                    else ""
                )
                + "Le délai entre fin d'intervention et facturation n'est pas mesuré dans les sources : à quantifier en entretien."
            ),
            type=T.delai,
            **graded(0.45 + 0.2 * min(1, len(reports) / 4) + 0.15 * bool(manual) + 0.1 * bool(clauses)),
            confidence=0.65,
            department=dept,
            process=proc,
            scope="Interventions → facturation",
            frequency=f"{len(reports)} interventions sans justificatif signalées",
            evidence=evidence + copies + clauses,
            metrics=[
                MetricSpec(
                    "manual_invoices_share",
                    "Factures établies hors ERP",
                    round(len(manual) / receivables.n, 4) if manual else 0,
                    "ratio",
                    f"{len(manual)} / {receivables.n}",
                    evidence=evidence[-1:] if manual else [],
                )
            ],
            signals={
                "reports": len(reports),
                "manual_invoices": len(manual),
                "invoices": receivables.n,
                "invoices_per_month": round(receivables.n / (period_months(receivables) or 12), 1),
                "revenue": env.ctx.mission.organization.revenue_mad,
            },
        )
    ]


def detect_procedures(env: Env) -> list[Finding]:
    procs = [p for p in env.ex.processes if p.origin == "procedure"]
    if not procs:
        return []
    code = "governance:procedures"
    c = env.ctx
    max_age = bench("procedure_max_age_months", env.params)
    no_owner = [p for p in procs if not p.owner_defined]
    stale = [p for p in procs if p.updated and (env.ref_date - p.updated).days / 30.44 > max_age]
    email_exceptions = [
        p for p in procs if any(re.search(r"exception.*email|par email", v, re.I) for v, _ in p.vigilance)
    ]
    manual_controls = [
        p
        for p in procs
        if any(re.search(r"v[ée]rification manuelle|contr[oô]les? .*manuel", v, re.I) for v, _ in p.vigilance)
    ]
    if len(no_owner) < 2 and len(stale) < 2:
        return []
    evidence = []
    for p in no_owner[:2]:
        line = next(ln for v, ln in p.vigilance if re.search(r"propri", v, re.I))
        evidence.append(
            c.cite_lines(p.document, [line], f"« {p.name} » : propriétaire non précisé", code, relevance=0.6)
        )
    for p in stale[:3]:
        evidence.append(
            c.cite_document(
                p.document.document,
                f"« {p.name} » mise à jour le {p.updated.isoformat()}",
                code,
                {"updated": p.updated.isoformat()},
            )
        )
    for p in manual_controls[:1]:
        line = next(ln for v, ln in p.vigilance if re.search(r"manuel", v, re.I))
        evidence.append(
            c.cite_lines(p.document, [line], f"« {p.name} » : contrôles manuels", code, relevance=0.5)
        )
    return [
        Finding(
            code=code,
            title=f"Procédures incomplètes : {len(no_owner)} sans propriétaire, {len(stale)} non revues depuis plus de {n0(max_age)} mois",
            description=(
                f"Sur {len(procs)} procédures documentées, {len(no_owner)} ne précisent pas le propriétaire de chaque étape, {len(stale)} n'ont pas été "
                f"revues depuis plus de {n0(max_age)} mois (référence {env.ref_date.isoformat()}), {len(email_exceptions)} traitent les exceptions par email "
                f"et {len(manual_controls)} reposent sur des contrôles manuels."
            ),
            type=T.absence_controle,
            **graded(
                0.3 + 0.2 * min(1, len(no_owner) / len(procs)) + 0.2 * min(1, len(stale) / len(procs) * 2)
            ),
            confidence=0.8,
            department=None,
            process=None,
            scope=f"{len(procs)} procédures documentées",
            frequency=f"{len(no_owner)}/{len(procs)} sans propriétaire, {len(stale)}/{len(procs)} obsolètes",
            evidence=evidence,
            metrics=[
                MetricSpec(
                    "no_owner",
                    "Procédures sans propriétaire défini",
                    len(no_owner),
                    "",
                    "count",
                    nature="fait",
                ),
                MetricSpec(
                    "stale",
                    f"Procédures non revues depuis {n0(max_age)} mois",
                    len(stale),
                    "",
                    f"count(mise à jour < {env.ref_date.isoformat()} − {n0(max_age)} mois)",
                    inputs={"anciennete_max_mois": {"value": max_age, "nature": "hypothese"}},
                ),
            ],
            signals={"procedures": len(procs), "no_owner": len(no_owner), "stale": len(stale)},
        )
    ]


def detect_forecast_gap(env: Env) -> list[Finding]:
    """Production instability without any forecast data in the sources: flagged as a hypothesis."""
    ds = env.ctx.dataset("production")
    if ds is None or not ds.has("replans"):
        return []
    has_forecast_data = any(
        re.search(r"forecast|prevision", d.table.name + " ".join(d.table.columns), re.I)
        for d in env.ctx.datasets
    )
    mentions = env.ctx.grep(r"pr[ée]vision")
    if has_forecast_data:
        return []
    code = "sales:forecast_gap"
    replans = ds.numbers("replans")
    multi = [i + 1 for i, r in enumerate(replans) if (r or 0) >= 2]
    ev = env.ctx.cite_aggregate(
        ds,
        f"{len(multi)} ordres replanifiés au moins 2 fois",
        f"count(replans ≥ 2) = {len(multi)} / {ds.n}",
        {"replanned": len(multi)},
        ["replans"],
        code,
        rows=multi,
        relevance=0.5,
    )
    dept = next((d for d in env.ex.org.departments if re.search(r"commerc|vente", d, re.I)), None)
    return [
        Finding(
            code=code,
            title="Visibilité commerciale insuffisante sur la charge (hypothèse à valider)",
            description=(
                f"Aucune donnée de prévision commerciale n'a été fournie parmi les {len(env.ctx.datasets)} jeux de données"
                + (f" ({len(mentions)} mention(s) textuelle(s) seulement)" if mentions else "")
                + f", alors que {len(multi)} ordres de fabrication sur {ds.n} sont replanifiés au moins deux fois. L'hypothèse d'un partage tardif "
                "des prévisions par les ventes est à confirmer en entretien avec le commerce et la production."
            ),
            type=T.rupture_flux,
            criticality=Cr.moyenne,
            confidence=0.35,
            department=dept,
            process="Ordonnancement & production",
            scope="Commerce → production",
            frequency="non mesurable dans les sources",
            is_hypothesis=True,
            evidence=[ev],
            metrics=[],
            signals={"replanned": len(multi), "volume": ds.n},
        )
    ]


DETECTORS: list[Callable[[Env], list[Finding]]] = [
    detect_manual_entry,
    detect_lost_quotes,
    detect_receivables,
    detect_dormant_stock,
    detect_support_dispersion,
    detect_sla,
    detect_manual_planning,
    detect_field_reports,
    detect_invoicing_delay,
    detect_urgent_purchases,
    detect_maintenance,
    detect_quality,
    detect_production,
    detect_forecast_gap,
    detect_reporting,
    detect_procedures,
]


_RANK = {Cr.critique: 3, Cr.elevee: 2, Cr.moyenne: 1, Cr.faible: 0}
_SCORE_OF = {Cr.critique: 0.9, Cr.elevee: 0.7, Cr.moyenne: 0.5, Cr.faible: 0.3}
CRITICAL_SHARE = 0.35


def calibrate(findings: list[Finding]) -> list[Finding]:
    """Weigh severity by confidence, then keep "critique" for the top of the mission only.

    Detectors grade in isolation; on a data-rich mission many would claim "critique", which would
    make the label useless for prioritising. At most ~35 % of the findings stay critical.
    """
    for f in findings:
        base = f.severity or _SCORE_OF[Cr(f.criticality)]
        f.severity = round(base * (0.6 + 0.4 * f.confidence), 3)
    ranked = sorted(findings, key=lambda f: (-_RANK[Cr(f.criticality)], -f.severity))
    budget = max(1, round(CRITICAL_SHARE * len(findings)))
    for f in ranked:
        if f.criticality == Cr.critique:
            if budget > 0 and not f.is_hypothesis:
                budget -= 1
            else:
                f.criticality = Cr.elevee
    return findings


def run_detectors(ctx: AnalysisContext, ex: Extraction) -> list[Finding]:
    env = Env(ctx, ex, dict(ctx.mission.parameters or {}), reference_date(ctx))
    findings: list[Finding] = []
    for detector in DETECTORS:
        findings.extend(detector(env))
    return calibrate(findings)


__all__ = ["BENCHMARKS", "DETECTORS", "Finding", "MetricSpec", "RiskSpec", "run_detectors"]
