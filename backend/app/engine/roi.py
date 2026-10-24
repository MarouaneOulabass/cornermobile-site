"""Deterministic ROI engine (spec §7). Pure functions: same assumptions in, same numbers out.

A business case is a list of value lines over named assumptions:
  - "time":    hours/month = Π factors ; value/year = hours × hourly cost × 12
  - "product": value/year  = Π factors × annualize
plus a one-off project cost and a recurring run cost.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field


@dataclass(frozen=True)
class ValueLine:
    key: str
    label: str
    kind: str  # time | product
    factors: tuple[str, ...]
    cost_key: str | None = None  # time lines: hourly cost assumption
    annualize: float = 12.0  # product lines expressed per month are ×12, yearly ones ×1
    family: str = "cost"  # cost | revenue | risk — feeds the scoring sub-scores
    scale: float = 1.0  # constant factor, e.g. 1/60 to turn minutes into hours


@dataclass
class ROIResult:
    hours_saved_month: float
    gross_annual_value: float
    annual_solution_cost: float
    project_cost: float
    net_annual_gain: float
    payback_months: float | None
    roi_12m: float | None
    roi_36m: float | None
    by_family: dict[str, float] = field(default_factory=dict)
    lines: list[dict] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "hours_saved_month": self.hours_saved_month,
            "gross_annual_value": self.gross_annual_value,
            "annual_solution_cost": self.annual_solution_cost,
            "project_cost": self.project_cost,
            "net_annual_gain": self.net_annual_gain,
            "payback_months": self.payback_months,
            "roi_12m": self.roi_12m,
            "roi_36m": self.roi_36m,
            "by_family": self.by_family,
        }


class MissingAssumption(KeyError):
    pass


def _get(values: dict[str, float], key: str) -> float:
    if key not in values:
        raise MissingAssumption(key)
    v = float(values[key])
    if math.isnan(v) or math.isinf(v):
        raise ValueError(f"invalid value for {key}")
    return v


def compute(
    lines: list[ValueLine],
    values: dict[str, float],
    project_cost_key: str = "project_cost",
    run_cost_key: str = "run_cost_month",
) -> ROIResult:
    hours_total = 0.0
    gross = 0.0
    by_family: dict[str, float] = {}
    detail = []
    for line in lines:
        product = line.scale
        for f in line.factors:
            product *= _get(values, f)
        if line.kind == "time":
            hours = product
            value = hours * _get(values, line.cost_key or "hourly_cost_mad") * 12
            hours_total += hours
        else:
            hours = 0.0
            value = product * line.annualize
        gross += value
        by_family[line.family] = by_family.get(line.family, 0.0) + value
        detail.append(
            {
                "key": line.key,
                "label": line.label,
                "kind": line.kind,
                "family": line.family,
                "hours_month": round(hours, 2),
                "annual_value": round(value, 2),
            }
        )
    project = _get(values, project_cost_key)
    run_year = _get(values, run_cost_key) * 12
    net = gross - run_year
    payback = round(project / (net / 12), 2) if net > 0 else None
    roi12 = round((net - project) / project, 4) if project > 0 else None
    roi36 = round((3 * net - project) / project, 4) if project > 0 else None
    return ROIResult(
        hours_saved_month=round(hours_total, 2),
        gross_annual_value=round(gross, 2),
        annual_solution_cost=round(run_year, 2),
        project_cost=round(project, 2),
        net_annual_gain=round(net, 2),
        payback_months=payback,
        roi_12m=roi12,
        roi_36m=roi36,
        by_family={k: round(v, 2) for k, v in by_family.items()},
        lines=detail,
    )


def lines_from_json(data: list[dict]) -> list[ValueLine]:
    return [
        ValueLine(
            d["key"],
            d["label"],
            d["kind"],
            tuple(d["factors"]),
            d.get("cost_key"),
            float(d.get("annualize", 12)),
            d.get("family", "cost"),
            float(d.get("scale", 1.0)),
        )
        for d in data
    ]


def lines_to_json(lines: list[ValueLine]) -> list[dict]:
    return [
        {
            "key": ln.key,
            "label": ln.label,
            "kind": ln.kind,
            "factors": list(ln.factors),
            "cost_key": ln.cost_key,
            "annualize": ln.annualize,
            "family": ln.family,
            "scale": ln.scale,
        }
        for ln in lines
    ]
