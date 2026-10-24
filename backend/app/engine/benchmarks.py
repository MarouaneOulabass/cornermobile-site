"""Benchmarks used when the sources do not give a value.

Every benchmark is a *hypothesis*: it is always shown as such, carries its rationale, and can be
overridden per mission (`mission.parameters`) or edited on each business case.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Benchmark:
    key: str
    value: float
    unit: str
    label: str
    rationale: str


BENCHMARKS: dict[str, Benchmark] = {
    b.key: b
    for b in [
        Benchmark(
            "hourly_cost_mad",
            190,
            "MAD/h",
            "Coût horaire chargé",
            "Coût moyen chargé d'un employé administratif au Maroc (hypothèse à confirmer avec la DRH).",
        ),
        Benchmark(
            "cost_of_capital",
            0.08,
            "/an",
            "Coût du capital",
            "Taux de financement court terme d'une PME marocaine (hypothèse à valider avec la DAF).",
        ),
        Benchmark(
            "stock_holding_rate",
            0.20,
            "/an",
            "Coût de détention du stock",
            "Stockage, obsolescence et immobilisation : 15-25 % de la valeur par an (benchmark distribution).",
        ),
        Benchmark(
            "dormant_days",
            180,
            "jours",
            "Seuil de stock dormant",
            "Référence sans vente depuis plus de 6 mois.",
        ),
        Benchmark(
            "procedure_max_age_months",
            24,
            "mois",
            "Ancienneté maximale d'une procédure",
            "Une procédure non revue depuis 2 ans est considérée obsolète.",
        ),
        Benchmark(
            "waste_target_pct",
            3.0,
            "%",
            "Taux de rebut matière cible",
            "Niveau atteignable pour l'impression/découpe carton (benchmark à valider avec la production).",
        ),
        Benchmark(
            "overrun_tolerance",
            0.10,
            "",
            "Tolérance de dépassement des temps",
            "Écart réel/prévu toléré avant de parler de dérive.",
        ),
        Benchmark("working_days_month", 21, "jours", "Jours ouvrés par mois", "Calendrier standard."),
    ]
}


def bench(key: str, overrides: dict | None = None) -> float:
    if overrides and key in overrides and overrides[key] is not None:
        return float(overrides[key])
    return BENCHMARKS[key].value
