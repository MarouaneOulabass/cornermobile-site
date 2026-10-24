import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, db, sql, transaction } from "@/server/db";
import { seed } from "@/server/seed";
import { hashPassword, redact, signSession, verifyPassword, verifySession } from "@/server/security";
import { readCsv, sniff } from "@/server/lib/csv";
import { resetDb } from "./helpers/db";

beforeEach(resetDb);
afterAll(closePool);

describe("database layer", () => {
  it("parameterises values, json and fragments", async () => {
    const row = await db.one<{ a: number; b: string; c: unknown }>(sql`SELECT ${41}::int + 1 AS a, ${"x'; DROP TABLE users; --"}::text AS b, ${sql.json([1, { k: "v" }])}::jsonb AS c`);
    expect(row).toEqual({ a: 42, b: "x'; DROP TABLE users; --", c: [1, { k: "v" }] });
    const parts = [sql`1`, sql`${2}`, sql`3`];
    expect(await db.one(sql`SELECT ARRAY[${sql.join(parts)}]::int[] AS v`)).toEqual({ v: [1, 2, 3] });
  });

  it("rolls back a failed transaction", async () => {
    await expect(
      transaction(async (tx) => {
        await tx.exec(sql`INSERT INTO organizations (name, slug) VALUES ('A', 'a')`);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await db.query(sql`SELECT * FROM organizations`)).toEqual([]);
  });

  it("bulk inserts through jsonb_to_recordset", async () => {
    const rows = await db.insertMany<{ slug: string }>("organizations", { name: "text", slug: "text", employees: "integer" }, [
      { name: "A", slug: "a", employees: 3 },
      { name: "B", slug: "b" },
    ]);
    expect(rows.map((r) => r.slug)).toEqual(["a", "b"]);
  });
});

describe("seed", () => {
  it("creates the three demo companies, missions and accounts, idempotently", async () => {
    const missions = await seed({ password: "demo-test" });
    await seed({ password: "demo-test" });
    expect(Object.keys(missions).sort()).toEqual(["atlaspro-distribution", "darna-facility-services", "maghrebpack-industries"]);
    const orgs = await db.query<{ name: string; employees: number; revenue_mad: number }>(sql`SELECT name, employees, revenue_mad FROM organizations ORDER BY name`);
    expect(orgs.map((o) => o.name)).toEqual(["AtlasPro Distribution", "Darna Facility Services", "MaghrebPack Industries"]);
    expect(orgs[0].employees).toBe(86);
    const consultant = await db.one<{ n: number }>(sql`SELECT count(*)::int AS n FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = 'consultant@auditflow.demo'`);
    expect(consultant.n).toBe(3);
    const finance = await db.one<{ role: string; department_scope: string }>(sql`SELECT role, department_scope FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = 'finance@atlaspro.demo'`);
    expect(finance).toEqual({ role: "business_owner", department_scope: "Finance" });
    const mission = Object.values(missions)[0];
    expect(mission.objectives.length).toBeGreaterThan(0);
    expect((mission.parameters as { systems: string[] }).systems.length).toBeGreaterThan(0);
    expect(mission.interview_checklist).toHaveLength(5);
  });
});

describe("security helpers", () => {
  it("hashes passwords and signs sessions", () => {
    const hash = hashPassword("secret");
    expect(verifyPassword("secret", hash)).toBe(true);
    expect(verifyPassword("other", hash)).toBe(false);
    const secret = "s".repeat(40);
    const token = signSession("user-1", secret);
    expect(verifySession(token, secret)).toBe("user-1");
    expect(verifySession(token, "t".repeat(40))).toBeNull();
    expect(verifySession(`${token}x`, secret)).toBeNull();
    expect(verifySession(signSession("user-1", secret, -10), secret)).toBeNull();
  });

  it("masks personal data", () => {
    expect(redact("Écrire à karim.alami@atlaspro.ma ou au 06 61 23 45 67")).toBe("Écrire à [email] ou au [tel]");
  });
});

describe("csv", () => {
  it("follows Python's csv semantics", () => {
    expect(readCsv('a,b,c\n1,"x, y",3\n\n"q""uote",,\n')).toEqual([["a", "b", "c"], ["1", "x, y", "3"], [], ['q"uote', "", ""]]);
    expect(sniff("a;b;c\n1;2;3\n4;5;6\n").delimiter).toBe(";");
    expect(sniff("a,b\n1,2\n").delimiter).toBe(",");
  });
});
