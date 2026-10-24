from __future__ import annotations

import csv
import statistics

import pytest
from sqlalchemy import select

from app.config import get_settings
from app.models import PainPoint
from app.services.pipeline import analyze_sync, import_folder_and_analyze
from tests.conftest import login

DEMO = get_settings().demo_data_dir


def rows(company: str, name: str) -> list[dict]:
    with open(DEMO / company / "data" / name, encoding="utf-8-sig") as fh:
        return list(csv.DictReader(fh))


@pytest.fixture
def analyzed(db, seeded):
    def _run(company: str):
        mission = seeded[company]
        assert import_folder_and_analyze(db, mission, DEMO / company)["error"] is None
        return mission

    return _run


def by_code(client, mission, headers) -> dict[str, dict]:
    return {
        p["code"]: p for p in client.get(f"/api/missions/{mission.id}/pain-points", headers=headers).json()
    }


def metric(pp: dict, key: str) -> float:
    return next(m["value"] for m in pp["metrics"] if m["key"] == key)


def test_atlaspro_metrics_match_the_raw_data(client, analyzed):
    mission = analyzed("atlaspro-distribution")
    pps = by_code(client, mission, login(client, "consultant@auditflow.demo"))

    quotes = rows("atlaspro-distribution", "quotes.csv")
    manual = [q for q in quotes if q["manual_reentry"] == "yes"]
    pp = pps["manual_entry:quotes"]
    assert metric(pp, "manual_rate") == round(len(manual) / len(quotes), 4)
    assert metric(pp, "templates") == len({q["template_used"] for q in quotes})
    assert metric(pp, "median_minutes") == statistics.median(float(q["prep_minutes"]) for q in quotes)
    assert pp["type"] == "double_saisie" and pp["department"] == "Commercial"

    invoices = rows("atlaspro-distribution", "invoices.csv")
    overdue = [i for i in invoices if i["status"] == "OVERDUE"]
    rec = pps["finance:receivables"]
    assert metric(rec, "overdue_amount") == round(sum(float(i["amount_mad"]) for i in overdue))
    assert metric(rec, "overdue_share") == round(len(overdue) / len(invoices), 4)
    assert rec["impact_mad_per_year"] == round(sum(float(i["amount_mad"]) for i in overdue) * 0.08)

    inventory = rows("atlaspro-distribution", "inventory.csv")
    dormant = [r for r in inventory if float(r["days_since_last_sale"]) >= 180]
    stock = pps["inventory:dormant_stock"]
    assert metric(stock, "dormant_value") == round(sum(float(r["stock_value_mad"]) for r in dormant))

    tickets = rows("atlaspro-distribution", "tickets.csv")
    sav = pps["support:dispersion"]
    assert metric(sav, "channels") == len({t["channel"] for t in tickets})
    missing = [t for t in tickets if t["observed_issue"] == "Missing history"]
    assert metric(sav, "missing_history_share") == round(len(missing) / len(tickets), 4)
    assert "reporting:manual" in pps


def test_darna_and_maghrebpack_metrics(client, analyzed):
    headers = login(client, "consultant@auditflow.demo")
    darna = by_code(client, analyzed("darna-facility-services"), headers)
    interventions = rows("darna-facility-services", "interventions.csv")
    breached = [r for r in interventions if r["sla_breached"] == "yes"]
    assert metric(darna["sla:breaches"], "breach_rate") == round(len(breached) / len(interventions), 4)
    purchases = rows("darna-facility-services", "purchases.csv")
    urgent = [p for p in purchases if p["urgent_purchase"] == "yes"]
    assert metric(darna["procurement:urgent"], "urgent_share") == round(len(urgent) / len(purchases), 4)
    assert metric(darna["procurement:urgent"], "urgent_premium") == round(
        statistics.fmean(float(p["price_premium_pct"]) for p in urgent), 2
    )
    assert {"planning:manual", "operations:field_reports", "finance:invoicing_delay"} <= set(darna)

    maghreb = by_code(client, analyzed("maghrebpack-industries"), headers)
    maintenance = rows("maghrebpack-industries", "maintenance.csv")
    unknown = [m for m in maintenance if m["root_cause_known"] == "no"]
    assert metric(maghreb["maintenance:knowledge"], "unknown_cause_share") == round(
        len(unknown) / len(maintenance), 4
    )
    ncs = rows("maghrebpack-industries", "non_conformities.csv")
    assert metric(maghreb["quality:recurrence"], "repeat_share") == round(
        sum(n["repeat_within_90d"] == "yes" for n in ncs) / len(ncs), 4
    )
    orders = rows("maghrebpack-industries", "production_orders.csv")
    assert metric(maghreb["production:instability"], "mean_replans") == round(
        statistics.fmean(float(o["replans"]) for o in orders), 2
    )
    assert metric(maghreb["production:material_waste"], "waste_mean") == round(
        statistics.fmean(float(o["material_waste_pct"]) for o in orders), 2
    )
    # No forecast data in the sources: the forecasting issue is a flagged hypothesis, not a fact.
    forecast = maghreb["sales:forecast_gap"]
    assert forecast["is_hypothesis"] is True and forecast["confidence"] <= 0.4


def test_every_fact_is_backed_by_evidence_whose_rows_hold(client, analyzed):
    mission = analyzed("atlaspro-distribution")
    headers = login(client, "consultant@auditflow.demo")
    for pp in by_code(client, mission, headers).values():
        evidence = client.get(
            f"/api/missions/{mission.id}/evidence",
            params={"target_type": "pain_point", "target_id": pp["id"]},
            headers=headers,
        ).json()
        assert pp["is_hypothesis"] or evidence, pp["title"]
        assert pp["evidence_count"] == len(evidence)
    # Cited rows really satisfy the claim (spot-check on manual re-entry and overdue invoices).
    pps = by_code(client, mission, headers)
    quotes = rows("atlaspro-distribution", "quotes.csv")
    ev = client.get(
        f"/api/missions/{mission.id}/evidence",
        params={"target_type": "pain_point", "target_id": pps["manual_entry:quotes"]["id"]},
        headers=headers,
    ).json()
    cited = next(e for e in ev if e["kind"] == "rows" and e["filename"] == "quotes.csv")
    assert cited["locator"]["columns"] == ["manual_reentry"]
    assert all(quotes[n - 1]["manual_reentry"] == "yes" for n in cited["locator"]["rows"])
    assert len(cited["locator"]["rows"]) == sum(q["manual_reentry"] == "yes" for q in quotes)


def test_criticality_is_calibrated_per_mission(client, analyzed):
    headers = login(client, "consultant@auditflow.demo")
    for company in ("atlaspro-distribution", "darna-facility-services", "maghrebpack-industries"):
        pps = list(by_code(client, analyzed(company), headers).values())
        critical = [p for p in pps if p["criticality"] == "critique"]
        assert 1 <= len(critical) <= round(0.35 * len(pps)) + 1
        assert not any(p["is_hypothesis"] for p in critical)


def test_business_owner_sees_only_their_department_and_rejections_are_hidden(client, analyzed, db):
    mission = analyzed("atlaspro-distribution")
    finance = login(client, "finance@atlaspro.demo")
    pps = client.get(f"/api/missions/{mission.id}/pain-points", headers=finance).json()
    assert pps and {p["department"] for p in pps} == {"Finance"}

    consultant = login(client, "consultant@auditflow.demo")
    target = by_code(client, mission, consultant)["governance:procedures"]
    client.post(
        f"/api/missions/{mission.id}/review/pain_point/{target['id']}",
        json={"status": "rejete", "comment": "Hors périmètre"},
        headers=consultant,
    )
    executive = login(client, "dirigeant@atlaspro.demo")
    codes = {
        p["code"] for p in client.get(f"/api/missions/{mission.id}/pain-points", headers=executive).json()
    }
    assert "governance:procedures" not in codes
    assert "governance:procedures" in {
        p["code"] for p in client.get(f"/api/missions/{mission.id}/pain-points", headers=consultant).json()
    }


def test_reviewed_pain_points_survive_reanalysis(client, analyzed, db):
    mission = analyzed("atlaspro-distribution")
    consultant = login(client, "consultant@auditflow.demo")
    pp = by_code(client, mission, consultant)["manual_entry:quotes"]
    resp = client.post(
        f"/api/missions/{mission.id}/review/pain_point/{pp['id']}",
        json={
            "status": "valide",
            "changes": {"title": "Devis : 4 modèles Excel et ressaisie catalogue", "criticality": "elevee"},
        },
        headers=consultant,
    )
    assert resp.json()["status"] == "corrige"
    analyze_sync(db, mission)
    db.expire_all()
    stored = db.scalar(
        select(PainPoint).where(PainPoint.mission_id == mission.id, PainPoint.code == "manual_entry:quotes")
    )
    assert stored.id.hex == pp["id"].replace("-", "")
    assert stored.title == "Devis : 4 modèles Excel et ressaisie catalogue" and stored.criticality == "elevee"
    assert stored.generated["title"].startswith("Devis préparés manuellement")
    assert stored.validation_status == "corrige"
    # Evidence is regenerated and still attached after the re-run.
    ev = client.get(
        f"/api/missions/{mission.id}/evidence",
        params={"target_type": "pain_point", "target_id": pp["id"]},
        headers=consultant,
    ).json()
    assert ev


def test_filters_and_risks(client, analyzed):
    mission = analyzed("darna-facility-services")
    headers = login(client, "consultant@auditflow.demo")
    crit = client.get(
        f"/api/missions/{mission.id}/pain-points", params={"criticality": "critique"}, headers=headers
    ).json()
    assert crit and all(p["criticality"] == "critique" for p in crit)
    sla = client.get(
        f"/api/missions/{mission.id}/pain-points", params={"type": "non_respect_sla"}, headers=headers
    ).json()
    assert [p["code"] for p in sla] == ["sla:breaches"]
    risks = client.get(f"/api/missions/{mission.id}/risks", headers=headers).json()
    contractual = next(r for r in risks if r["kind"] == "contractuel")
    assert contractual["exposure_mad_per_year"] == sla[0]["impact_mad_per_year"] > 0
