from __future__ import annotations

import pytest

from app.engine.roi import MissingAssumption, ValueLine, compute, lines_from_json, lines_to_json

LINES = [
    ValueLine(
        "time",
        "Temps de préparation",
        "time",
        ("volume", "minutes_h", "automation", "adoption"),
        "hourly_cost_mad",
    ),
    ValueLine(
        "cash",
        "Coût de financement évité",
        "product",
        ("overdue", "reduction", "coc"),
        annualize=1,
        family="cost",
    ),
]
VALUES = {
    "volume": 180,
    "minutes_h": 36 / 60,
    "automation": 0.65,
    "adoption": 1.0,
    "hourly_cost_mad": 190,
    "overdue": 1_000_000,
    "reduction": 0.25,
    "coc": 0.08,
    "project_cost": 120_000,
    "run_cost_month": 2_000,
}


def test_mockup_example_is_reproduced():
    # Mockup: 180 devis/mois × 36 min × 65 % × 190 MAD/h → 70 h/mois, 159 600 MAD/an.
    r = compute(LINES[:1], VALUES)
    assert r.hours_saved_month == pytest.approx(70.2)
    assert r.gross_annual_value == pytest.approx(70.2 * 190 * 12)


def test_indicators():
    r = compute(LINES, VALUES)
    gross = 70.2 * 190 * 12 + 1_000_000 * 0.25 * 0.08
    assert r.gross_annual_value == pytest.approx(gross)
    assert r.annual_solution_cost == 24_000
    assert r.net_annual_gain == pytest.approx(gross - 24_000)
    assert r.payback_months == pytest.approx(round(120_000 / ((gross - 24_000) / 12), 2))
    assert r.roi_12m == pytest.approx(round((gross - 24_000 - 120_000) / 120_000, 4))
    assert r.roi_36m == pytest.approx(round((3 * (gross - 24_000) - 120_000) / 120_000, 4))
    assert set(r.by_family) == {"cost"}


def test_deterministic_and_sensitive_to_hourly_cost():
    a = compute(LINES, VALUES)
    b = compute(LINES, VALUES)
    assert a.as_dict() == b.as_dict()
    cheaper = compute(LINES, {**VALUES, "hourly_cost_mad": 150})
    assert cheaper.gross_annual_value < a.gross_annual_value
    assert cheaper.gross_annual_value == pytest.approx(a.gross_annual_value - 70.2 * 40 * 12)


def test_no_payback_when_net_gain_is_negative():
    r = compute(LINES[:1], {**VALUES, "volume": 1, "run_cost_month": 10_000})
    assert r.net_annual_gain < 0 and r.payback_months is None


def test_missing_assumption_is_explicit():
    with pytest.raises(MissingAssumption):
        compute(LINES, {k: v for k, v in VALUES.items() if k != "coc"})


def test_lines_roundtrip():
    assert lines_from_json(lines_to_json(LINES)) == LINES
