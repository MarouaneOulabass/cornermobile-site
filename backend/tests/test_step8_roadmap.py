from __future__ import annotations

import pytest

from app.config import get_settings
from app.engine.roadmap import PHASE_WEEKS, phase_for_week
from app.services.pipeline import analyze_sync, import_folder_and_analyze
from tests.conftest import login

DEMO = get_settings().demo_data_dir


@pytest.fixture
def analyzed(db, seeded):
    def _run(company: str):
        mission = seeded[company]
        assert import_folder_and_analyze(db, mission, DEMO / company)["error"] is None
        return mission

    return _run


def roadmap(client, mission, headers) -> dict:
    return client.get(f"/api/missions/{mission.id}/roadmap", headers=headers).json()


@pytest.mark.parametrize(
    "company", ["atlaspro-distribution", "darna-facility-services", "maghrebpack-industries"]
)
def test_roadmap_structure(client, analyzed, company):
    mission = analyzed(company)
    headers = login(client, "consultant@auditflow.demo")
    data = roadmap(client, mission, headers)
    items = data["items"]
    assert [p["key"] for p in data["phases"]] == ["j30", "j60", "j90", "t2", "t3", "t4"]
    by_key = {i["generated"]["key"]: i for i in items}
    assert "socle:governance" in by_key
    for item in items:
        assert item["phase"] == phase_for_week(item["start_week"])
    # Quick wins start first, pilots in days 30-60 or later, deployments after their pilot.
    assert all(i["phase"] in ("j30", "j60", "j90") for i in items if i["kind"] == "quick_win")
    pilots = [i for i in items if i["kind"] == "pilote"]
    assert pilots and all(i["start_week"] >= 4 for i in pilots)
    starts_per_phase = {}
    for p in pilots:
        if not p["depends_on"]:
            starts_per_phase[p["phase"]] = starts_per_phase.get(p["phase"], 0) + 1
    assert max(starts_per_phase.values()) <= 2
    for item in items:
        for dep in item["depends_on"]:
            prereq = by_key[dep]
            assert item["start_week"] > prereq["start_week"] + prereq["duration_weeks"] - 1
    # Every non-rejected opportunity appears on the roadmap.
    opps = client.get(f"/api/missions/{mission.id}/opportunities", headers=headers).json()
    assert {o["id"] for o in opps} <= {i["opportunity_id"] for i in items}
    assert sum(data["value_by_phase"].values()) > 0


def test_invoicing_waits_for_structured_field_reports(client, analyzed):
    mission = analyzed("darna-facility-services")
    items = {
        i["generated"]["key"]: i
        for i in roadmap(client, mission, login(client, "consultant@auditflow.demo"))["items"]
    }
    invoicing = next(i for k, i in items.items() if k.startswith("opp:invoicing_flow"))
    reports = next(i for k, i in items.items() if k.startswith("opp:field_reports"))
    assert invoicing["start_week"] > reports["start_week"] + reports["duration_weeks"] - 1


def test_moving_items_is_traced_and_survives_reanalysis(client, analyzed, db):
    mission = analyzed("atlaspro-distribution")
    headers = login(client, "consultant@auditflow.demo")
    item = next(i for i in roadmap(client, mission, headers)["items"] if i["kind"] == "quick_win")
    resp = client.post(
        f"/api/missions/{mission.id}/review/roadmap_item/{item['id']}",
        json={"changes": {"phase": "j60"}},
        headers=headers,
    )
    assert resp.status_code == 200
    assert resp.json()["changes"]["start_week"]["after"] == PHASE_WEEKS["j60"][0]
    analyze_sync(db, mission)
    moved = next(i for i in roadmap(client, mission, headers)["items"] if i["id"] == item["id"])
    assert moved["phase"] == "j60" and moved["start_week"] == 4 and moved["validation_status"] == "corrige"
    bad = client.post(
        f"/api/missions/{mission.id}/review/roadmap_item/{item['id']}",
        json={"changes": {"phase": "j365"}},
        headers=headers,
    )
    assert bad.status_code == 422


def test_custom_items(client, analyzed):
    mission = analyzed("maghrebpack-industries")
    headers = login(client, "consultant@auditflow.demo")
    created = client.post(
        f"/api/missions/{mission.id}/roadmap",
        json={
            "title": "Atelier de cadrage avec la production",
            "phase": "j30",
            "duration_weeks": 1,
            "owner": "COO",
        },
        headers=headers,
    )
    assert created.status_code == 201 and created.json()["start_week"] == 0
    generated = next(i for i in roadmap(client, mission, headers)["items"] if i["generated"].get("key"))
    assert (
        client.delete(f"/api/missions/{mission.id}/roadmap/{generated['id']}", headers=headers).status_code
        == 409
    )
    assert (
        client.delete(
            f"/api/missions/{mission.id}/roadmap/{created.json()['id']}", headers=headers
        ).status_code
        == 204
    )
    executive = login(client, "dirigeant@maghrebpack.demo")
    assert (
        client.post(
            f"/api/missions/{mission.id}/roadmap", json={"title": "Nope nope"}, headers=executive
        ).status_code
        == 403
    )
    assert roadmap(client, mission, executive)["items"]
