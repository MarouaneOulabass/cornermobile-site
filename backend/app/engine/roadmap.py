"""Roadmap generation (spec §9 écran 8): 30/60/90 days, then a 12-month portfolio.

Rules, in order:
  - enablers first (validate hypotheses in interviews, collect missing data, governance);
  - quick wins (low effort, P1/P2) start in the first 30 days;
  - medium-effort P1/P2 become pilots in days 30-60 (at most 2 pilots starting together),
    followed by a deployment item;
  - high effort, low data readiness or P3 go to the 12-month portfolio;
  - explicit dependencies push an item after its prerequisite.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.domain.enums import EffortLevel, RoadmapPhase, ValidationStatus
from app.models import AuditMission, Opportunity, PainPoint, RoadmapItem

PHASE_WEEKS = {
    RoadmapPhase.j30: (0, 3),
    RoadmapPhase.j60: (4, 8),
    RoadmapPhase.j90: (9, 12),
    RoadmapPhase.t2: (13, 25),
    RoadmapPhase.t3: (26, 38),
    RoadmapPhase.t4: (39, 51),
}

# dependent → prerequisites (by opportunity code)
DEPENDS_ON = {
    "opp:invoicing_flow": ["opp:field_reports"],  # invoicing needs structured intervention reports
    "opp:sla_radar": ["opp:support_assistant"],  # the radar reads timestamps from the single ticketing tool
}
MAX_PILOTS_PER_PHASE = 2


def phase_for_week(week: int) -> str:
    for phase, (lo, hi) in PHASE_WEEKS.items():
        if lo <= week <= hi:
            return phase
    return RoadmapPhase.t4


def _weeks(delivery: str | None, default: int) -> int:
    nums = [int(x) for x in re.findall(r"\d+", delivery or "")]
    return max(nums) if nums else default


@dataclass
class ItemSpec:
    key: str
    title: str
    description: str
    kind: str
    start_week: int
    duration_weeks: int
    owner: str | None = None
    opportunity: Opportunity | None = None
    depends_on: list[str] = field(default_factory=list)

    @property
    def phase(self) -> str:
        return phase_for_week(self.start_week)

    @property
    def end_week(self) -> int:
        return self.start_week + self.duration_weeks


def plan(mission: AuditMission, opps: list[Opportunity], hypotheses: list[PainPoint]) -> list[ItemSpec]:
    items: list[ItemSpec] = []
    active = sorted(
        [o for o in opps if o.validation_status != ValidationStatus.rejete], key=lambda o: -o.priority_score
    )
    gaps = [
        g for g in (mission.insights or {}).get("completeness", {}).get("gaps", []) if g.startswith("Période")
    ]

    items.append(
        ItemSpec(
            "socle:governance",
            "Lancement : sponsor, comité de pilotage, indicateurs de référence",
            "Nommer le sponsor et les propriétaires de chaque chantier, figer la mesure de départ (baseline).",
            "socle",
            0,
            2,
            "Direction",
        )
    )
    if hypotheses or any(a.nature == "hypothese" for o in active[:5] for a in o.assumptions):
        items.append(
            ItemSpec(
                "socle:validate",
                "Validation des hypothèses en entretien",
                "Confirmer volumes, temps unitaires et coûts horaires des business cases prioritaires"
                + (f" ; {len(hypotheses)} irritant(s) à confirmer" if hypotheses else "")
                + ".",
                "socle",
                0,
                3,
                "Consultant",
            )
        )
    if gaps:
        items.append(
            ItemSpec(
                "socle:data",
                "Collecte des données manquantes",
                " ; ".join(gaps)[:500],
                "socle",
                1,
                4,
                "DSI / métiers",
            )
        )

    pilots_by_phase: dict[str, int] = {}
    placed: dict[str, ItemSpec] = {}
    for o in active:
        readiness = (o.generated or {}).get("data_readiness", 0.6)
        weeks = _weeks(o.target_delivery, 8)
        value = (o.roi_model.results or {}).get("gross_annual_value", 0) if o.roi_model else 0
        desc = f"{o.summary} Valeur estimée : {round(value / 1000):,} k MAD/an.".replace(",", " ")
        if o.effort == EffortLevel.faible and o.priority_label in ("P1", "P2") and readiness >= 0.4:
            spec = ItemSpec(f"{o.code}:quick", o.title, desc, "quick_win", 1, weeks, o.department, o)
        elif o.effort != EffortLevel.eleve and o.priority_label in ("P1", "P2") and readiness >= 0.4:
            start = 4
            while pilots_by_phase.get(phase_for_week(start), 0) >= MAX_PILOTS_PER_PHASE:
                start = PHASE_WEEKS[phase_for_week(start)][1] + 1
            pilots_by_phase[phase_for_week(start)] = pilots_by_phase.get(phase_for_week(start), 0) + 1
            pilot_weeks = sum(p.get("weeks", 0) for p in o.pilot_plan) or weeks
            spec = ItemSpec(
                f"{o.code}:pilot", f"Pilote — {o.title}", desc, "pilote", start, pilot_weeks, o.department, o
            )
        else:
            start = 13 if o.priority_label in ("P1", "P2") else 26
            spec = ItemSpec(
                f"{o.code}:project",
                o.title,
                desc + (" Prérequis : données à collecter." if readiness < 0.4 else ""),
                "projet",
                start,
                weeks,
                o.department,
                o,
            )
        items.append(spec)
        placed[o.code] = spec

    # Dependencies: a dependent starts after its prerequisites end.
    for dependent, prerequisites in DEPENDS_ON.items():
        if dependent not in placed:
            continue
        for prereq in prerequisites:
            if prereq in placed and placed[dependent].start_week <= placed[prereq].end_week:
                placed[dependent].start_week = placed[prereq].end_week + 1
                placed[dependent].depends_on.append(placed[prereq].key)

    # Each pilot is followed by its deployment once the gains are measured.
    for code, spec in list(placed.items()):
        if spec.kind == "pilote":
            items.append(
                ItemSpec(
                    f"{code}:deploy",
                    f"Déploiement — {spec.opportunity.title}",
                    "Extension à toutes les équipes après mesure des gains du pilote.",
                    "industrialisation",
                    spec.end_week + 1,
                    6,
                    spec.owner,
                    spec.opportunity,
                    [spec.key],
                )
            )
    if any(i.kind == "quick_win" for i in items):
        items.append(
            ItemSpec(
                "socle:measure",
                "Mesure des gains des quick wins et arbitrage des déploiements",
                "Comparer les indicateurs aux valeurs de référence, recalibrer les business cases.",
                "socle",
                10,
                2,
                "Direction",
            )
        )
    return items


def persist_roadmap(db: Session, mission: AuditMission) -> list[RoadmapItem]:
    opps = list(db.scalars(select(Opportunity).where(Opportunity.mission_id == mission.id)))
    hypotheses = list(
        db.scalars(
            select(PainPoint).where(PainPoint.mission_id == mission.id, PainPoint.is_hypothesis.is_(True))
        )
    )
    specs = plan(mission, opps, hypotheses)
    existing = {
        i.generated.get("key"): i
        for i in db.scalars(select(RoadmapItem).where(RoadmapItem.mission_id == mission.id))
        if i.generated.get("key")
    }
    out = []
    for ordinal, spec in enumerate(sorted(specs, key=lambda s: (s.start_week, s.kind != "socle"))):
        item = existing.pop(spec.key, None)
        if item is None:
            item = RoadmapItem(organization_id=mission.organization_id, mission_id=mission.id)
            db.add(item)
        edited = set(item.edited_fields or [])
        values = {
            "title": spec.title,
            "description": spec.description,
            "kind": spec.kind,
            "phase": spec.phase,
            "start_week": spec.start_week,
            "duration_weeks": spec.duration_weeks,
            "owner": spec.owner,
        }
        for field_name, value in values.items():
            if field_name not in edited:
                setattr(item, field_name, value)
        if "start_week" in edited and "phase" not in edited:
            item.phase = phase_for_week(item.start_week)
        item.opportunity_id = spec.opportunity.id if spec.opportunity else None
        item.depends_on = spec.depends_on
        item.ordinal = ordinal
        item.generated = {"key": spec.key, **values}
        out.append(item)
    for stale in existing.values():
        if not stale.edited_fields and stale.validation_status == ValidationStatus.a_verifier:
            db.delete(stale)
        else:
            out.append(stale)
    db.flush()
    return out
