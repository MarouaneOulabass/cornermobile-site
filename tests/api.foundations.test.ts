import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, db, sql } from "@/server/db";
import type { MissionRow } from "@/server/rows";
import { seed } from "@/server/seed";
import { getStorage, missionPrefix } from "@/server/storage";
import { DEMO_PASSWORD, TestClient } from "./helpers/client";
import { resetDb } from "./helpers/db";

let client: TestClient;
let seeded: Record<string, MissionRow>;
beforeEach(async () => {
  await resetDb();
  seeded = await seed({ password: DEMO_PASSWORD });
  client = new TestClient();
});
afterAll(closePool);

describe("authentication", () => {
  it("logs in, answers /me and refuses a bad password", async () => {
    expect((await client.post("/api/auth/login", { email: "consultant@auditflow.demo", password: "nope" })).status).toBe(401);
    const headers = await client.login("consultant@auditflow.demo");
    const me = (await client.get("/api/auth/me", headers)).json();
    expect(me.user.email).toBe("consultant@auditflow.demo");
    expect(me.user).not.toHaveProperty("password_hash");
    expect(me.memberships).toHaveLength(3);
    expect((await client.get("/api/auth/me")).status).toBe(401);
  });

  it("requires the CSRF header for cookie-authenticated writes", async () => {
    const res = await client.post("/api/auth/login", { email: "consultant@auditflow.demo", password: DEMO_PASSWORD });
    expect(res.cookies.has("af_session")).toBe(true);
    const orgId = (await client.get("/api/portfolio")).json()[0].organization.id;
    expect((await client.post(`/api/orgs/${orgId}/missions`, { name: "Nouvelle mission" })).status).toBe(403);
    const ok = await client.post(`/api/orgs/${orgId}/missions`, { name: "Nouvelle mission" }, { "X-Requested-With": "auditflow" });
    expect(ok.status).toBe(201);
    expect((await client.post("/api/auth/logout", undefined, { "X-Requested-With": "auditflow" })).status).toBe(204);
    expect((await client.get("/api/portfolio")).status).toBe(401);
  });

  it("validates request bodies with the reference error shape", async () => {
    const res = await client.post("/api/auth/login", { email: "not-an-email" });
    expect(res.status).toBe(422);
    expect(res.json().detail[0].loc[0]).toBe("body");
  });

  it("sets security headers and answers unknown routes with 404", async () => {
    const res = await client.get("/api/health");
    expect(res.json()).toEqual({ status: "ok" });
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await client.get("/api/nope")).status).toBe(404);
    expect((await client.delete("/api/health")).status).toBe(405);
  });
});

describe("tenants and roles", () => {
  it("scopes the portfolio to memberships", async () => {
    const consultant = await client.login("consultant@auditflow.demo");
    const names = (await client.get("/api/portfolio", consultant)).json().map((c: { organization: { name: string } }) => c.organization.name);
    expect(names).toEqual(["AtlasPro Distribution", "Darna Facility Services", "MaghrebPack Industries"]);
    const executive = await client.login("dirigeant@atlaspro.demo");
    const cards = (await client.get("/api/portfolio", executive)).json();
    expect(cards.map((c: { organization: { name: string } }) => c.organization.name)).toEqual(["AtlasPro Distribution"]);
    expect(cards[0].role).toBe("executive");
    expect(cards[0].stats.documents).toBe(0);
  });

  it("never gives access across tenants", async () => {
    const executive = await client.login("dirigeant@atlaspro.demo");
    const darna = seeded["darna-facility-services"];
    const atlas = seeded["atlaspro-distribution"];
    expect((await client.get(`/api/missions/${darna.id}`, executive)).status).toBe(404);
    expect((await client.get(`/api/orgs/${darna.organization_id}`, executive)).status).toBe(404);
    expect((await client.get(`/api/orgs/${darna.organization_id}/missions`, executive)).status).toBe(404);
    expect((await client.get(`/api/missions/${darna.id}/summary`, executive)).status).toBe(404);
    expect((await client.get(`/api/missions/${atlas.id}`, executive)).status).toBe(200);
    expect((await client.get(`/api/missions/not-a-uuid`, executive)).status).toBe(404);
  });

  it("keeps client roles read-only", async () => {
    const atlas = seeded["atlaspro-distribution"];
    for (const email of ["dirigeant@atlaspro.demo", "finance@atlaspro.demo"]) {
      const headers = await client.login(email);
      expect((await client.patch(`/api/missions/${atlas.id}`, { name: "xxxxx" }, headers)).status).toBe(403);
      expect((await client.delete(`/api/missions/${atlas.id}`, headers)).status).toBe(403);
    }
  });

  it("patches a mission and deletes it completely (admin only)", async () => {
    const atlas = seeded["atlaspro-distribution"];
    const consultant = await client.login("consultant@auditflow.demo");
    const res = await client.patch(`/api/missions/${atlas.id}`, { parameters: { hourly_cost_mad: 200 } }, consultant);
    expect(res.status).toBe(200);
    expect(res.json().parameters.hourly_cost_mad).toBe(200);
    expect(res.json().parameters.systems.length).toBeGreaterThan(0);
    expect((await client.delete(`/api/missions/${atlas.id}`, consultant)).status).toBe(403);
    const key = `${missionPrefix(atlas.organization_id, atlas.id)}/original/test.txt`;
    await getStorage().put(key, new TextEncoder().encode("hello"));
    const admin = await client.login("admin@auditflow.demo");
    expect((await client.delete(`/api/missions/${atlas.id}`, admin)).status).toBe(204);
    expect(await getStorage().exists(key)).toBe(false);
    expect(await db.maybeOne(sql`SELECT id FROM audit_missions WHERE id = ${atlas.id}`)).toBeNull();
    expect((await client.get(`/api/missions/${atlas.id}`, admin)).status).toBe(404);
  });
});

describe("organizations and missions", () => {
  it("gives every member an executive summary", async () => {
    const atlas = seeded["atlaspro-distribution"];
    for (const email of ["consultant@auditflow.demo", "dirigeant@atlaspro.demo", "finance@atlaspro.demo"]) {
      const res = await client.get(`/api/missions/${atlas.id}/summary`, await client.login(email));
      expect(res.status).toBe(200);
      const body = res.json();
      expect(body.organization).toBe("AtlasPro Distribution");
      expect(body.headline).toContain("importez");
      expect(body.top_opportunities).toEqual([]);
      expect(body.decision).toBeNull();
    }
  });

  it("lets a consultant create an organization and a mission", async () => {
    const headers = await client.login("consultant@auditflow.demo");
    const org = await client.post("/api/orgs", { name: "Société Test Énergie", city: "Tanger" }, headers);
    expect(org.status).toBe(201);
    expect(org.json().slug).toBe("societe-test-energie");
    const again = await client.post("/api/orgs", { name: "Société Test Énergie" }, headers);
    expect(again.json().slug).toBe("societe-test-energie-2");
    const mission = await client.post(`/api/orgs/${org.json().id}/missions`, { name: "Audit 2027" }, headers);
    expect(mission.status).toBe(201);
    expect(mission.json().interview_checklist).toHaveLength(5);
    const names = (await client.get("/api/portfolio", headers)).json().map((c: { organization: { name: string } }) => c.organization.name);
    expect(names).toContain("Société Test Énergie");
    const executive = await client.login("dirigeant@atlaspro.demo");
    expect((await client.post("/api/orgs", { name: "Nope" }, executive)).status).toBe(403);
  });

  it("reserves the retention period to administrators", async () => {
    const orgId = seeded["atlaspro-distribution"].organization_id;
    const consultant = await client.login("consultant@auditflow.demo");
    expect((await client.patch(`/api/orgs/${orgId}`, { city: "Rabat" }, consultant)).json().city).toBe("Rabat");
    expect((await client.patch(`/api/orgs/${orgId}`, { retention_days: 30 }, consultant)).status).toBe(403);
    const admin = await client.login("admin@auditflow.demo");
    expect((await client.patch(`/api/orgs/${orgId}`, { retention_days: 30 }, admin)).json().retention_days).toBe(30);
  });

  it("overrides benchmarks per mission", async () => {
    const mission = seeded["atlaspro-distribution"];
    const headers = await client.login("consultant@auditflow.demo");
    const base = `/api/missions/${mission.id}/benchmarks`;
    const byKey = (rows: { key: string }[]) => Object.fromEntries(rows.map((b) => [b.key, b])) as unknown as Record<string, { value: number; default: number; overridden: boolean }>;
    const rows = byKey((await client.get(base, headers)).json());
    expect(rows.hourly_cost_mad.value).toBe(190);
    expect(rows.hourly_cost_mad.default).toBe(190);
    const updated = byKey((await client.put(base, { overrides: { hourly_cost_mad: 220 } }, headers)).json());
    expect(updated.hourly_cost_mad.value).toBe(220);
    expect(updated.hourly_cost_mad.overridden).toBe(true);
    expect((await client.get(`/api/missions/${mission.id}`, headers)).json().parameters.systems.length).toBeGreaterThan(0);
    const restored = byKey((await client.put(base, { overrides: { hourly_cost_mad: null } }, headers)).json());
    expect(restored.hourly_cost_mad.value).toBe(190);
    expect(restored.hourly_cost_mad.overridden).toBe(false);
    expect((await client.put(base, { overrides: { nope: 1 } }, headers)).status).toBe(422);
    expect((await client.put(base, { overrides: { cost_of_capital: -1 } }, headers)).status).toBe(422);
    const executive = await client.login("dirigeant@atlaspro.demo");
    expect((await client.put(base, { overrides: { hourly_cost_mad: 1 } }, executive)).status).toBe(403);
  });

  it("shows members to consultants only", async () => {
    const orgId = seeded["atlaspro-distribution"].organization_id;
    const members = (await client.get(`/api/orgs/${orgId}/members`, await client.login("consultant@auditflow.demo"))).json();
    const emails = members.map((m: { email: string }) => m.email);
    expect(emails).toEqual(expect.arrayContaining(["dirigeant@atlaspro.demo", "finance@atlaspro.demo"]));
    const finance = members.find((m: { email: string }) => m.email === "finance@atlaspro.demo");
    expect(finance.role).toBe("business_owner");
    expect(finance.department_scope).toBe("Finance");
    expect((await client.get(`/api/orgs/${orgId}/members`, await client.login("dirigeant@atlaspro.demo"))).status).toBe(403);
    expect((await client.get(`/api/orgs/${orgId}/members`, await client.login("dirigeant@darna.demo"))).status).toBe(404);
  });
});
