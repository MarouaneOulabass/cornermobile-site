"""Executive report (spec §9 écran 9): one data model, rendered as HTML (screen) and PDF (WeasyPrint).

Every figure in the report comes from a metric or an ROI model and carries its nature
(fait / calcul / hypothèse); every claim points to numbered evidence in the annex.
"""

from __future__ import annotations

import hashlib
import uuid
from datetime import UTC, datetime
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape
from markupsafe import Markup
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.domain.enums import MissionStatus, TargetType, ValidationStatus
from app.engine.fmt import mad, n0, n1, pct
from app.engine.scoring import DEFAULT_PENALTIES, DEFAULT_WEIGHTS
from app.models import (
    Assumption,
    AuditMission,
    Comment,
    Document,
    Evidence,
    EvidenceLink,
    Export,
    Metric,
    Opportunity,
    PainPoint,
    Recommendation,
    Risk,
    RoadmapItem,
    Validation,
)
from app.services.business_case import scoring_model
from app.services.missions import mission_stats
from app.services.storage import get_storage, mission_prefix

TEMPLATES = Path(__file__).resolve().parent.parent / "templates"
_CRIT = {"critique": 0, "elevee": 1, "moyenne": 2, "faible": 3}
CATEGORY_LABELS = {
    "automatisation": "Automatisation",
    "integration_si": "Intégration SI",
    "amelioration_processus": "Amélioration de processus",
    "bi_data": "BI / data",
    "assistant_ia": "Assistant IA",
    "agent_ia": "Agent IA",
    "rag": "Recherche documentaire (RAG)",
    "prediction_optimisation": "Prédiction / optimisation",
    "nouveau_service": "Nouveau service",
}
STATUS_LABELS = {"a_verifier": "À vérifier", "valide": "Validé", "corrige": "Corrigé", "rejete": "Rejeté"}
CRIT_LABELS = {"critique": "Critique", "elevee": "Élevée", "moyenne": "Moyenne", "faible": "Faible"}
NATURE_LABELS = {"fait": "Fait", "calcul": "Calcul", "hypothese": "Hypothèse"}
KIND_LABELS = {
    "socle": "Socle",
    "quick_win": "Quick win",
    "pilote": "Pilote",
    "industrialisation": "Déploiement",
    "projet": "Projet",
}
PHASES = [
    ("j30", "0–30 jours — Quick wins"),
    ("j60", "30–60 jours — Pilotes"),
    ("j90", "60–90 jours — Industrialisation"),
    ("t2", "Mois 4–6"),
    ("t3", "Mois 7–9"),
    ("t4", "Mois 10–12"),
]


def fmt_value(value: float, unit: str) -> str:
    if unit == "ratio":
        return pct(value)
    if unit == "MAD":
        return mad(value)
    if unit == "MAD/an":
        return f"{mad(value)}/an"
    if unit == "/an":
        return f"{pct(value, 0)}/an"
    if unit in ("%",):
        return f"{n1(value)} %"
    text = n1(value) if value % 1 else n0(value)
    return f"{text} {unit}".strip()


class EvidenceIndex:
    """Numbers evidence in order of first citation: [E1], [E2]..."""

    def __init__(self, docs: dict[uuid.UUID, Document]):
        self.docs = docs
        self.order: list[Evidence] = []
        self.ids: dict[uuid.UUID, int] = {}

    def cite(self, evidence: list[Evidence], limit: int = 4) -> list[int]:
        refs = []
        for ev in evidence[:limit]:
            if ev.id not in self.ids:
                self.order.append(ev)
                self.ids[ev.id] = len(self.order)
            refs.append(self.ids[ev.id])
        return refs

    def annex(self) -> list[dict]:
        out = []
        for n, ev in enumerate(self.order, start=1):
            doc = self.docs.get(ev.document_id)
            loc = ev.locator or {}
            if loc.get("lines"):
                where = f"lignes {loc['lines'][0]}–{loc['lines'][1]}"
            elif loc.get("rows") is not None:
                where = f"{loc.get('row_count', len(loc.get('rows', [])))} ligne(s) de données · colonnes {', '.join(loc.get('columns', [])[:3])}"
            else:
                where = "document"
            out.append(
                {
                    "n": n,
                    "file": doc.path if doc else "—",
                    "where": where,
                    "summary": ev.summary,
                    "excerpt": ev.excerpt[:400],
                    "origin": ev.origin,
                }
            )
        return out


def _evidence_map(db: Session, mission_id: uuid.UUID, target_type: str) -> dict[uuid.UUID, list[Evidence]]:
    rows = db.execute(
        select(EvidenceLink.target_id, Evidence)
        .join(Evidence, Evidence.id == EvidenceLink.evidence_id)
        .where(EvidenceLink.mission_id == mission_id, EvidenceLink.target_type == target_type)
        .order_by(Evidence.relevance.desc())
    ).all()
    out: dict[uuid.UUID, list[Evidence]] = {}
    for target_id, ev in rows:
        out.setdefault(target_id, []).append(ev)
    return out


def build_report(db: Session, mission: AuditMission) -> dict:
    org = mission.organization
    stats = mission_stats(db, mission)
    docs = {d.id: d for d in db.scalars(select(Document).where(Document.mission_id == mission.id))}
    index = EvidenceIndex(docs)
    pp_ev = _evidence_map(db, mission.id, TargetType.pain_point)
    metric_ev = _evidence_map(db, mission.id, TargetType.metric)
    assumption_ev = _evidence_map(db, mission.id, TargetType.assumption)

    recs = sorted(
        db.scalars(
            select(Recommendation).where(
                Recommendation.mission_id == mission.id,
                Recommendation.validation_status != ValidationStatus.rejete,
            )
        ),
        key=lambda r: r.ordinal,
    )
    pains = sorted(
        db.scalars(
            select(PainPoint).where(
                PainPoint.mission_id == mission.id, PainPoint.validation_status != ValidationStatus.rejete
            )
        ),
        key=lambda p: (_CRIT.get(p.criticality, 9), -p.severity),
    )
    metrics: dict[uuid.UUID, list[Metric]] = {}
    for m in db.scalars(select(Metric).where(Metric.mission_id == mission.id)):
        metrics.setdefault(m.pain_point_id, []).append(m)
    findings = []
    for p in pains:
        findings.append(
            {
                "title": p.title,
                "description": p.description,
                "criticality": CRIT_LABELS.get(p.criticality, p.criticality),
                "crit_key": p.criticality,
                "type": p.type,
                "confidence": pct(p.confidence, 0),
                "status": STATUS_LABELS[p.validation_status],
                "status_key": p.validation_status,
                "hypothesis": p.is_hypothesis,
                "department": p.department or "Transverse",
                "impact": p.impact,
                "refs": index.cite(pp_ev.get(p.id, []), 3),
                "metrics": [
                    {
                        "label": m.label,
                        "value": fmt_value(m.value, m.unit),
                        "nature": NATURE_LABELS.get(m.nature, m.nature),
                        "nature_key": m.nature,
                        "formula": m.formula,
                        "refs": index.cite(metric_ev.get(m.id, []), 2),
                    }
                    for m in metrics.get(p.id, [])
                ],
            }
        )

    opps = sorted(
        db.scalars(
            select(Opportunity).where(
                Opportunity.mission_id == mission.id, Opportunity.validation_status != ValidationStatus.rejete
            )
        ),
        key=lambda o: -o.priority_score,
    )
    cases = []
    hypotheses = []
    for o in opps:
        r = o.roi_model.results if o.roi_model else {}
        assumptions, to_validate = [], []
        for a in o.assumptions:
            if a.key == "per_period":
                continue
            row = {
                "label": a.label,
                "value": fmt_value(a.value, a.unit),
                "nature": NATURE_LABELS.get(a.nature, a.nature),
                "nature_key": a.nature,
                "source": a.source,
                "edited": "value" in (a.edited_fields or []),
                "refs": index.cite(assumption_ev.get(a.id, []), 1),
            }
            assumptions.append(row)
            if a.nature == "hypothese":
                to_validate.append(row)
        if to_validate:
            hypotheses.append({"case": o.title, "items": to_validate})
        cases.append(
            {
                "id": str(o.id),
                "title": o.title,
                "summary": o.summary,
                "category": CATEGORY_LABELS.get(o.category, o.category),
                "rationale": o.category_rationale,
                "priority": o.priority_label or "—",
                "rank": o.priority_rank,
                "score": o.priority_score,
                "effort": o.effort,
                "delivery": o.target_delivery,
                "status": STATUS_LABELS[o.validation_status],
                "status_key": o.validation_status,
                "confidence": pct(o.confidence, 0),
                "value": mad(r.get("gross_annual_value", 0)),
                "value_raw": r.get("gross_annual_value", 0),
                "net": mad(r.get("net_annual_gain", 0)),
                "payback": f"{n1(r['payback_months'])} mois" if r.get("payback_months") else "—",
                "hours": n1(r.get("hours_saved_month", 0)),
                "project_cost": mad(r.get("project_cost", 0)),
                "run_cost": mad(r.get("annual_solution_cost", 0)),
                "roi12": pct(r["roi_12m"], 0) if r.get("roi_12m") is not None else "—",
                "roi36": pct(r["roi_36m"], 0) if r.get("roi_36m") is not None else "—",
                "lines": [
                    {"label": ln["label"], "value": mad(ln["annual_value"])} for ln in r.get("lines", [])
                ],
                "assumptions": assumptions,
                "pilot": o.pilot_plan,
                "kpis": o.kpis,
                "pains": [p.title for p in o.pain_points],
            }
        )

    items = sorted(
        db.scalars(
            select(RoadmapItem).where(
                RoadmapItem.mission_id == mission.id, RoadmapItem.validation_status != ValidationStatus.rejete
            )
        ),
        key=lambda i: (i.start_week, i.ordinal),
    )
    roadmap = [
        {
            "key": key,
            "label": label,
            "items": [
                {
                    "title": i.title,
                    "kind": KIND_LABELS.get(i.kind, i.kind),
                    "weeks": f"S{i.start_week + 1}–S{i.start_week + i.duration_weeks}",
                    "owner": i.owner or "à désigner",
                }
                for i in items
                if i.phase == key
            ],
        }
        for key, label in PHASES
    ]
    roadmap = [p for p in roadmap if p["items"]]

    risks = sorted(
        db.scalars(
            select(Risk).where(
                Risk.mission_id == mission.id, Risk.validation_status != ValidationStatus.rejete
            )
        ),
        key=lambda r: (_CRIT.get(r.severity, 9), -(r.exposure_mad_per_year or 0)),
    )
    validations = db.scalars(
        select(Validation).where(Validation.mission_id == mission.id).order_by(Validation.created_at.desc())
    ).all()
    weights, penalties = scoring_model(db, mission.organization_id)
    p1 = [c for c in cases if c["priority"] == "P1"]
    total = sum(c["value_raw"] for c in cases)
    return {
        "organization": {
            "name": org.name,
            "sector": org.sector,
            "city": org.city,
            "employees": org.employees,
            "revenue": mad(org.revenue_mad) if org.revenue_mad else None,
        },
        "mission": {
            "name": mission.name,
            "objectives": mission.objectives,
            "version": mission.analysis_version,
            "analyzed_at": mission.analyzed_at.strftime("%d/%m/%Y") if mission.analyzed_at else None,
            "published": mission.published_at is not None and mission.status == MissionStatus.published,
            "published_at": mission.published_at.strftime("%d/%m/%Y") if mission.published_at else None,
        },
        "generated_at": datetime.now(UTC).strftime("%d/%m/%Y %H:%M UTC"),
        "figures": {
            "value": mad(total),
            "value_p1": mad(sum(c["value_raw"] for c in p1)),
            "p1": len(p1),
            "opportunities": len(cases),
            "pain_points": stats.pain_points,
            "critical": stats.pain_points_critical,
            "confidence": pct(stats.analysis_confidence or 0, 0),
            "reviewed": pct(stats.validated_share, 0),
            "sources": stats.documents,
        },
        "recommendations": [
            {"title": r.title, "text": r.text, "key": r.generated.get("key"), "edited": bool(r.edited_fields)}
            for r in recs
        ],
        "findings": findings,
        "cases": cases,
        "roadmap": roadmap,
        "risks": [
            {
                "title": r.title,
                "description": r.description,
                "severity": CRIT_LABELS.get(r.severity, r.severity),
                "exposure": mad(r.exposure_mad_per_year) if r.exposure_mad_per_year else "—",
            }
            for r in risks
        ],
        "maturity": (mission.insights or {}).get("maturity", []),
        "completeness": (mission.insights or {}).get("completeness", {}),
        "hypotheses": hypotheses,
        "evidence": index.annex(),
        "sources": [
            {"path": d.path, "category": d.category or "—", "sha": d.sha256[:12], "status": d.status}
            for d in sorted(docs.values(), key=lambda d: d.path)
            if d.is_current
        ],
        "validations": [
            {
                "who": v.user_name,
                "when": v.created_at.strftime("%d/%m/%Y %H:%M"),
                "what": v.target_type,
                "status": STATUS_LABELS.get(v.status, v.status),
                "fields": ", ".join(v.changes) or "—",
                "comment": v.comment or "",
            }
            for v in validations[:60]
        ],
        "weights": weights,
        "penalties": penalties,
        "default_weights": weights == {**DEFAULT_WEIGHTS} and penalties == {**DEFAULT_PENALTIES},
    }


def _css_string(value: str) -> Markup:
    """Escape text for a CSS string literal (page margin boxes), where HTML escaping does not apply."""
    cleaned = "".join(ch for ch in str(value) if ch.isprintable())
    return Markup(cleaned.replace("\\", "\\\\").replace('"', '\\"').replace("<", "\\3C "))


def _env() -> Environment:
    env = Environment(loader=FileSystemLoader(TEMPLATES), autoescape=select_autoescape(["html", "j2"]))
    env.filters["refs"] = lambda refs: Markup(
        "".join(f'<a class="ref" href="#E{int(n)}">E{int(n)}</a>' for n in refs)
    )
    env.filters["css_string"] = _css_string
    return env


def render_html(data: dict) -> str:
    return _env().get_template("report.html.j2").render(**data)


def render_pdf(html: str) -> bytes:
    from weasyprint import HTML

    return HTML(string=html, base_url=str(TEMPLATES)).write_pdf()


def create_export(
    db: Session,
    mission: AuditMission,
    fmt: str,
    user_id: uuid.UUID | None,
    *,
    published: bool = False,
    html: str | None = None,
) -> Export:
    html = html if html is not None else render_html(build_report(db, mission))
    if fmt == "pdf":
        payload, ext, ctype = render_pdf(html), "pdf", "application/pdf"
    else:
        payload, ext, ctype = html.encode(), "html", "text/html; charset=utf-8"
    export_id = uuid.uuid4()
    key = f"{mission_prefix(mission.organization_id, mission.id)}/exports/{export_id}.{ext}"
    get_storage().put(key, payload, ctype)
    export = Export(
        id=export_id,
        organization_id=mission.organization_id,
        mission_id=mission.id,
        format=fmt,
        storage_key=key,
        size_bytes=len(payload),
        sha256=hashlib.sha256(payload).hexdigest(),
        analysis_version=mission.analysis_version,
        published=published,
        created_by_id=user_id,
    )
    db.add(export)
    db.flush()
    return export


def _aware(value: datetime) -> datetime:
    """SQLite returns naive datetimes; compare everything in UTC."""
    return value if value.tzinfo else value.replace(tzinfo=UTC)


def publication_check(db: Session, mission: AuditMission) -> dict:
    """Items the consultant has not reviewed yet, and open contestations from the client."""
    unreviewed = {}
    for name, model, extra in (
        ("pain_points", PainPoint, ()),
        ("opportunities", Opportunity, ()),
        ("assumptions", Assumption, (Assumption.nature == "hypothese",)),
        ("recommendations", Recommendation, ()),
    ):
        unreviewed[name] = (
            db.scalar(
                select(func.count())
                .select_from(model)
                .where(
                    model.mission_id == mission.id,
                    model.validation_status == ValidationStatus.a_verifier,
                    *extra,
                )
            )
            or 0
        )
    # A contestation stays open until a consultant reviews its target afterwards.
    last_review: dict[uuid.UUID, datetime] = dict(
        db.execute(
            select(Validation.target_id, func.max(Validation.created_at))
            .where(Validation.mission_id == mission.id)
            .group_by(Validation.target_id)
        ).all()
    )
    contested = sum(
        1
        for c in db.scalars(
            select(Comment).where(Comment.mission_id == mission.id, Comment.kind == "contestation")
        )
        if c.target_id not in last_review or _aware(last_review[c.target_id]) < _aware(c.created_at)
    )
    published = db.scalars(
        select(Export)
        .where(Export.mission_id == mission.id, Export.published.is_(True))
        .order_by(Export.created_at.desc())
    ).first()
    return {
        "analyzed": mission.analysis_version > 0,
        "published_at": mission.published_at,
        "published_version": published.analysis_version if published and mission.published_at else None,
        "analysis_version": mission.analysis_version,
        "unreviewed": unreviewed,
        "contested": contested,
        "ready": mission.analysis_version > 0 and not any(unreviewed.values()) and not contested,
    }


def publish(db: Session, mission: AuditMission, user_id: uuid.UUID | None) -> list[Export]:
    """Freeze the deliverable: earlier published exports are retired, a fresh HTML + PDF pair becomes the client version."""
    for old in db.scalars(select(Export).where(Export.mission_id == mission.id, Export.published.is_(True))):
        old.published = False
    mission.published_at = datetime.now(UTC)
    mission.status = MissionStatus.published
    db.flush()
    html = render_html(build_report(db, mission))
    return [create_export(db, mission, fmt, user_id, published=True, html=html) for fmt in ("html", "pdf")]


def unpublish(db: Session, mission: AuditMission) -> None:
    for export in db.scalars(
        select(Export).where(Export.mission_id == mission.id, Export.published.is_(True))
    ):
        export.published = False
    mission.published_at = None
    if mission.status == MissionStatus.published:
        mission.status = MissionStatus.review
