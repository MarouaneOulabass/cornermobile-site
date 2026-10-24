from __future__ import annotations

import csv
import statistics

import pytest
from sqlalchemy import select

from app.config import get_settings
from app.models import GraphEdge, GraphNode, Process
from app.services.pipeline import analyze_sync, import_folder_and_analyze
from tests.conftest import login

DEMO = get_settings().demo_data_dir


def demo_rows(company: str, name: str) -> list[dict]:
    with open(DEMO / company / "data" / name, encoding="utf-8-sig") as fh:
        return list(csv.DictReader(fh))


@pytest.fixture
def atlas(db, seeded):
    mission = seeded["atlaspro-distribution"]
    result = import_folder_and_analyze(db, mission, DEMO / "atlaspro-distribution")
    assert result["error"] is None
    return mission


def graph(client, mission, headers):
    g = client.get(f"/api/missions/{mission.id}/graph", headers=headers).json()
    nodes = {n["id"]: n for n in g["nodes"]}
    edges = [
        (nodes[e["source_id"]]["label"], e["relation"], nodes[e["target_id"]]["label"], e) for e in g["edges"]
    ]
    return nodes, edges


def test_graph_captures_the_business_relations(client, atlas):
    headers = login(client, "consultant@auditflow.demo")
    nodes, edges = graph(client, atlas, headers)
    kinds = {n["kind"] for n in nodes.values()}
    assert {"department", "tool", "process", "data", "contract", "sla", "kpi"} <= kinds

    triples = {(s, r, t) for s, r, t, _ in edges}
    # A team uses a tool (from employees.csv primary_tool).
    assert ("Commercial", "uses", "Excel") in triples or ("Commercial", "uses", "ERP") in triples
    # The same data lives in several systems (invoices.csv source column).
    assert {("Factures clients", "duplicated_in", t) for t in ("ERP", "Excel", "Email")} <= triples
    # A contract imposes an SLA, which applies to the support process.
    assert ("Contrat client 1", "imposes", "SLA 48 h") in triples
    assert ("SLA 48 h", "imposes", "Support client / SAV") in triples
    # Re-entry: quotes with manual re-entry.
    reentry = [e for s, r, t, e in edges if s == "Devis & commande" and r == "generates_reentry"]
    manual = sum(1 for r in demo_rows("atlaspro-distribution", "quotes.csv") if r["manual_reentry"] == "yes")
    assert reentry and reentry[0]["label"] == f"ressaisie sur {manual}/160"
    # Documented procedures require a validation step and generate a re-entry into the ERP.
    assert ("Validation des achats", "requires_validation", "Responsable validateur") in triples
    assert ("Validation des achats", "generates_reentry", "ERP") in triples
    # A KPI depends on the reporting process.
    assert ("Marge", "depends_on", "Reporting de direction") in triples


def test_edge_evidence_points_at_the_exact_rows(client, atlas):
    headers = login(client, "consultant@auditflow.demo")
    nodes, edges = graph(client, atlas, headers)
    employees = demo_rows("atlaspro-distribution", "employees.csv")
    for source, relation, target, edge in edges:
        if relation != "uses" or nodes[edge["source_id"]]["kind"] != "department":
            continue
        evidence = client.get(
            f"/api/missions/{atlas.id}/evidence",
            params={"target_type": "graph_edge", "target_id": edge["id"]},
            headers=headers,
        ).json()
        assert len(evidence) == 1 and evidence[0]["filename"] == "employees.csv"
        rows = evidence[0]["locator"]["rows"]
        assert len(rows) == int(edge["weight"])
        for n in rows:
            assert employees[n - 1]["department"] == source
        tools = {employees[n - 1]["primary_tool"] for n in rows}
        assert tools == {"Outlook"} if target == "Email" else tools == {target}


def test_processes_are_reconstructed_with_owners_tools_and_cycle_times(client, atlas):
    headers = login(client, "dirigeant@atlaspro.demo")
    procs = {p["name"]: p for p in client.get(f"/api/missions/{atlas.id}/processes", headers=headers).json()}
    quotes = procs["Devis & commande"]
    expected = statistics.median(
        float(r["prep_minutes"]) for r in demo_rows("atlaspro-distribution", "quotes.csv")
    )
    assert quotes["owner_department"] == "Commercial" and quotes["cycle_time_minutes"] == expected
    assert "Excel" in quotes["tools"] and quotes["evidence_count"] >= 1
    sav = procs["Support client / SAV"]
    assert set(sav["tools"]) == {"Email", "WhatsApp", "Téléphone", "Portail"}
    documented = procs["Validation des achats"]
    assert len(documented["steps"]) == 5 and documented["owner_defined"] is False
    assert any(s["is_reentry"] for s in documented["steps"])
    assert any(s["requires_validation"] for s in documented["steps"])


def test_graph_edits_survive_reanalysis(client, atlas, db):
    headers = login(client, "consultant@auditflow.demo")
    nodes, _ = graph(client, atlas, headers)
    by_label = {n["label"]: n for n in nodes.values()}
    created = client.post(
        f"/api/missions/{atlas.id}/graph/nodes",
        json={"kind": "tool", "label": "CRM Hubspot (prévu)"},
        headers=headers,
    ).json()
    edge = client.post(
        f"/api/missions/{atlas.id}/graph/edges",
        json={"source_id": by_label["Commercial"]["id"], "target_id": created["id"], "relation": "uses"},
        headers=headers,
    )
    assert edge.status_code == 201
    client.patch(
        f"/api/missions/{atlas.id}/graph/nodes/{by_label['ERP']['id']}",
        json={"label": "ERP Sage X3"},
        headers=headers,
    )
    assert (
        client.delete(
            f"/api/missions/{atlas.id}/graph/nodes/{by_label['Teams']['id']}", headers=headers
        ).status_code
        == 204
    )

    analyze_sync(db, atlas)
    nodes, edges = graph(client, atlas, headers)
    labels = {n["label"] for n in nodes.values()}
    assert "CRM Hubspot (prévu)" in labels and "ERP Sage X3" in labels and "ERP" not in labels
    assert "Teams" not in labels  # hidden by the consultant, stays hidden
    assert ("Commercial", "uses", "CRM Hubspot (prévu)") in {(s, r, t) for s, r, t, _ in edges}
    hidden = client.get(
        f"/api/missions/{atlas.id}/graph", params={"include_hidden": True}, headers=headers
    ).json()
    assert any(n["label"] == "Teams" and n["properties"]["hidden"] for n in hidden["nodes"])


def test_process_review_keeps_history_and_survives_reanalysis(client, atlas, db):
    headers = login(client, "consultant@auditflow.demo")
    proc = db.scalar(
        select(Process).where(Process.mission_id == atlas.id, Process.name == "Devis & commande")
    )
    resp = client.post(
        f"/api/missions/{atlas.id}/review/process/{proc.id}",
        json={"status": "valide", "comment": "Confirmé en entretien", "changes": {"owner_department": "ADV"}},
        headers=headers,
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "corrige"  # validated with a correction
    assert resp.json()["changes"] == {"owner_department": {"before": "Commercial", "after": "ADV"}}
    analyze_sync(db, atlas)
    db.expire_all()
    proc = db.get(Process, proc.id)
    assert proc.owner_department == "ADV" and proc.generated["owner_department"] == "Commercial"
    history = client.get(f"/api/missions/{atlas.id}/review/process/{proc.id}", headers=headers).json()
    assert history[0]["user_name"] == "Sara Consultante"
    bad = client.post(
        f"/api/missions/{atlas.id}/review/process/{proc.id}", json={"changes": {"id": "x"}}, headers=headers
    )
    assert bad.status_code == 422


def test_roles_on_analysis_endpoints(client, atlas, db, seeded):
    executive = login(client, "dirigeant@atlaspro.demo")
    assert client.post(f"/api/missions/{atlas.id}/analyze", headers=executive).status_code == 403
    node = db.scalar(select(GraphNode).where(GraphNode.mission_id == atlas.id))
    assert (
        client.patch(
            f"/api/missions/{atlas.id}/graph/nodes/{node.id}", json={"label": "x"}, headers=executive
        ).status_code
        == 403
    )
    proc = db.scalar(select(Process).where(Process.mission_id == atlas.id))
    assert (
        client.post(
            f"/api/missions/{atlas.id}/review/process/{proc.id}", json={"status": "valide"}, headers=executive
        ).status_code
        == 403
    )
    # Business owners may contest; it reopens the item for verification.
    finance = login(client, "finance@atlaspro.demo")
    c = client.post(
        f"/api/missions/{atlas.id}/comments",
        json={
            "target_type": "process",
            "target_id": str(proc.id),
            "body": "Le propriétaire est la DAF",
            "kind": "contestation",
        },
        headers=finance,
    )
    assert c.status_code == 201 and c.json()["user_name"] == "Responsable Finance AtlasPro"
    # Another tenant cannot touch AtlasPro graph items, even through its own mission.
    darna = seeded["darna-facility-services"]
    other = login(client, "dirigeant@darna.demo")
    assert client.get(f"/api/missions/{atlas.id}/graph", headers=other).status_code == 404
    consultant = login(client, "consultant@auditflow.demo")
    edge = db.scalar(select(GraphEdge).where(GraphEdge.mission_id == atlas.id))
    assert (
        client.delete(f"/api/missions/{darna.id}/graph/edges/{edge.id}", headers=consultant).status_code
        == 404
    )


@pytest.mark.parametrize(
    ("company", "expected_process", "multi_system_data"),
    [
        ("darna-facility-services", "Planification & interventions terrain", "Interventions"),
        ("maghrebpack-industries", "Ordonnancement & production", "Non-conformités"),
    ],
)
def test_graph_generalises_to_other_sectors(client, db, seeded, company, expected_process, multi_system_data):
    mission = seeded[company]
    assert import_folder_and_analyze(db, mission, DEMO / company)["error"] is None
    headers = login(client, "consultant@auditflow.demo")
    nodes, edges = graph(client, mission, headers)
    processes = {n["label"] for n in nodes.values() if n["kind"] == "process"}
    assert expected_process in processes
    duplicated = {t for s, r, t, _ in edges if s == multi_system_data and r == "duplicated_in"}
    assert len(duplicated) >= 2
