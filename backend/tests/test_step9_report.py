from __future__ import annotations

import re

import pytest

from app.config import get_settings
from app.services.pipeline import analyze_sync, import_folder_and_analyze
from app.services.report import _css_string
from tests.conftest import login

DEMO = get_settings().demo_data_dir


@pytest.fixture
def analyzed(db, seeded):
    def _run(company: str):
        mission = seeded[company]
        assert import_folder_and_analyze(db, mission, DEMO / company)["error"] is None
        return mission

    return _run


def test_report_html_traces_every_reference(client, analyzed):
    mission = analyzed("atlaspro-distribution")
    headers = login(client, "consultant@auditflow.demo")
    resp = client.get(f"/api/missions/{mission.id}/report/html", headers=headers)
    assert resp.status_code == 200
    assert "script-src" not in resp.headers["content-security-policy"]
    assert "default-src 'none'" in resp.headers["content-security-policy"]
    assert resp.headers["x-frame-options"] == "SAMEORIGIN"
    # Every other API response refuses framing.
    assert client.get(f"/api/missions/{mission.id}", headers=headers).headers["x-frame-options"] == "DENY"
    assert client.get("/api/health").headers["x-content-type-options"] == "nosniff"
    html = resp.text
    assert "AtlasPro Distribution" in html and "VERSION DE TRAVAIL" in html
    assert "<script" not in html.lower()
    # Every in-text reference resolves to an annex row, and annex numbering is contiguous.
    cited = {int(n) for n in re.findall(r'href="#E(\d+)"', html)}
    anchors = [int(n) for n in re.findall(r'id="E(\d+)"', html)]
    assert cited and cited == set(anchors) and anchors == list(range(1, len(anchors) + 1))
    for section in ("Synthèse exécutive", "Constats", "Business cases", "Roadmap", "Annexe A", "Annexe C"):
        assert section in html
    data = client.get(f"/api/missions/{mission.id}/report", headers=headers).json()
    assert data["figures"]["opportunities"] == len(data["cases"]) > 0
    assert {r["key"] for r in data["recommendations"]} >= {"summary", "decision"}
    # The figures in the summary are the ROI engine's, not re-derived text.
    opps = client.get(f"/api/missions/{mission.id}/opportunities", headers=headers).json()
    top = max(opps, key=lambda o: o["priority_score"])
    assert data["cases"][0]["id"] == top["id"]


def test_rejected_items_leave_the_report(client, analyzed):
    mission = analyzed("darna-facility-services")
    headers = login(client, "consultant@auditflow.demo")
    pain = client.get(f"/api/missions/{mission.id}/pain-points", headers=headers).json()[0]
    client.post(
        f"/api/missions/{mission.id}/review/pain_point/{pain['id']}",
        json={"status": "rejete", "comment": "Hors périmètre"},
        headers=headers,
    )
    data = client.get(f"/api/missions/{mission.id}/report", headers=headers).json()
    assert pain["title"] not in [f["title"] for f in data["findings"]]
    assert any(v["status"] == "Rejeté" for v in data["validations"])


def test_edited_recommendation_survives_reanalysis(client, analyzed, db):
    mission = analyzed("maghrebpack-industries")
    headers = login(client, "consultant@auditflow.demo")
    recs = client.get(f"/api/missions/{mission.id}/recommendations", headers=headers).json()
    decision = next(r for r in recs if r["generated"]["key"] == "decision")
    text = "Lancer le pilote maintenance prédictive sur la ligne 2 uniquement."
    assert (
        client.post(
            f"/api/missions/{mission.id}/review/recommendation/{decision['id']}",
            json={"changes": {"text": text}},
            headers=headers,
        ).status_code
        == 200
    )
    analyze_sync(db, mission)
    recs = client.get(f"/api/missions/{mission.id}/recommendations", headers=headers).json()
    again = next(r for r in recs if r["generated"]["key"] == "decision")
    assert again["id"] == decision["id"] and again["text"] == text and again["validation_status"] == "corrige"
    assert text in client.get(f"/api/missions/{mission.id}/report/html", headers=headers).text


def test_pdf_export(client, analyzed):
    mission = analyzed("atlaspro-distribution")
    headers = login(client, "consultant@auditflow.demo")
    created = client.post(f"/api/missions/{mission.id}/exports", json={"format": "pdf"}, headers=headers)
    assert created.status_code == 201, created.text
    export = created.json()
    assert export["published"] is False and export["size_bytes"] > 10_000
    resp = client.get(f"/api/missions/{mission.id}/exports/{export['id']}/download", headers=headers)
    assert resp.status_code == 200 and resp.content.startswith(b"%PDF")
    assert resp.headers["content-type"] == "application/pdf"
    assert "brouillon" in resp.headers["content-disposition"]
    assert [e["id"] for e in client.get(f"/api/missions/{mission.id}/exports", headers=headers).json()] == [
        export["id"]
    ]


def test_publication_flow_and_client_access(client, analyzed, db):
    mission = analyzed("atlaspro-distribution")
    consultant = login(client, "consultant@auditflow.demo")
    executive = login(client, "dirigeant@atlaspro.demo")
    base = f"/api/missions/{mission.id}"

    # Before publication the client has nothing to read or download, and cannot export.
    assert client.get(f"{base}/report/html", headers=executive).status_code == 404
    assert client.get(f"{base}/report", headers=executive).status_code == 403
    assert client.get(f"{base}/exports", headers=executive).json() == []
    assert client.post(f"{base}/exports", json={"format": "pdf"}, headers=executive).status_code == 403
    draft = client.post(f"{base}/exports", json={"format": "html"}, headers=consultant).json()
    assert client.get(f"{base}/exports/{draft['id']}/download", headers=executive).status_code == 404

    # Unreviewed items block publication unless explicitly acknowledged.
    check = client.get(f"{base}/publication", headers=consultant).json()
    assert check["analyzed"] and not check["ready"] and check["unreviewed"]["pain_points"] > 0
    blocked = client.post(f"{base}/publish", json={}, headers=consultant)
    assert blocked.status_code == 409 and blocked.json()["detail"]["unreviewed"] == check["unreviewed"]
    assert (
        client.post(f"{base}/publish", json={"acknowledge_unreviewed": True}, headers=executive).status_code
        == 403
    )
    published = client.post(f"{base}/publish", json={"acknowledge_unreviewed": True}, headers=consultant)
    assert published.status_code == 200
    assert {e["format"] for e in published.json()["exports"]} == {"html", "pdf"}

    # The client reads the frozen snapshot, without the draft watermark.
    snapshot = client.get(f"{base}/report/html", headers=executive)
    assert snapshot.status_code == 200 and "VERSION DE TRAVAIL" not in snapshot.text
    visible = client.get(f"{base}/exports", headers=executive).json()
    assert {e["format"] for e in visible} == {"html", "pdf"} and all(e["published"] for e in visible)
    pdf = next(e for e in visible if e["format"] == "pdf")
    assert client.get(f"{base}/exports/{pdf['id']}/download", headers=executive).content.startswith(b"%PDF")
    assert client.get(base, headers=executive).json()["status"] == "published"

    # A later consultant edit makes the live report a draft again; the client keeps the snapshot.
    opp = client.get(f"{base}/opportunities", headers=consultant).json()[0]
    client.post(
        f"{base}/review/opportunity/{opp['id']}",
        json={"changes": {"title": "Titre retravaillé"}},
        headers=consultant,
    )
    assert client.get(base, headers=consultant).json()["status"] == "review"
    assert "VERSION DE TRAVAIL" in client.get(f"{base}/report/html", headers=consultant).text
    assert client.get(f"{base}/report/html", headers=executive).text == snapshot.text

    # Unpublishing withdraws every client-visible export.
    assert client.post(f"{base}/unpublish", headers=consultant).status_code == 200
    assert client.get(f"{base}/report/html", headers=executive).status_code == 404
    assert client.get(f"{base}/exports", headers=executive).json() == []


def test_contestation_blocks_ready_until_reviewed(client, analyzed):
    mission = analyzed("darna-facility-services")
    consultant = login(client, "consultant@auditflow.demo")
    executive = login(client, "dirigeant@darna.demo")
    base = f"/api/missions/{mission.id}"
    pain = client.get(f"{base}/pain-points", headers=consultant).json()[0]
    client.post(
        f"{base}/comments",
        json={
            "target_type": "pain_point",
            "target_id": pain["id"],
            "kind": "contestation",
            "body": "Chiffre faux",
        },
        headers=executive,
    )
    assert client.get(f"{base}/publication", headers=consultant).json()["contested"] == 1
    client.post(f"{base}/review/pain_point/{pain['id']}", json={"status": "valide"}, headers=consultant)
    assert client.get(f"{base}/publication", headers=consultant).json()["contested"] == 0


def test_report_is_tenant_isolated(client, analyzed):
    atlas = analyzed("atlaspro-distribution")
    consultant = login(client, "consultant@auditflow.demo")
    export = client.post(
        f"/api/missions/{atlas.id}/exports", json={"format": "html"}, headers=consultant
    ).json()
    client.post(
        f"/api/missions/{atlas.id}/publish", json={"acknowledge_unreviewed": True}, headers=consultant
    )
    other = login(client, "dirigeant@darna.demo")
    for path in (
        "/report/html",
        "/report",
        "/exports",
        "/recommendations",
        f"/exports/{export['id']}/download",
    ):
        assert client.get(f"/api/missions/{atlas.id}{path}", headers=other).status_code == 404, path
    # An export id from another mission is refused even through a mission the caller can access.
    darna_mission = client.get("/api/portfolio", headers=other).json()[0]["mission"]["id"]
    assert (
        client.get(
            f"/api/missions/{darna_mission}/exports/{export['id']}/download", headers=other
        ).status_code
        == 404
    )


def test_css_string_escaping():
    assert _css_string('Acme "Group" \\ </style>') == 'Acme \\"Group\\" \\\\ \\3C /style>'
