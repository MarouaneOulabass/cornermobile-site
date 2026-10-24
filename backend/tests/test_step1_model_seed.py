from __future__ import annotations

import logging

from sqlalchemy import func, select

from app.config import get_settings
from app.models import AuditMission, Membership, Organization, User
from app.security import RedactingFilter, redact
from app.seed import load_profiles, seed
from app.services.storage import get_storage, mission_prefix
from tests.conftest import DEMO_PASSWORD, login


def test_profiles_are_parsed_from_demo_data():
    profiles = {p.slug: p for p in load_profiles(get_settings().demo_data_dir)}
    assert set(profiles) == {"atlaspro-distribution", "darna-facility-services", "maghrebpack-industries"}
    atlas = profiles["atlaspro-distribution"]
    assert atlas.name == "AtlasPro Distribution"
    assert atlas.employees == 86 and atlas.revenue_mad == 118_000_000 and atlas.city == "Casablanca"
    assert any("marge opérationnelle" in o for o in atlas.objectives)
    assert "Microsoft 365" in atlas.systems


def test_seed_creates_three_tenants_and_is_idempotent(db):
    seed(db, password=DEMO_PASSWORD)
    seed(db, password=DEMO_PASSWORD)
    assert db.scalar(select(func.count()).select_from(Organization)) == 3
    assert db.scalar(select(func.count()).select_from(AuditMission)) == 3
    consultant = db.scalar(select(User).where(User.email == "consultant@auditflow.demo"))
    assert len(consultant.memberships) == 3
    exec_atlas = db.scalar(select(User).where(User.email == "dirigeant@atlaspro.demo"))
    assert [m.organization.slug for m in exec_atlas.memberships] == ["atlaspro-distribution"]
    finance = db.scalar(select(Membership).join(User).where(User.email == "finance@atlaspro.demo"))
    assert finance.role == "business_owner" and finance.department_scope == "Finance"
    mission = db.scalar(select(AuditMission))
    assert len(mission.interview_checklist) >= 5 and mission.objectives


def test_login_me_and_bad_password(client, seeded):
    bad = client.post("/api/auth/login", json={"email": "consultant@auditflow.demo", "password": "nope"})
    assert bad.status_code == 401
    headers = login(client, "consultant@auditflow.demo")
    me = client.get("/api/auth/me", headers=headers).json()
    assert me["user"]["email"] == "consultant@auditflow.demo"
    assert len(me["memberships"]) == 3
    assert client.get("/api/auth/me").status_code == 401


def test_cookie_session_requires_csrf_header_for_writes(client, seeded):
    resp = client.post(
        "/api/auth/login", json={"email": "consultant@auditflow.demo", "password": DEMO_PASSWORD}
    )
    assert "af_session" in resp.cookies
    org_id = client.get("/api/portfolio").json()[0]["organization"]["id"]
    blocked = client.post(f"/api/orgs/{org_id}/missions", json={"name": "Nouvelle mission"})
    assert blocked.status_code == 403
    ok = client.post(
        f"/api/orgs/{org_id}/missions",
        json={"name": "Nouvelle mission"},
        headers={"X-Requested-With": "auditflow"},
    )
    assert ok.status_code == 201


def test_portfolio_is_scoped_to_memberships(client, seeded):
    consultant = login(client, "consultant@auditflow.demo")
    names = [c["organization"]["name"] for c in client.get("/api/portfolio", headers=consultant).json()]
    assert names == ["AtlasPro Distribution", "Darna Facility Services", "MaghrebPack Industries"]

    executive = login(client, "dirigeant@atlaspro.demo")
    cards = client.get("/api/portfolio", headers=executive).json()
    assert [c["organization"]["name"] for c in cards] == ["AtlasPro Distribution"]
    assert cards[0]["role"] == "executive"


def test_no_cross_tenant_access(client, seeded):
    executive = login(client, "dirigeant@atlaspro.demo")
    darna = seeded["darna-facility-services"]
    atlas = seeded["atlaspro-distribution"]
    assert client.get(f"/api/missions/{darna.id}", headers=executive).status_code == 404
    assert client.get(f"/api/orgs/{darna.organization_id}", headers=executive).status_code == 404
    assert client.get(f"/api/orgs/{darna.organization_id}/missions", headers=executive).status_code == 404
    assert client.get(f"/api/missions/{atlas.id}", headers=executive).status_code == 200


def test_client_roles_are_read_only(client, seeded):
    atlas = seeded["atlaspro-distribution"]
    for email in ("dirigeant@atlaspro.demo", "finance@atlaspro.demo"):
        headers = login(client, email)
        assert (
            client.patch(f"/api/missions/{atlas.id}", json={"name": "x" * 5}, headers=headers).status_code
            == 403
        )
        assert client.delete(f"/api/missions/{atlas.id}", headers=headers).status_code == 403


def test_mission_patch_and_complete_deletion(client, seeded, db):
    atlas = seeded["atlaspro-distribution"]
    atlas_id = atlas.id
    consultant = login(client, "consultant@auditflow.demo")
    resp = client.patch(
        f"/api/missions/{atlas.id}", json={"parameters": {"hourly_cost_mad": 200}}, headers=consultant
    )
    assert resp.status_code == 200 and resp.json()["parameters"]["hourly_cost_mad"] == 200
    # Only an admin can delete; deletion also wipes stored files.
    assert client.delete(f"/api/missions/{atlas.id}", headers=consultant).status_code == 403
    key = f"{mission_prefix(atlas.organization_id, atlas.id)}/original/test.txt"
    get_storage().put(key, b"hello")
    admin = login(client, "admin@auditflow.demo")
    assert client.delete(f"/api/missions/{atlas_id}", headers=admin).status_code == 204
    assert not get_storage().exists(key)
    db.expunge_all()
    assert db.get(AuditMission, atlas_id) is None
    assert client.get(f"/api/missions/{atlas_id}", headers=admin).status_code == 404


def test_redaction_masks_sensitive_values():
    text = "Contact collaborateur12@demo.ma ou +212 6 12 34 56 78 / 06 12 34 56 78, IBAN MA64 0115 1900 0001 2050 0053 4921"
    masked = redact(text)
    assert "demo.ma" not in masked and "56 78" not in masked and "MA64" not in masked
    assert "[email]" in masked and "[tel]" in masked


def test_logging_filter_redacts(caplog):
    logger = logging.getLogger("auditflow.test")
    logger.addFilter(RedactingFilter())
    with caplog.at_level(logging.INFO, logger="auditflow.test"):
        logger.info("envoi à %s", "client@exemple.ma")
    assert "client@exemple.ma" not in caplog.text and "[email]" in caplog.text
