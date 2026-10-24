/**
 * Tenant isolation. Every mission-scoped handler resolves a MissionContext first; a user who is not a member of
 * the mission's organization gets a 404, exactly as if the mission did not exist, so one organization can never
 * learn anything about another.
 */
import type { NextRequest } from "next/server";
import { db, sql, type Db } from "../db";
import { CLIENT_ROLES, Role, WRITE_ROLES } from "../domain/enums";
import { HttpError, notFound, parseId } from "../http";
import type { MissionRow, OrganizationRow, UserRow } from "../rows";
import { requireUser } from "./session";

export class OrgContext {
  constructor(
    readonly user: UserRow,
    readonly organization: OrganizationRow,
    readonly role: Role,
    readonly departmentScope: string | null,
  ) {}

  get orgId(): string {
    return this.organization.id;
  }
  get canWrite(): boolean {
    return WRITE_ROLES.has(this.role);
  }
  get isClient(): boolean {
    return CLIENT_ROLES.has(this.role);
  }
  requireWrite(): void {
    if (!this.canWrite) throw new HttpError(403, "Action réservée aux consultants");
  }
  requireAdmin(): void {
    if (this.role !== Role.admin) throw new HttpError(403, "Action réservée aux administrateurs");
  }
}

export class MissionContext extends OrgContext {
  constructor(
    user: UserRow,
    organization: OrganizationRow,
    role: Role,
    departmentScope: string | null,
    readonly mission: MissionRow,
  ) {
    super(user, organization, role, departmentScope);
  }
  get missionId(): string {
    return this.mission.id;
  }
}

export async function resolveOrgContext(user: UserRow, orgId: string): Promise<OrgContext> {
  const org = await db.maybeOne<OrganizationRow>(sql`SELECT * FROM organizations WHERE id = ${orgId}`);
  if (!org) throw notFound("Organisation introuvable");
  if (user.is_platform_admin) return new OrgContext(user, org, Role.admin, null);
  const membership = await db.maybeOne<{ role: Role; department_scope: string | null }>(
    sql`SELECT role, department_scope FROM memberships WHERE user_id = ${user.id} AND organization_id = ${orgId}`,
  );
  if (!membership) throw notFound("Organisation introuvable");
  return new OrgContext(user, org, membership.role, membership.department_scope);
}

export async function orgContext(req: NextRequest, orgId: string): Promise<OrgContext> {
  const user = await requireUser(req);
  return resolveOrgContext(user, parseId(orgId));
}

export async function missionContextFor(user: UserRow, missionId: string): Promise<MissionContext> {
  const mission = await db.maybeOne<MissionRow>(sql`SELECT * FROM audit_missions WHERE id = ${parseId(missionId)}`);
  if (!mission) throw notFound("Mission introuvable");
  let ctx: OrgContext;
  try {
    ctx = await resolveOrgContext(user, mission.organization_id);
  } catch {
    throw notFound("Mission introuvable");
  }
  return new MissionContext(ctx.user, ctx.organization, ctx.role, ctx.departmentScope, mission);
}

export async function missionContext(req: NextRequest, missionId: string): Promise<MissionContext> {
  return missionContextFor(await requireUser(req), missionId);
}

/** Load a mission-scoped row, refusing anything outside the caller's mission and organization. */
export async function getOwned<T extends { organization_id: string; mission_id?: string | null }>(
  ctx: MissionContext,
  table: string,
  id: string,
  tx: Db = db,
): Promise<T> {
  const row = await tx.maybeOne<T>(sql`SELECT * FROM ${sql.raw(table)} WHERE id = ${parseId(id)}`);
  if (!row || row.organization_id !== ctx.orgId || (row.mission_id !== undefined && row.mission_id !== null && row.mission_id !== ctx.missionId)) {
    throw notFound();
  }
  return row;
}
