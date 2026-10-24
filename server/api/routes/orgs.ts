/** Portfolio (screen 1), client organizations, their missions and members. */
import { record } from "../../audit";
import { orgContext } from "../../auth/context";
import { requireUser } from "../../auth/session";
import { db, sql, transaction } from "../../db";
import { Role } from "../../domain/enums";
import { clerkEnabled } from "../../env";
import { body, HttpError } from "../../http";
import { sortedBy } from "../../lib/py";
import type { MissionRow, OrganizationRow } from "../../rows";
import { defaultChecklist, emptyStats, latestMission, missionStats } from "../../services/missions";
import { slugify } from "../../slug";
import type { Router } from "../router";
import { MISSION_OUT, MissionIn, ORGANIZATION_OUT, OrganizationIn, OrganizationPatch, pick } from "../schemas";

export function register(r: Router): void {
  /** Screen 1: every organization the user can see, with the state of its latest mission. */
  r.get("/portfolio", async (req) => {
    const user = await requireUser(req);
    if (clerkEnabled()) {
      const { syncMemberships } = await import("../../auth/clerk");
      await syncMemberships(user);
    }
    let rows: [OrganizationRow, string][];
    if (user.is_platform_admin) {
      rows = (await db.query<OrganizationRow>(sql`SELECT * FROM organizations`)).map((o) => [o, Role.admin]);
    } else {
      rows = (
        await db.query<OrganizationRow & { member_role: string }>(sql`
          SELECT o.*, m.role AS member_role FROM memberships m JOIN organizations o ON o.id = m.organization_id WHERE m.user_id = ${user.id}`)
      ).map((o) => [o, o.member_role]);
    }
    const cards = [];
    for (const [org, role] of sortedBy(rows, ([o]) => o.name)) {
      const mission = await latestMission(org.id);
      cards.push({
        organization: pick(org, ORGANIZATION_OUT),
        mission: mission ? pick(mission, MISSION_OUT) : null,
        stats: mission ? await missionStats(mission) : emptyStats(),
        role,
      });
    }
    return cards;
  });

  /** Consultants open a new client organization; they become its first consultant member. */
  r.post(
    "/orgs",
    async (req) => {
      const user = await requireUser(req);
      const input = await body(req, OrganizationIn);
      const roles = await db.query<{ role: string }>(sql`SELECT role FROM memberships WHERE user_id = ${user.id}`);
      const isConsultant = user.is_platform_admin || roles.some((m) => m.role === Role.consultant || m.role === Role.admin);
      if (!isConsultant) throw new HttpError(403, "Action réservée aux consultants");
      const clerkOrgId = clerkEnabled() ? await (await import("../../auth/clerk")).createClerkOrganization(input.name, user) : null;
      return transaction(async (tx) => {
        const base = slugify(input.name);
        let slug = base;
        for (let i = 2; await tx.maybeOne(sql`SELECT id FROM organizations WHERE slug = ${slug}`); i++) slug = `${base}-${i}`;
        const org = await tx.one<OrganizationRow>(sql`
          INSERT INTO organizations (name, slug, clerk_org_id, sector, city, employees, revenue_mad, description)
          VALUES (${input.name}, ${slug}, ${clerkOrgId}, ${input.sector ?? null}, ${input.city ?? null}, ${input.employees ?? null},
            ${input.revenue_mad ?? null}, ${input.description ?? null})
          RETURNING *`);
        if (!user.is_platform_admin) {
          await tx.exec(sql`INSERT INTO memberships (user_id, organization_id, role) VALUES (${user.id}, ${org.id}, ${Role.consultant})`);
        }
        await record("org.create", { userId: user.id, organizationId: org.id, entityType: "organization", entityId: org.id }, tx);
        return pick(org, ORGANIZATION_OUT);
      });
    },
    201,
  );

  r.get("/orgs/:orgId", async (req, p) => pick((await orgContext(req, p.orgId)).organization, ORGANIZATION_OUT));

  r.patch("/orgs/:orgId", async (req, p) => {
    const ctx = await orgContext(req, p.orgId);
    ctx.requireWrite();
    const changes = await body(req, OrganizationPatch);
    const fields = Object.keys(changes).sort();
    if ("retention_days" in changes) ctx.requireAdmin();
    return transaction(async (tx) => {
      const org = fields.length
        ? await tx.one<OrganizationRow>(sql`
            UPDATE organizations SET ${sql.join(fields.map((k) => sql`${sql.raw(k)} = ${(changes as Record<string, unknown>)[k] ?? null}`))}
            WHERE id = ${ctx.orgId} RETURNING *`)
        : ctx.organization;
      await record("org.update", { userId: ctx.user.id, organizationId: org.id, entityType: "organization", entityId: org.id, details: { fields } }, tx);
      return pick(org, ORGANIZATION_OUT);
    });
  });

  r.get("/orgs/:orgId/missions", async (req, p) => {
    const ctx = await orgContext(req, p.orgId);
    const rows = await db.query<MissionRow>(sql`SELECT * FROM audit_missions WHERE organization_id = ${ctx.orgId} ORDER BY created_at DESC, id`);
    return rows.map((m) => pick(m, MISSION_OUT));
  });

  r.post(
    "/orgs/:orgId/missions",
    async (req, p) => {
      const ctx = await orgContext(req, p.orgId);
      ctx.requireWrite();
      const input = await body(req, MissionIn);
      const checklist = input.interview_checklist?.length ? input.interview_checklist : defaultChecklist();
      return transaction(async (tx) => {
        const mission = await tx.one<MissionRow>(sql`
          INSERT INTO audit_missions (organization_id, name, objectives, scope, interview_checklist, created_by_id)
          VALUES (${ctx.orgId}, ${input.name}, ${sql.json(input.objectives)}, ${sql.json(input.scope)}, ${sql.json(checklist)}, ${ctx.user.id})
          RETURNING *`);
        await record("mission.create", { userId: ctx.user.id, organizationId: ctx.orgId, entityType: "mission", entityId: mission.id }, tx);
        return pick(mission, MISSION_OUT);
      });
    },
    201,
  );

  r.get("/orgs/:orgId/members", async (req, p) => {
    const ctx = await orgContext(req, p.orgId);
    ctx.requireWrite();
    const rows = await db.query<{ user_id: string; full_name: string; email: string; role: string; department_scope: string | null }>(sql`
      SELECT u.id AS user_id, u.full_name, u.email, m.role, m.department_scope FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = ${ctx.orgId} AND u.is_active`);
    return sortedBy(rows, (m) => [m.role, m.full_name]);
  });
}
