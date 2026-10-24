"""Grading of one analyzed mission (spec §14 metrics)."""

from __future__ import annotations

import csv
import itertools
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.domain.enums import ValidationStatus
from app.engine import benchmarks
from app.engine.scoring import priority
from app.models import (
    AuditMission,
    Document,
    Evidence,
    EvidenceLink,
    Metric,
    Opportunity,
    PainPoint,
    Recommendation,
)
from app.services.business_case import scoring_model, values_of
from evals.anchors import ANCHORS
from evals.ground_truth import GroundTruth
from evals.text import assign, numbers, similarity, stems, strip_accents

ISSUE_THRESHOLD = 0.30
OPPORTUNITY_THRESHOLD = 0.30


@dataclass
class Snapshot:
    """What the engine produced, loaded once."""

    mission: AuditMission
    pains: list[PainPoint]
    opps: list[Opportunity]
    metrics: list[Metric]
    recs: list[Recommendation]
    docs: dict[uuid.UUID, Document]
    evidence: dict[uuid.UUID, Evidence]
    links: dict[tuple[str, uuid.UUID], list[Evidence]]

    @classmethod
    def load(cls, db: Session, mission: AuditMission) -> Snapshot:
        mid = mission.id
        live = ValidationStatus.rejete
        evidence = {e.id: e for e in db.scalars(select(Evidence).where(Evidence.mission_id == mid))}
        links: dict[tuple[str, uuid.UUID], list[Evidence]] = {}
        for link in db.scalars(select(EvidenceLink).where(EvidenceLink.mission_id == mid)):
            if link.evidence_id in evidence:
                links.setdefault((link.target_type, link.target_id), []).append(evidence[link.evidence_id])
        return cls(
            mission=mission,
            pains=list(
                db.scalars(
                    select(PainPoint).where(PainPoint.mission_id == mid, PainPoint.validation_status != live)
                )
            ),
            opps=list(
                db.scalars(
                    select(Opportunity).where(
                        Opportunity.mission_id == mid, Opportunity.validation_status != live
                    )
                )
            ),
            metrics=list(db.scalars(select(Metric).where(Metric.mission_id == mid))),
            recs=list(
                db.scalars(
                    select(Recommendation).where(
                        Recommendation.mission_id == mid, Recommendation.validation_status != live
                    )
                )
            ),
            docs={d.id: d for d in db.scalars(select(Document).where(Document.mission_id == mid))},
            evidence=evidence,
            links=links,
        )

    def ev(self, target_type: str, target_id: uuid.UUID) -> list[Evidence]:
        return self.links.get((target_type, target_id), [])


# --- 1. Recall / precision of pain points ------------------------------------------------------------


def pain_text(p: PainPoint) -> str:
    return f"{p.title} {p.description} {p.department or ''} {p.type}"


def grade_issues(snap: Snapshot, gt: GroundTruth, verified: set[uuid.UUID]) -> dict:
    scores = {
        (i, j): similarity(issue.title, issue.description, pain_text(p), issue.domain)
        for i, issue in enumerate(gt.issues)
        for j, p in enumerate(snap.pains)
    }
    matches = assign(scores, ISSUE_THRESHOLD)
    rows = []
    for i, issue in enumerate(gt.issues):
        hit = matches.get(i)
        pain = snap.pains[hit[0]] if hit else None
        rows.append(
            {
                "planted": issue.title,
                "severity": issue.severity,
                "matched": pain.title if pain else None,
                "score": hit[1] if hit else max((s for (a, _), s in scores.items() if a == i), default=0),
                "hypothesis": bool(pain and pain.is_hypothesis),
                "criticality": pain.criticality if pain else None,
                "evidence": len(snap.ev("pain_point", pain.id)) if pain else 0,
            }
        )
    matched_pains = {snap.pains[j].id for j, _ in matches.values()}
    supported = [
        p for p in snap.pains if p.is_hypothesis or any(e.id in verified for e in snap.ev("pain_point", p.id))
    ]
    extras = [
        {
            "title": p.title,
            "evidence": len(snap.ev("pain_point", p.id)),
            "files": sorted(
                {
                    snap.docs[e.document_id].path
                    for e in snap.ev("pain_point", p.id)
                    if e.document_id in snap.docs
                }
            )[:4],
        }
        for p in snap.pains
        if p.id not in matched_pains
    ]
    n = len(snap.pains) or 1
    return {
        "recall": round(len(matches) / len(gt.issues), 3),
        "recall_direct": round(
            sum(1 for r in rows if r["matched"] and not r["hypothesis"]) / len(gt.issues), 3
        ),
        "precision_strict": round(len(matched_pains) / n, 3),
        "precision_supported": round(len(supported) / n, 3),
        "pain_points": len(snap.pains),
        "matches": rows,
        "extras": extras,
    }


# --- 2. Evidence fidelity and relevance -----------------------------------------------------------------


class RawFiles:
    """Original files as delivered, read independently of the ingestion pipeline."""

    def __init__(self, folder: Path):
        self.folder = folder
        self._csv: dict[str, tuple[list[str], list[list[str]]]] = {}
        self._text: dict[str, list[str]] = {}

    def table(self, path: str) -> tuple[list[str], list[list[str]]]:
        if path not in self._csv:
            with (self.folder / path).open(encoding="utf-8-sig", newline="") as fh:
                data = list(csv.reader(fh))
            self._csv[path] = (data[0], data[1:])
        return self._csv[path]

    def lines(self, path: str) -> list[str]:
        if path not in self._text:
            self._text[path] = (self.folder / path).read_text(encoding="utf-8-sig").splitlines()
        return self._text[path]


def check_evidence(ev: Evidence, doc: Document | None, raw: RawFiles) -> str | None:
    """None when the citation is verifiable in the original file, else the reason it is not."""
    if doc is None:
        return "document absent"
    if Path(doc.path).name in ("ground_truth.json", "manifest.json"):
        return "cite le corrigé du kit"
    if not (raw.folder / doc.path).exists():
        return "fichier introuvable"
    loc = ev.locator or {}
    if ev.kind in ("rows", "aggregate"):
        header, data = raw.table(doc.path)
        missing = [c for c in loc.get("columns", []) if c not in header]
        if missing:
            return f"colonnes inconnues {missing}"
        if any(not 1 <= n <= len(data) for n in loc.get("rows", [])):
            return "ligne hors du fichier"
        if ev.kind == "rows":
            for line in filter(None, ev.excerpt.splitlines()):
                head, _, pairs = line.partition(" : ")
                n = int(head.removeprefix("ligne "))
                for pair in pairs.split(", "):
                    col, _, value = pair.partition("=")
                    if data[n - 1][header.index(col)] != value:
                        return f"valeur différente ligne {n} ({col})"
    elif ev.kind == "excerpt":
        lo, hi = loc.get("lines", [0, 0])
        source = raw.lines(doc.path)
        if not 1 <= lo <= hi <= len(source):
            return "lignes hors du fichier"
        cited = [s.strip() for s in ev.excerpt.splitlines()]
        if cited != [s.strip() for s in source[lo - 1 : hi]]:
            return "extrait différent du fichier"
    return None


def grade_evidence(snap: Snapshot, raw: RawFiles) -> tuple[dict, set[uuid.UUID]]:
    linked = {e.id: e for evs in snap.links.values() for e in evs}
    failures, verified = [], set()
    for ev in linked.values():
        reason = check_evidence(ev, snap.docs.get(ev.document_id), raw)
        if reason:
            failures.append({"summary": ev.summary, "reason": reason})
        else:
            verified.add(ev.id)
    # Relevance: evidence attached to a pain point talks about the same thing (shared content words).
    on_topic = total = 0
    off = []
    for p in snap.pains:
        topic = stems(f"{p.title} {p.description}")
        for ev in snap.ev("pain_point", p.id):
            total += 1
            if topic & stems(f"{ev.summary} {ev.excerpt}"):
                on_topic += 1
            else:
                off.append({"pain_point": p.title, "evidence": ev.summary})
    return {
        "evidence": len(linked),
        "fidelity": round(len(verified) / (len(linked) or 1), 3),
        "relevance": round(on_topic / (total or 1), 3),
        "failures": failures[:10],
        "off_topic": off[:10],
    }, verified


# --- 3. Calculation accuracy ---------------------------------------------------------------------------


def _norm(text: str) -> str:
    return strip_accents(text.lower()).replace("’", "'")


def grade_anchors(snap: Snapshot, slug: str, folder: Path) -> dict:
    rows = []
    for anchor in ANCHORS.get(slug, []):
        reference = anchor.compute(folder)
        found = [m for m in snap.metrics if _norm(anchor.label) in _norm(m.label)]
        if not found:
            rows.append(
                {
                    "label": anchor.label,
                    "reference": reference,
                    "engine": None,
                    "ok": False,
                    "how": anchor.description,
                }
            )
            continue
        best = min(found, key=lambda m: abs(m.value - reference))
        ok = abs(best.value - reference) <= anchor.tolerance * max(abs(reference), 1e-9) + 1e-9
        rows.append(
            {
                "label": anchor.label,
                "reference": round(reference, 4),
                "engine": best.value,
                "ok": ok,
                "how": anchor.description,
            }
        )
    return {
        "checked": len(rows),
        "accuracy": round(sum(r["ok"] for r in rows) / (len(rows) or 1), 3),
        "rows": rows,
    }


def _close(a: float | None, b: float | None, rel: float = 0.005, abs_: float = 0.011) -> bool:
    if a is None or b is None:
        return a is None and b is None
    return abs(a - b) <= max(abs_, rel * abs(b))


def recompute_roi(opp: Opportunity) -> dict:
    """Independent implementation of the documented formulas (README, annexe C du rapport)."""
    values = values_of(opp)
    gross = hours = 0.0
    for line in opp.roi_model.breakdown:
        product = float(line.get("scale", 1.0))
        for factor in line["factors"]:
            product *= values[factor]
        if line["kind"] == "time":
            hours += product
            gross += product * values[line.get("cost_key") or "hourly_cost_mad"] * 12
        else:
            gross += product * float(line.get("annualize", 12))
    project, run = values["project_cost"], values["run_cost_month"] * 12
    net = gross - run
    return {
        "gross_annual_value": gross,
        "net_annual_gain": net,
        "hours_saved_month": hours,
        "payback_months": project / (net / 12) if net > 0 else None,
        "roi_12m": (net - project) / project if project else None,
        "roi_36m": (3 * net - project) / project if project else None,
    }


def grade_roi(snap: Snapshot) -> dict:
    rows = []
    for opp in snap.opps:
        stored = opp.roi_model.results or {}
        ref = recompute_roi(opp)
        bad = [k for k, v in ref.items() if not _close(stored.get(k), v)]
        rows.append({"opportunity": opp.title, "ok": not bad, "mismatch": bad})
    return {
        "checked": len(rows),
        "accuracy": round(sum(r["ok"] for r in rows) / (len(rows) or 1), 3),
        "mismatches": [r for r in rows if not r["ok"]],
    }


# --- 4. Hallucination ----------------------------------------------------------------------------------


def traceable_pool(snap: Snapshot, raw: RawFiles) -> list[float]:
    pool: list[float] = []

    def add(value):
        if isinstance(value, bool) or value is None:
            return
        if isinstance(value, int | float):
            pool.append(float(value))
        elif isinstance(value, str):
            pool.extend(v for _, v, _ in numbers(value))
        elif isinstance(value, dict):
            for v in value.values():
                add(v)
        elif isinstance(value, list | tuple):
            for v in value:
                add(v)

    for m in snap.metrics:
        add(m.value)
        add(m.formula)
        if m.unit == "ratio":
            add(m.value * 100)
    for ev in snap.evidence.values():
        add(ev.summary)
        add(ev.excerpt)
        add(ev.value)
    for opp in snap.opps:
        for a in opp.assumptions:
            add([a.value, a.min_value, a.max_value])
            if a.unit in ("ratio", "/an"):
                add(a.value * 100)
        results = (opp.roi_model.results or {}) if opp.roi_model else {}
        add({k: v for k, v in results.items() if k != "lines"})
        add([ln.get("annual_value") for ln in results.get("lines", [])])
        if results.get("roi_12m") is not None:
            add([results["roi_12m"] * 100, results["roi_36m"] * 100])
    # Counts the narrative states about the analysis itself.
    critical = sum(1 for p in snap.pains if p.criticality == "critique")
    p1 = [o for o in snap.opps if o.priority_label == "P1"]
    add([len(snap.pains), critical, len(snap.opps), len(p1), len(snap.docs)])
    add(sum((o.roi_model.results or {}).get("gross_annual_value", 0) for o in snap.opps if o.roi_model))
    add(sum((o.roi_model.results or {}).get("gross_annual_value", 0) for o in p1 if o.roi_model))
    # Thresholds and benchmarks the method declares, the mission parameters and the company profile.
    add([b.value for b in benchmarks.BENCHMARKS.values()])
    add(
        [
            getattr(benchmarks, k)
            for k in dir(benchmarks)
            if k.isupper() and isinstance(getattr(benchmarks, k), int | float)
        ]
    )
    add(snap.mission.parameters)
    org = snap.mission.organization
    add([org.employees, org.revenue_mad])
    # Numbers written in the text sources (not CSV cells: those only count through computed metrics).
    for doc in snap.docs.values():
        if not doc.path.endswith(".csv") and (raw.folder / doc.path).exists():
            add("\n".join(raw.lines(doc.path)))
    return pool


def grade_hallucination(snap: Snapshot, raw: RawFiles, verified: set[uuid.UUID]) -> dict:
    unsupported = []
    for p in snap.pains:
        if not p.is_hypothesis and not snap.ev("pain_point", p.id):
            unsupported.append(f"irritant sans preuve : {p.title}")
    for m in snap.metrics:
        if m.nature in ("fait", "calcul") and not snap.ev("metric", m.id) and m.value != 0:
            unsupported.append(f"métrique sans preuve : {m.label}")
    for opp in snap.opps:
        grounded = any(snap.ev("pain_point", p.id) or p.is_hypothesis for p in opp.pain_points)
        if not grounded and not snap.ev("opportunity", opp.id):
            unsupported.append(f"opportunité sans irritant documenté : {opp.title}")
        for a in opp.assumptions:
            if (
                a.nature in ("fait", "calcul")
                and a.metric_id is None
                and not snap.ev("assumption", a.id)
                and a.key != "per_period"
            ):
                unsupported.append(f"hypothèse marquée {a.nature} sans source : {opp.title} / {a.label}")
            if a.nature == "hypothese" and not a.source.strip():
                unsupported.append(f"hypothèse sans justification : {opp.title} / {a.label}")
    items = len(snap.pains) + len(snap.metrics) + len(snap.opps) + sum(len(o.assumptions) for o in snap.opps)

    pool = traceable_pool(snap, raw)
    narrative = [(f"irritant « {p.title[:50]} »", f"{p.title}. {p.description}") for p in snap.pains]
    narrative += [
        (f"opportunité « {o.title[:50]} »", f"{o.title}. {o.summary} {o.category_rationale}")
        for o in snap.opps
    ]
    narrative += [(f"recommandation « {r.title[:50]} »", f"{r.title}. {r.text}") for r in snap.recs]
    total, untraceable = 0, []
    for where, text in narrative:
        for token, value, tol in numbers(text):
            total += 1
            if not any(abs(value - v) <= tol + 1e-9 for v in pool):
                untraceable.append({"where": where, "number": token})
    return {
        "items": items,
        "unsupported": unsupported,
        "unsupported_rate": round(len(unsupported) / (items or 1), 4),
        "numbers": total,
        "untraceable": untraceable,
        "untraceable_rate": round(len(untraceable) / (total or 1), 4),
    }


# --- 5. Scoring stability --------------------------------------------------------------------------------


def ranking_snapshot(snap: Snapshot) -> dict[str, tuple]:
    return {
        o.code: (
            o.priority_score,
            o.priority_rank,
            o.priority_label,
            round((o.roi_model.results or {}).get("gross_annual_value", 0)),
        )
        for o in snap.opps
    }


def kendall_tau(a: list[str], b: list[str]) -> float:
    pos = {k: i for i, k in enumerate(b)}
    concordant = discordant = 0
    for x, y in itertools.combinations(a, 2):
        if pos[x] < pos[y]:
            concordant += 1
        else:
            discordant += 1
    pairs = concordant + discordant
    return 1.0 if pairs == 0 else (concordant - discordant) / pairs


def grade_sensitivity(db: Session, snap: Snapshot) -> dict:
    """Rank stability when each scoring coefficient moves by ±20 %."""
    weights, penalties = scoring_model(db, snap.mission.organization_id)

    def ranking(w, p):
        return [o.code for o in sorted(snap.opps, key=lambda o: (-priority(o.scores, w, p), o.code))]

    base = ranking(weights, penalties)
    taus, top3, top1 = [], [], []
    for group, key in [("w", k) for k, v in weights.items() if v > 0] + [
        ("p", k) for k, v in penalties.items() if v > 0
    ]:
        for factor in (0.8, 1.2):
            w, p = dict(weights), dict(penalties)
            target = w if group == "w" else p
            target[key] = round(target[key] * factor, 4)
            ranked = ranking(w, p)
            taus.append(kendall_tau(base, ranked))
            top3.append(set(ranked[:3]) == set(base[:3]))
            top1.append(ranked[0] == base[0])
    return {
        "perturbations": len(taus),
        "kendall_tau_min": round(min(taus), 3) if taus else 1.0,
        "kendall_tau_mean": round(sum(taus) / len(taus), 3) if taus else 1.0,
        "top3_kept": round(sum(top3) / len(top3), 3) if top3 else 1.0,
        "top1_kept": round(sum(top1) / len(top1), 3) if top1 else 1.0,
    }


# --- 6. Executive synthesis ------------------------------------------------------------------------------


def grade_synthesis(snap: Snapshot) -> dict:
    by_key = {r.generated.get("key"): r for r in snap.recs}
    summary, decision, hyp = by_key.get("summary"), by_key.get("decision"), by_key.get("hypotheses")
    p1 = [o for o in snap.opps if o.priority_label == "P1"]
    hypotheses = [p for p in snap.pains if p.is_hypothesis]
    critical = [p for p in snap.pains if p.criticality == "critique"]
    checks = {
        "synthèse présente": summary is not None,
        "synthèse concise (300–900 caractères)": bool(summary and 300 <= len(summary.text) <= 900),
        "potentiel total annoncé": bool(summary and "MAD/an" in summary.text),
        "irritants critiques nommés": bool(
            summary
            and all(_norm(p.title.split(":")[0].strip())[:25] in _norm(summary.text) for p in critical[:3])
        ),
        "décision recommandée": decision is not None,
        "la décision cite une opportunité P1": bool(
            decision and any(_norm(o.title) in _norm(decision.text) for o in p1)
        ),
        "chaque P1 a une recommandation chiffrée": all(
            (r := by_key.get(o.code)) is not None and "MAD/an" in r.text and "payback" in r.text for o in p1
        ),
        "hypothèses signalées": not hypotheses
        or bool(hyp and all(_norm(p.title) in _norm(hyp.text) for p in hypotheses)),
    }
    return {"score": round(sum(checks.values()) / len(checks), 3), "checks": checks}


# --- 7. Value against the kit's reference estimates ----------------------------------------------------------


def grade_values(snap: Snapshot, gt: GroundTruth) -> dict:
    scores = {
        (i, j): similarity(e.title, "", f"{o.title} {o.summary}")
        for i, e in enumerate(gt.opportunities)
        for j, o in enumerate(snap.opps)
    }
    matches = assign(scores, OPPORTUNITY_THRESHOLD)
    rows = []
    for i, expected in enumerate(gt.opportunities):
        hit = matches.get(i)
        opp = snap.opps[hit[0]] if hit else None
        value = (opp.roi_model.results or {}).get("gross_annual_value") if opp and opp.roi_model else None
        rows.append(
            {
                "expected": expected.title,
                "expected_value": expected.annual_value_mad,
                "matched": opp.title if opp else None,
                "engine_value": round(value) if value else None,
                "ratio": round(value / expected.annual_value_mad, 2) if value else None,
                "priority": opp.priority_label if opp else None,
            }
        )
    ratios = sorted(r["ratio"] for r in rows if r["ratio"])
    engine_total = sum(
        (o.roi_model.results or {}).get("gross_annual_value", 0) for o in snap.opps if o.roi_model
    )
    expected_total = sum(e.annual_value_mad for e in gt.opportunities)
    return {
        "coverage": round(len(matches) / len(gt.opportunities), 3),
        "median_ratio": ratios[len(ratios) // 2] if ratios else None,
        "within_factor_2": round(sum(1 for r in ratios if 0.5 <= r <= 2) / (len(ratios) or 1), 3),
        "engine_total": round(engine_total),
        "expected_total": round(expected_total),
        "rows": rows,
    }


def grade(db: Session, mission: AuditMission, slug: str, folder: Path, gt: GroundTruth) -> dict:
    snap = Snapshot.load(db, mission)
    raw = RawFiles(folder)
    evidence, verified = grade_evidence(snap, raw)
    return {
        "company": gt.company,
        "slug": slug,
        "sources": len(snap.docs),
        "answer_key_ingested": any(
            Path(d.path).name in ("ground_truth.json", "manifest.json") for d in snap.docs.values()
        ),
        "issues": grade_issues(snap, gt, verified),
        "evidence": evidence,
        "anchors": grade_anchors(snap, slug, folder),
        "roi": grade_roi(snap),
        "hallucination": grade_hallucination(snap, raw, verified),
        "sensitivity": grade_sensitivity(db, snap),
        "synthesis": grade_synthesis(snap),
        "values": grade_values(snap, gt),
        "ranking": ranking_snapshot(snap),
    }


__all__ = ["grade", "Snapshot", "ranking_snapshot", "asdict"]
