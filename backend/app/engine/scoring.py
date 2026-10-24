"""Opportunity scoring (spec §6): eleven 0-100 sub-scores and a configurable priority formula.

Priority = Σ weight × score − Σ penalty × score. Coefficients come from the organisation's active
ScoringModel (admin-editable) and default to the spec's proposal.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from app.domain.enums import AI_CATEGORIES, Criticality, EffortLevel
from app.domain.enums import OpportunityCategory as C

DEFAULT_WEIGHTS = {
    "business_impact": 0.30,
    "time_saved": 0.20,
    "cost_reduction": 0.15,
    "revenue_upside": 0.10,
    "feasibility": 0.10,
    "data_readiness": 0.10,
    "confidence": 0.05,
    "risk_reduction": 0.0,
}
DEFAULT_PENALTIES = {"technical_complexity": 0.10, "compliance_risk": 0.05, "change_effort": 0.05}

SUBSCORES = (
    "business_impact",
    "time_saved",
    "revenue_upside",
    "cost_reduction",
    "risk_reduction",
    "feasibility",
    "data_readiness",
    "change_effort",
    "technical_complexity",
    "compliance_risk",
    "confidence",
)

_EFFORT_FEASIBILITY = {EffortLevel.faible: 85, EffortLevel.moyen: 65, EffortLevel.eleve: 40}
_EFFORT_CHANGE = {EffortLevel.faible: 30, EffortLevel.moyen: 50, EffortLevel.eleve: 70}
_COMPLEXITY = {
    C.amelioration_processus: 15,
    C.automatisation: 30,
    C.bi_data: 35,
    C.integration_si: 50,
    C.assistant_ia: 50,
    C.rag: 55,
    C.agent_ia: 70,
    C.prediction_optimisation: 70,
    C.nouveau_service: 60,
}
_CRIT = {Criticality.critique: 100, Criticality.elevee: 75, Criticality.moyenne: 50, Criticality.faible: 25}


def saturate(value: float, scale: float) -> float:
    """0 → 0, `scale` → 63, 3×`scale` → 95: diminishing returns, bounded at 100."""
    if value <= 0 or scale <= 0:
        return 0.0
    return 100 * (1 - math.exp(-value / scale))


@dataclass
class ScoreInputs:
    category: str
    effort: str
    gross_annual_value: float
    hours_saved_month: float
    by_family: dict[str, float]
    revenue: float
    pain_criticality: str
    pain_confidence: float
    fact_share: float  # share of assumptions read or computed from sources (vs hypotheses)
    risk_reduction: float
    data_readiness: float
    compliance: float
    departments_involved: int


def subscores(x: ScoreInputs) -> dict[str, float]:
    revenue = x.revenue or 50_000_000
    value_scale = 0.004 * revenue  # 0.4 % of revenue per year ≈ 63 points
    cost = x.by_family.get("cost", 0.0)
    rev = x.by_family.get("revenue", 0.0)
    risk = x.by_family.get("risk", 0.0)
    impact = 0.7 * saturate(x.gross_annual_value, value_scale) + 0.3 * _CRIT.get(
        Criticality(x.pain_criticality), 50
    )
    feasibility = _EFFORT_FEASIBILITY[EffortLevel(x.effort)] + (
        5 if x.category in (C.automatisation, C.bi_data, C.amelioration_processus) else 0
    )
    feasibility -= (
        10
        if x.category in (C.agent_ia, C.prediction_optimisation)
        else 5
        if x.category in AI_CATEGORIES
        else 0
    )
    complexity = _COMPLEXITY[C(x.category)] + (10 if x.effort == EffortLevel.eleve else 0)
    change = _EFFORT_CHANGE[EffortLevel(x.effort)] + 5 * max(0, x.departments_involved - 1)
    compliance = 100 * x.compliance + (15 if x.category in AI_CATEGORIES else 0)
    confidence = 100 * (0.6 * x.pain_confidence + 0.4 * x.fact_share)
    scores = {
        "business_impact": impact,
        "time_saved": saturate(x.hours_saved_month, 80),
        "revenue_upside": saturate(rev, 0.002 * revenue),
        "cost_reduction": saturate(cost, 0.003 * revenue),
        "risk_reduction": min(100, 100 * x.risk_reduction + saturate(risk, 0.002 * revenue) * 0.3),
        "feasibility": feasibility,
        "data_readiness": 100 * x.data_readiness,
        "change_effort": change,
        "technical_complexity": complexity,
        "compliance_risk": compliance,
        "confidence": confidence,
    }
    return {k: round(max(0.0, min(100.0, v)), 1) for k, v in scores.items()}


def priority(scores: dict[str, float], weights: dict | None = None, penalties: dict | None = None) -> float:
    w = {**DEFAULT_WEIGHTS, **(weights or {})}
    p = {**DEFAULT_PENALTIES, **(penalties or {})}
    value = sum(w.get(k, 0) * scores.get(k, 0) for k in w) - sum(p.get(k, 0) * scores.get(k, 0) for k in p)
    return round(value, 1)


def labels(priorities: list[float]) -> list[str]:
    """Rank-based within the mission: P1 for the head (≤ 40 %, max 5), P2 for the next 40 %, P3 for the tail.

    Scores are relative to the company's size, so labels are relative too; a floor keeps clearly weak
    opportunities out of P1/P2.
    """
    n = len(priorities)
    order = sorted(range(n), key=lambda i: -priorities[i])
    p1 = max(1, min(5, round(0.4 * n)))
    p2 = max(1, round(0.4 * n))
    out = ["P3"] * n
    for rank, i in enumerate(order):
        if rank < p1 and priorities[i] >= 20:
            out[i] = "P1"
        elif rank < p1 + p2 and priorities[i] >= 15:
            out[i] = "P2"
    return out
