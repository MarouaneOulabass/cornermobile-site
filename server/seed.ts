/** Seed the three demo companies (spec §14) with their missions and demo users. */
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { db as defaultDb, sql, type Db } from "./db";
import { env } from "./env";
import { readCsvDicts } from "./lib/csv";
import { splitlines } from "./lib/py";
import type { MissionRow, OrganizationRow, UserRow } from "./rows";
import { hashPassword } from "./security";
import { defaultChecklist } from "./services/missions";

export interface CompanyProfile {
  slug: string;
  name: string;
  sector: string;
  city: string;
  employees: number;
  revenueMad: number;
  description: string;
  objectives: string[];
  systems: string[];
  folder: string;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function section(markdown: string, heading: string): string[] {
  const match = new RegExp(`^## ${escapeRegExp(heading)}\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m").exec(markdown);
  if (!match) return [];
  return splitlines(match[1].trim())
    .map((l) => l.trim())
    .filter(Boolean);
}

function bullets(markdown: string, heading: string): string[] {
  return section(markdown, heading)
    .filter((l) => l.startsWith("-"))
    .map((l) => l.replace(/^[- ]+/, "").trim());
}

export async function loadProfiles(demoDir: string): Promise<CompanyProfile[]> {
  const byName = new Map(
    readCsvDicts((await readFile(path.join(demoDir, "companies.csv"), "utf8")).replace(/^﻿/, "").replace(/\r\n?/g, "\n")).map((r) => [r.name, r]),
  );
  const profiles: CompanyProfile[] = [];
  for (const entry of (await readdir(demoDir)).sort()) {
    const folder = path.join(demoDir, entry);
    const profilePath = path.join(folder, "company_profile.md");
    try {
      await stat(profilePath);
    } catch {
      continue;
    }
    const md = await readFile(profilePath, "utf8");
    const name = splitlines(md)[0].replace(/^[# ]+/, "").trim();
    const row = byName.get(name) ?? {};
    profiles.push({
      slug: entry,
      name,
      sector: row.sector ?? "",
      city: row.city ?? "",
      employees: Number(row.employees || 0),
      revenueMad: Number(row.revenue_mad || 0),
      description: section(md, "Présentation").join(" "),
      objectives: bullets(md, "Objectifs de la direction"),
      systems: bullets(md, "Systèmes existants"),
      folder,
    });
  }
  return profiles;
}

export function demoPassword(): string {
  const pw = env().AUDITFLOW_DEMO_PASSWORD;
  if (pw) return pw;
  if (process.env.NODE_ENV === "production" && env().VERCEL === "1") {
    throw new Error("AUDITFLOW_DEMO_PASSWORD must be set to seed demo users in a deployed environment");
  }
  return "demo-auditflow";
}

type Grant = [role: string, scope: string | null];
// email, full name, platform admin, {org slug: grant} — "*" means every demo org.
export const DEMO_USERS: [string, string, boolean, Record<string, Grant>][] = [
  ["admin@auditflow.demo", "Admin AuditFlow", true, {}],
  ["consultant@auditflow.demo", "Sara Consultante", false, { "*": ["consultant", null] }],
  ["dirigeant@atlaspro.demo", "Direction AtlasPro", false, { "atlaspro-distribution": ["executive", null] }],
  ["finance@atlaspro.demo", "Responsable Finance AtlasPro", false, { "atlaspro-distribution": ["business_owner", "Finance"] }],
  ["dirigeant@darna.demo", "Direction Darna", false, { "darna-facility-services": ["executive", null] }],
  ["dirigeant@maghrebpack.demo", "Direction MaghrebPack", false, { "maghrebpack-industries": ["executive", null] }],
];

export async function seed(options: { demoDir?: string; password?: string; tx?: Db } = {}): Promise<Record<string, MissionRow>> {
  const tx = options.tx ?? defaultDb;
  const demoDir = options.demoDir ?? env().AUDITFLOW_DEMO_DATA_DIR;
  const pwHash = hashPassword(options.password ?? demoPassword());
  const missions: Record<string, MissionRow> = {};
  const orgs: Record<string, OrganizationRow> = {};
  for (const p of await loadProfiles(demoDir)) {
    const org = await tx.one<OrganizationRow>(sql`
      INSERT INTO organizations (slug, name, sector, city, employees, revenue_mad, description)
      VALUES (${p.slug}, ${p.name}, ${p.sector}, ${p.city}, ${p.employees}, ${p.revenueMad}, ${p.description})
      ON CONFLICT (slug) DO UPDATE SET sector = EXCLUDED.sector, city = EXCLUDED.city, employees = EXCLUDED.employees,
        revenue_mad = EXCLUDED.revenue_mad, description = EXCLUDED.description
      RETURNING *`);
    orgs[p.slug] = org;
    let mission = await tx.maybeOne<MissionRow>(sql`SELECT * FROM audit_missions WHERE organization_id = ${org.id} ORDER BY created_at LIMIT 1`);
    if (!mission) {
      mission = await tx.one<MissionRow>(sql`
        INSERT INTO audit_missions (organization_id, name, objectives, scope, interview_checklist, parameters)
        VALUES (${org.id}, 'Audit IA & Performance 2026', ${sql.json(p.objectives)},
          ${sql.json(["Processus cœur", "Finance", "Relation client", "Outils & données"])},
          ${sql.json(defaultChecklist())}, ${sql.json({ systems: p.systems })})
        RETURNING *`);
    }
    missions[p.slug] = mission;
  }
  for (const [email, fullName, isAdmin, grants] of DEMO_USERS) {
    let user = await tx.maybeOne<UserRow>(sql`SELECT * FROM users WHERE email = ${email}`);
    if (!user) {
      user = await tx.one<UserRow>(sql`
        INSERT INTO users (external_id, email, full_name, password_hash, is_platform_admin)
        VALUES (${`dev:${email}`}, ${email}, ${fullName}, ${pwHash}, ${isAdmin}) RETURNING *`);
    }
    const targets = "*" in grants ? Object.entries(orgs) : Object.keys(grants).filter((s) => s in orgs).map((s) => [s, orgs[s]] as const);
    for (const [slug, org] of targets) {
      const [role, scope] = grants["*"] ?? grants[slug];
      await tx.exec(sql`
        INSERT INTO memberships (user_id, organization_id, role, department_scope)
        VALUES (${user.id}, ${org.id}, ${role}, ${scope})
        ON CONFLICT (user_id, organization_id) DO NOTHING`);
    }
  }
  return missions;
}
