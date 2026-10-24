"""Answer key access. Nothing under `app/` may import this module."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class PlantedIssue:
    title: str
    description: str
    domain: str
    severity: str


@dataclass(frozen=True)
class ExpectedOpportunity:
    title: str
    annual_value_mad: float
    effort: str


@dataclass(frozen=True)
class GroundTruth:
    company: str
    issues: list[PlantedIssue]
    opportunities: list[ExpectedOpportunity]


def load(folder: Path) -> GroundTruth:
    data = json.loads((folder / "ground_truth.json").read_text(encoding="utf-8"))
    return GroundTruth(
        company=data["company"],
        issues=[
            PlantedIssue(i["title"], i["description"], i["domain"], i["severity"])
            for i in data["planted_issues"]
        ],
        opportunities=[
            ExpectedOpportunity(o["title"], float(o["annual_value_mad"]), o["effort"])
            for o in data["expected_opportunities"]
        ],
    )
