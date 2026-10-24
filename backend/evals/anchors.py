"""Reference values recomputed from the raw CSV files with the standard library only.

This is a second, independent implementation of the key facts the engine reports: if the engine's
column mapping, filtering or arithmetic drifts, the two disagree. Each anchor names the engine
metric it checks by a fragment of its label.
"""

from __future__ import annotations

import csv
import statistics
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path


def rows(folder: Path, name: str) -> list[dict[str, str]]:
    with (folder / "data" / name).open(encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))


def num(value: str) -> float:
    return float(value) if value not in ("", None) else 0.0


def share(items: list, predicate: Callable[[dict], bool]) -> float:
    return sum(1 for r in items if predicate(r)) / len(items)


@dataclass(frozen=True)
class Anchor:
    label: str  # fragment of the engine metric label
    description: str  # how the reference is computed
    compute: Callable[[Path], float]
    tolerance: float = 0.005  # relative


def _overdue(folder: Path) -> list[dict]:
    return [r for r in rows(folder, "invoices.csv") if r["status"].upper() == "OVERDUE"]


INVOICES = [
    Anchor(
        "Montant des créances échues",
        "Σ amount_mad | status = OVERDUE",
        lambda f: sum(num(r["amount_mad"]) for r in _overdue(f)),
    ),
    Anchor(
        "Part des factures échues",
        "count(status = OVERDUE) / count(*)",
        lambda f: share(rows(f, "invoices.csv"), lambda r: r["status"].upper() == "OVERDUE"),
    ),
    Anchor(
        "Créances échues depuis 60 jours",
        "Σ amount_mad | OVERDUE et days_overdue ≥ 60",
        lambda f: sum(num(r["amount_mad"]) for r in _overdue(f) if num(r["days_overdue"]) >= 60),
    ),
]
TICKETS = [
    Anchor(
        "Canaux d'entrée",
        "count(distinct channel)",
        lambda f: len({r["channel"] for r in rows(f, "tickets.csv")}),
    ),
    Anchor(
        "Tickets avec historique manquant",
        "count(observed_issue = Missing history) / count(*)",
        lambda f: share(rows(f, "tickets.csv"), lambda r: r["observed_issue"] == "Missing history"),
    ),
    Anchor(
        "Délai médian de résolution",
        "median(resolution_hours)",
        lambda f: statistics.median(num(r["resolution_hours"]) for r in rows(f, "tickets.csv")),
    ),
]

ANCHORS: dict[str, list[Anchor]] = {
    "atlaspro-distribution": [
        Anchor(
            "Part de devis ressaisis",
            "count(manual_reentry = yes) / count(*)",
            lambda f: share(rows(f, "quotes.csv"), lambda r: r["manual_reentry"].lower() == "yes"),
        ),
        Anchor(
            "Modèles différents",
            "count(distinct template_used)",
            lambda f: len({r["template_used"] for r in rows(f, "quotes.csv")}),
        ),
        Anchor(
            "Temps médian de préparation",
            "median(prep_minutes)",
            lambda f: statistics.median(num(r["prep_minutes"]) for r in rows(f, "quotes.csv")),
        ),
        Anchor(
            "Valeur du stock dormant",
            "Σ stock_value_mad | days_since_last_sale ≥ 180",
            lambda f: sum(
                num(r["stock_value_mad"])
                for r in rows(f, "inventory.csv")
                if num(r["days_since_last_sale"]) >= 180
            ),
        ),
        Anchor(
            "Taux de transformation",
            "count(Won) / count(Won ∪ Lost)",
            lambda f: share(
                [r for r in rows(f, "quotes.csv") if r["status"] in ("Won", "Lost")],
                lambda r: r["status"] == "Won",
            ),
        ),
        *INVOICES,
        *TICKETS,
    ],
    "darna-facility-services": [
        Anchor(
            "Part des interventions hors SLA",
            "count(sla_breached = yes) / count(*)",
            lambda f: share(rows(f, "interventions.csv"), lambda r: r["sla_breached"].lower() == "yes"),
        ),
        Anchor(
            "Dépassement moyen",
            "mean(actual − sla | sla_breached = yes)",
            lambda f: statistics.mean(
                num(r["actual_resolution_hours"]) - num(r["sla_hours"])
                for r in rows(f, "interventions.csv")
                if r["sla_breached"].lower() == "yes"
            ),
        ),
        Anchor(
            "Part planifiée hors outil",
            "count(planning_source ∈ {Excel, WhatsApp, Phone}) / count(*)",
            lambda f: share(
                rows(f, "interventions.csv"), lambda r: r["planning_source"] in ("Excel", "WhatsApp", "Phone")
            ),
        ),
        Anchor(
            "Part des achats urgents",
            "count(urgent_purchase = yes) / count(*)",
            lambda f: share(rows(f, "purchases.csv"), lambda r: r["urgent_purchase"].lower() == "yes"),
        ),
        Anchor(
            "Surcoût moyen des achats urgents",
            "mean(price_premium_pct | urgent)",
            lambda f: statistics.mean(
                num(r["price_premium_pct"])
                for r in rows(f, "purchases.csv")
                if r["urgent_purchase"].lower() == "yes"
            ),
        ),
        Anchor(
            "Factures établies hors ERP",
            "count(source ≠ ERP) / count(*)",
            lambda f: share(rows(f, "invoices.csv"), lambda r: r["source"] != "ERP"),
        ),
        *INVOICES,
        *TICKETS,
    ],
    "maghrebpack-industries": [
        Anchor(
            "Pannes sans cause racine",
            "count(root_cause_known = no) / count(*)",
            lambda f: share(rows(f, "maintenance.csv"), lambda r: r["root_cause_known"].lower() == "no"),
        ),
        Anchor(
            "Heures d'arrêt totales",
            "Σ downtime_hours",
            lambda f: sum(num(r["downtime_hours"]) for r in rows(f, "maintenance.csv")),
        ),
        Anchor(
            "Non-conformités répétées",
            "count(repeat_within_90d = yes) / count(*)",
            lambda f: share(
                rows(f, "non_conformities.csv"), lambda r: r["repeat_within_90d"].lower() == "yes"
            ),
        ),
        Anchor(
            "Replanifications moyennes",
            "mean(replans)",
            lambda f: statistics.mean(num(r["replans"]) for r in rows(f, "production_orders.csv")),
        ),
        Anchor(
            "Dérive des temps réels",
            "(Σ actual_hours − Σ planned_hours) / Σ planned_hours",
            lambda f: (
                (
                    sum(num(r["actual_hours"]) for r in rows(f, "production_orders.csv"))
                    - sum(num(r["planned_hours"]) for r in rows(f, "production_orders.csv"))
                )
                / sum(num(r["planned_hours"]) for r in rows(f, "production_orders.csv"))
            ),
        ),
        Anchor(
            "Taux de rebut matière moyen",
            "mean(material_waste_pct)",
            lambda f: statistics.mean(num(r["material_waste_pct"]) for r in rows(f, "production_orders.csv")),
        ),
        *INVOICES,
        *TICKETS,
    ],
}
