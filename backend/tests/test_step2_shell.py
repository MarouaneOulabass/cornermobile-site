from __future__ import annotations

from tests.conftest import login


def test_summary_is_available_for_every_member(client, seeded):
    atlas = seeded["atlaspro-distribution"]
    for email in ("consultant@auditflow.demo", "dirigeant@atlaspro.demo", "finance@atlaspro.demo"):
        headers = login(client, email)
        resp = client.get(f"/api/missions/{atlas.id}/summary", headers=headers)
        assert resp.status_code == 200
        body = resp.json()
        assert body["organization"] == "AtlasPro Distribution"
        assert "importez" in body["headline"]
        assert body["top_opportunities"] == [] and body["decision"] is None


def test_summary_is_tenant_scoped(client, seeded):
    headers = login(client, "dirigeant@darna.demo")
    atlas = seeded["atlaspro-distribution"]
    assert client.get(f"/api/missions/{atlas.id}/summary", headers=headers).status_code == 404


def test_create_org_and_mission_as_consultant(client, seeded):
    headers = login(client, "consultant@auditflow.demo")
    org = client.post("/api/orgs", json={"name": "Société Test Énergie", "city": "Tanger"}, headers=headers)
    assert org.status_code == 201
    assert org.json()["slug"] == "societe-test-energie"
    mission = client.post(
        f"/api/orgs/{org.json()['id']}/missions", json={"name": "Audit 2027"}, headers=headers
    )
    assert mission.status_code == 201
    assert len(mission.json()["interview_checklist"]) == 5
    names = [c["organization"]["name"] for c in client.get("/api/portfolio", headers=headers).json()]
    assert "Société Test Énergie" in names
    # A client executive cannot open new organizations.
    exec_headers = login(client, "dirigeant@atlaspro.demo")
    assert client.post("/api/orgs", json={"name": "Nope"}, headers=exec_headers).status_code == 403
