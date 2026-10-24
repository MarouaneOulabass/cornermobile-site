"""Operational maturity and data completeness (screen 3). Every score lists the inputs it uses."""

from __future__ import annotations

from collections import Counter

from app.engine.context import AnalysisContext
from app.engine.detectors import Env, Finding, period_months
from app.engine.extract import Extraction

EXPECTED_CATEGORIES = {
    "finance": "Données financières (factures, encaissements)",
    "ventes": "Données commerciales (devis, commandes)",
    "operations": "Données opérationnelles (interventions, production, stock)",
    "rh": "Organisation (effectifs, organigramme)",
    "contrats": "Contrats clients",
    "procedures": "Procédures",
    "reporting": "Reporting de direction",
    "support": "Support / réclamations",
}


def _metric(findings: list[Finding], code_prefix: str, key: str) -> float | None:
    for f in findings:
        if f.code.startswith(code_prefix):
            for m in f.metrics:
                if m.key == key:
                    return float(m.value)
    return None


def _score(key: str, label: str, parts: list[tuple[str, float]], fallback: float = 0.5) -> dict:
    if not parts:
        return {
            "key": key,
            "label": label,
            "value": fallback,
            "inputs": [],
            "explanation": "Pas assez de données : valeur par défaut.",
        }
    value = sum(v for _, v in parts) / len(parts)
    return {
        "key": key,
        "label": label,
        "value": round(max(0.0, min(1.0, value)), 3),
        "inputs": [{"label": name, "value": round(v, 3)} for name, v in parts],
        "explanation": "Moyenne de : " + " ; ".join(f"{name} ({v:.0%})" for name, v in parts),
    }


def compute_insights(ctx: AnalysisContext, ex: Extraction, env: Env, findings: list[Finding]) -> dict:
    procs = [p for p in ex.processes if p.origin == "procedure"]
    all_procs = ex.processes
    structured = []
    if all_procs:
        structured.append(
            (
                "Processus avec propriétaire défini",
                sum(
                    1
                    for p in all_procs
                    if p.owner_defined and (p.owner_department or p.origin == "procedure")
                )
                / len(all_procs),
            )
        )
    if procs:
        stale = next(
            (
                m.value
                for f in findings
                if f.code == "governance:procedures"
                for m in f.metrics
                if m.key == "stale"
            ),
            0,
        )
        structured.append(("Procédures à jour", 1 - stale / len(procs)))

    data = []
    docs_total = len(ctx.texts) + len({d.document.id for d in ctx.datasets})
    if docs_total:
        data.append(("Sources exploitables (indexées)", 1.0))
    if ctx.datasets:
        data.append(("Jeux de données reconnus", sum(1 for d in ctx.datasets if d.kind) / len(ctx.datasets)))
        dated = [d for d in ctx.datasets if d.kind not in (None, "employees", "org_chart", "inventory")]
        if dated:
            data.append(
                ("Données datées (période connue)", sum(1 for d in dated if period_months(d)) / len(dated))
            )
    for f in findings:
        if f.code == "finance:receivables" and f.signals.get("systems", 0) >= 2:
            erp = next((m.inputs.get("ERP", 0) for m in f.metrics if m.key == "systems"), 0)
            total = sum(next((m.inputs for m in f.metrics if m.key == "systems"), {}).values()) or 1
            data.append(("Factures saisies dans l'ERP", erp / total))

    manual = []
    for prefix, key, label in (
        ("manual_entry:", "manual_rate", "Enregistrements ressaisis"),
        ("planning:manual", "informal_share", "Planification hors outil"),
        ("procurement:urgent", "urgent_share", "Achats en urgence"),
    ):
        v = _metric(findings, prefix, key)
        if v is not None:
            manual.append((f"{label} (inversé)", 1 - v))
    if procs:
        manual.append(
            (
                "Procédures sans ressaisie (inversé)",
                1 - sum(1 for p in procs if any(s.is_reentry for s in p.steps)) / len(procs),
            )
        )
    tickets = ctx.dataset("tickets")
    if tickets and tickets.has("channel"):
        informal = sum(
            1
            for v in tickets.values("channel")
            if v.strip().lower() in ("whatsapp", "phone", "téléphone", "telephone")
        )
        manual.append(("Demandes reçues par canaux informels (inversé)", 1 - informal / tickets.n))

    trace = []
    for prefix, key, label in (
        ("support:dispersion", "missing_history_share", "Tickets avec historique manquant"),
        ("maintenance:knowledge", "unknown_cause_share", "Pannes sans cause identifiée"),
        ("quality:recurrence", "repeat_share", "Non-conformités récurrentes"),
    ):
        v = _metric(findings, prefix, key)
        if v is not None:
            trace.append((f"{label} (inversé)", 1 - v))
    if procs:
        trace.append(("Procédures avec propriétaire", sum(1 for p in procs if p.owner_defined) / len(procs)))
    planning = _metric(findings, "planning:manual", "informal_share")
    if planning is not None:
        trace.append(("Interventions planifiées dans un outil traçable", 1 - planning))

    categories = Counter(t.document.category for t in ctx.texts) + Counter(
        d.document.category for d in ctx.datasets
    )
    present = {k: v for k, v in EXPECTED_CATEGORIES.items() if categories.get(k)}
    missing = [v for k, v in EXPECTED_CATEGORIES.items() if k not in present]
    undated = [
        d.document.filename
        for d in ctx.datasets
        if d.kind not in (None, "employees", "org_chart", "inventory") and not period_months(d)
    ]
    gaps = [f"Catégorie absente : {m}" for m in missing]
    if undated:
        gaps.append(
            f"Période non précisée pour {len(undated)} fichier(s) ({', '.join(undated)}) : volumes mensuels en hypothèse"
        )
    gaps += [f"Hypothèse à valider : {f.title}" for f in findings if f.is_hypothesis]
    return {
        "maturity": [
            _score("processus", "Processus structurés", structured),
            _score("donnees", "Données exploitables", data),
            _score("automatisation", "Automatisation", manual),
            _score("tracabilite", "Traçabilité", trace),
        ],
        "completeness": {
            "score": round(len(present) / len(EXPECTED_CATEGORIES), 3),
            "present": list(present.values()),
            "missing": missing,
            "gaps": gaps,
            "datasets": len(ctx.datasets),
            "documents": len(ctx.texts),
            "reference_date": env.ref_date.isoformat(),
        },
    }
