from __future__ import annotations

import pytest

from app.config import get_settings
from app.domain.enums import AI_CATEGORIES
from app.engine.opportunities import choose_category
from app.engine.scoring import DEFAULT_PENALTIES, DEFAULT_WEIGHTS, priority
from app.services.pipeline import analyze_sync, import_folder_and_analyze
from tests.conftest import login

DEMO = get_settings().demo_data_dir
COMPANIES = ("atlaspro-distribution", "darna-facility-services", "maghrebpack-industries")


@pytest.fixture
def analyzed(db, seeded):
    def _run(company: str):
        mission = seeded[company]
        assert import_folder_and_analyze(db, mission, DEMO / company)["error"] is None
        return mission

    return _run


def opps(client, mission, headers, **params) -> list[dict]:
    return client.get(f"/api/missions/{mission.id}/opportunities", params=params, headers=headers).json()


def test_no_ai_when_simple_automation_suffices():
    assert choose_category("assistant_ia", unstructured=False)[0] == "automatisation"
    assert choose_category("rag", unstructured=False, fallback="bi_data")[0] == "bi_data"
    assert choose_category("prediction_optimisation")[0] == "automatisation"
    assert choose_category("assistant_ia", unstructured=True)[0] == "assistant_ia"
    assert choose_category("prediction_optimisation", optimisation=True)[0] == "prediction_optimisation"


@pytest.mark.parametrize("company", COMPANIES)
def test_opportunities_are_scored_costed_and_traceable(client, analyzed, company):
    mission = analyzed(company)
    headers = login(client, "consultant@auditflow.demo")
    items = opps(client, mission, headers)
    assert len(items) >= 5
    assert any(o["priority_label"] == "P1" for o in items)
    for o in items:
        assert set(o["scores"]) == {
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
        }
        assert all(0 <= v <= 100 for v in o["scores"].values())
        assert o["priority_score"] == priority(o["scores"], DEFAULT_WEIGHTS, DEFAULT_PENALTIES)
        assert o["pain_points"], "every opportunity answers at least one pain point"
        assert o["roi"]["gross_annual_value"] > 0
        assert o["category_rationale"]
        detail = client.get(f"/api/missions/{mission.id}/opportunities/{o['id']}", headers=headers).json()
        for a in detail["assumptions"]:
            assert a["nature"] in ("fait", "calcul", "hypothese") and a["source"]
        # The stored results are exactly what the deterministic engine recomputes.
        sim = client.post(
            f"/api/missions/{mission.id}/opportunities/{o['id']}/simulate",
            json={"overrides": {}},
            headers=headers,
        ).json()
        assert sim["results"]["gross_annual_value"] == o["roi"]["gross_annual_value"]
        assert sim["priority_score"] == o["priority_score"]
        if o["category"] in AI_CATEGORIES:
            assert "justifiée" in o["category_rationale"]


def test_expected_opportunities_for_atlaspro(client, analyzed):
    mission = analyzed("atlaspro-distribution")
    titles = {o["title"]: o for o in opps(client, mission, login(client, "consultant@auditflow.demo"))}
    assert "Copilote de devis" in titles and titles["Copilote de devis"]["category"] == "assistant_ia"
    assert titles["Copilote de devis"]["effort"] == "faible"
    # Receivables prioritisation is rules + workflow: structured data, so no AI.
    relances = next(o for t, o in titles.items() if t.startswith("Priorisation des relances"))
    assert relances["category"] == "automatisation"
    assert any(t.startswith("Détection du stock dormant") for t in titles)
    assert "Reporting direction automatisé" in titles and "Assistant SAV omnicanal" in titles


def test_simulation_recalculates_live_without_saving(client, analyzed, db):
    mission = analyzed("atlaspro-distribution")
    headers = login(client, "consultant@auditflow.demo")
    copilot = next(o for o in opps(client, mission, headers) if o["title"] == "Copilote de devis")
    detail = client.get(f"/api/missions/{mission.id}/opportunities/{copilot['id']}", headers=headers).json()
    hours = detail["roi"]["hours_saved_month"]
    sim = client.post(
        f"/api/missions/{mission.id}/opportunities/{copilot['id']}/simulate",
        json={"overrides": {"hourly_cost_mad": 250}},
        headers=headers,
    ).json()
    assert sim["results"]["gross_annual_value"] == pytest.approx(hours * 250 * 12, rel=1e-3)
    again = client.get(f"/api/missions/{mission.id}/opportunities/{copilot['id']}", headers=headers).json()
    assert again["roi"]["gross_annual_value"] == detail["roi"]["gross_annual_value"]
    bad = client.post(
        f"/api/missions/{mission.id}/opportunities/{copilot['id']}/simulate",
        json={"overrides": {"hourly_cost_mad": "x"}},
        headers=headers,
    )
    assert bad.status_code == 422


def test_editing_an_assumption_is_traced_recomputed_and_kept(client, analyzed, db):
    mission = analyzed("atlaspro-distribution")
    headers = login(client, "consultant@auditflow.demo")
    copilot = next(o for o in opps(client, mission, headers) if o["title"] == "Copilote de devis")
    detail = client.get(f"/api/missions/{mission.id}/opportunities/{copilot['id']}", headers=headers).json()
    hourly = next(a for a in detail["assumptions"] if a["key"] == "hourly_cost_mad")
    out_of_bounds = client.post(
        f"/api/missions/{mission.id}/review/assumption/{hourly['id']}",
        json={"changes": {"value": 5}},
        headers=headers,
    )
    assert out_of_bounds.status_code == 422
    resp = client.post(
        f"/api/missions/{mission.id}/review/assumption/{hourly['id']}",
        json={"changes": {"value": 220, "nature": "fait"}, "comment": "Grille DRH 2026"},
        headers=headers,
    )
    assert resp.status_code == 200 and resp.json()["changes"]["value"] == {"before": 190.0, "after": 220.0}
    updated = client.get(f"/api/missions/{mission.id}/opportunities/{copilot['id']}", headers=headers).json()
    assert updated["roi"]["gross_annual_value"] == pytest.approx(
        detail["roi"]["hours_saved_month"] * 220 * 12, rel=1e-3
    )
    analyze_sync(db, mission)
    kept = client.get(f"/api/missions/{mission.id}/opportunities/{copilot['id']}", headers=headers).json()
    a = next(x for x in kept["assumptions"] if x["key"] == "hourly_cost_mad")
    assert (
        a["value"] == 220
        and a["default_value"] == 190
        and a["nature"] == "fait"
        and a["validation_status"] == "corrige"
    )
    assert kept["roi"]["gross_annual_value"] == updated["roi"]["gross_annual_value"]


def test_scoring_is_stable_and_configurable(client, analyzed, db):
    mission = analyzed("darna-facility-services")
    headers = login(client, "consultant@auditflow.demo")
    before = {
        o["code"]: (o["priority_score"], o["roi"]["gross_annual_value"])
        for o in opps(client, mission, headers)
    }
    analyze_sync(db, mission)
    after = {
        o["code"]: (o["priority_score"], o["roi"]["gross_annual_value"])
        for o in opps(client, mission, headers)
    }
    assert before == after  # deterministic re-analysis

    assert (
        client.put(
            f"/api/missions/{mission.id}/scoring-model",
            json={"weights": {"time_saved": 0.6}, "penalties": {}},
            headers=headers,
        ).status_code
        == 403
    )
    admin = login(client, "admin@auditflow.demo")
    resp = client.put(
        f"/api/missions/{mission.id}/scoring-model",
        json={"weights": {**DEFAULT_WEIGHTS, "time_saved": 0.6}, "penalties": DEFAULT_PENALTIES},
        headers=admin,
    )
    assert resp.status_code == 200 and resp.json()["weights"]["time_saved"] == 0.6
    reweighted = {o["code"]: o for o in opps(client, mission, headers)}
    for o in reweighted.values():
        assert o["priority_score"] == priority(
            o["scores"], {**DEFAULT_WEIGHTS, "time_saved": 0.6}, DEFAULT_PENALTIES
        )
    assert (
        client.put(
            f"/api/missions/{mission.id}/scoring-model",
            json={"weights": {"magic": 1}, "penalties": {}},
            headers=admin,
        ).status_code
        == 422
    )


def test_rejected_opportunities_leave_the_ranking(client, analyzed, db):
    mission = analyzed("maghrebpack-industries")
    headers = login(client, "consultant@auditflow.demo")
    items = opps(client, mission, headers)
    worst = items[-1]
    client.post(
        f"/api/missions/{mission.id}/review/opportunity/{worst['id']}",
        json={"status": "rejete"},
        headers=headers,
    )
    after = {o["id"]: o for o in opps(client, mission, headers)}
    assert after[worst["id"]]["priority_label"] is None and after[worst["id"]]["priority_rank"] is None
    executive = login(client, "dirigeant@maghrebpack.demo")
    assert worst["id"] not in {o["id"] for o in opps(client, mission, executive)}


def test_overview_has_maturity_completeness_quick_wins_and_risks(client, analyzed):
    mission = analyzed("atlaspro-distribution")
    data = client.get(
        f"/api/missions/{mission.id}/overview", headers=login(client, "dirigeant@atlaspro.demo")
    ).json()
    assert [m["key"] for m in data["maturity"]] == ["processus", "donnees", "automatisation", "tracabilite"]
    assert all(0 <= m["value"] <= 1 and m["explanation"] for m in data["maturity"])
    assert data["completeness"]["score"] > 0.5 and data["completeness"]["gaps"]
    assert data["top_opportunities"] and all(o["effort"] == "faible" for o in data["quick_wins"])
    assert data["risks"]


def test_sorting(client, analyzed):
    mission = analyzed("atlaspro-distribution")
    headers = login(client, "consultant@auditflow.demo")
    by_value = [o["roi"]["gross_annual_value"] for o in opps(client, mission, headers, sort="value")]
    assert by_value == sorted(by_value, reverse=True)
    by_payback = [o["roi"]["payback_months"] or 1e9 for o in opps(client, mission, headers, sort="payback")]
    assert by_payback == sorted(by_payback)
