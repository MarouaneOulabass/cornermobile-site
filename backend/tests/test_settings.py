from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from app.models import AuditLog, AuditMission
from app.services.retention import purge
from tests.conftest import login


def test_benchmark_overrides(client, seeded):
    mission = seeded["atlaspro-distribution"]
    headers = login(client, "consultant@auditflow.demo")
    base = f"/api/missions/{mission.id}/benchmarks"
    rows = {b["key"]: b for b in client.get(base, headers=headers).json()}
    assert rows["hourly_cost_mad"]["value"] == rows["hourly_cost_mad"]["default"] == 190
    resp = client.put(base, json={"overrides": {"hourly_cost_mad": 220}}, headers=headers)
    assert resp.status_code == 200
    updated = {b["key"]: b for b in resp.json()}
    assert updated["hourly_cost_mad"]["value"] == 220 and updated["hourly_cost_mad"]["overridden"]
    # Other mission parameters are kept; null restores the default.
    assert client.get(f"/api/missions/{mission.id}", headers=headers).json()["parameters"]["systems"]
    restored = {
        b["key"]: b
        for b in client.put(base, json={"overrides": {"hourly_cost_mad": None}}, headers=headers).json()
    }
    assert restored["hourly_cost_mad"]["value"] == 190 and not restored["hourly_cost_mad"]["overridden"]
    assert client.put(base, json={"overrides": {"nope": 1}}, headers=headers).status_code == 422
    assert client.put(base, json={"overrides": {"cost_of_capital": -1}}, headers=headers).status_code == 422
    executive = login(client, "dirigeant@atlaspro.demo")
    assert client.put(base, json={"overrides": {"hourly_cost_mad": 1}}, headers=executive).status_code == 403


def test_members_are_visible_to_consultants_only(client, seeded):
    org_id = seeded["atlaspro-distribution"].organization_id
    members = client.get(
        f"/api/orgs/{org_id}/members", headers=login(client, "consultant@auditflow.demo")
    ).json()
    assert {m["email"] for m in members} >= {"dirigeant@atlaspro.demo", "finance@atlaspro.demo"}
    finance = next(m for m in members if m["email"] == "finance@atlaspro.demo")
    assert finance["role"] == "business_owner" and finance["department_scope"] == "Finance"
    assert (
        client.get(
            f"/api/orgs/{org_id}/members", headers=login(client, "dirigeant@atlaspro.demo")
        ).status_code
        == 403
    )
    assert (
        client.get(f"/api/orgs/{org_id}/members", headers=login(client, "dirigeant@darna.demo")).status_code
        == 404
    )


def test_retention_purges_idle_missions_only(db, seeded):
    atlas, darna = seeded["atlaspro-distribution"], seeded["darna-facility-services"]
    atlas.organization.retention_days = 30
    db.commit()
    later = datetime.now(UTC) + timedelta(days=31)
    assert purge(db, dry_run=True, now=later) == [str(atlas.id)]
    assert db.get(AuditMission, atlas.id) is not None  # a dry run deletes nothing
    assert purge(db, now=later) == [str(atlas.id)]  # darna keeps the 365-day default
    assert db.get(AuditMission, atlas.id) is None and db.get(AuditMission, darna.id) is not None
    assert db.scalar(select(AuditLog).where(AuditLog.action == "mission.retention_purge")) is not None
