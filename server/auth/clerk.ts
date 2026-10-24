/**
 * Clerk adapter. Clerk owns identity and organization membership (one Clerk organization per client); our tables
 * mirror them so that every query can join on users / memberships.
 *
 * Role mapping (Clerk organization roles → AuditFlow roles):
 *   org:admin, org:consultant → consultant · org:executive, org:member → executive · org:business_owner → business_owner
 * The department of a business owner is the membership's public metadata `department`; a platform administrator
 * has `platformAdmin: true` in the user's public metadata.
 */
import { auth, clerkClient, currentUser } from "@clerk/nextjs/server";
import { db, sql } from "../db";
import type { OrganizationRow, UserRow } from "../rows";
import { slugify } from "../slug";

const ROLE_MAP: Record<string, string> = {
  "org:admin": "consultant",
  "org:consultant": "consultant",
  "org:executive": "executive",
  "org:member": "executive",
  "org:business_owner": "business_owner",
};

export async function clerkUser(): Promise<UserRow | null> {
  const { userId } = await auth();
  if (!userId) return null;
  const existing = await db.maybeOne<UserRow>(sql`SELECT * FROM users WHERE external_id = ${userId}`);
  if (existing) return existing;
  const profile = await currentUser();
  if (!profile) return null;
  const email = profile.primaryEmailAddress?.emailAddress ?? `${userId}@clerk.invalid`;
  const name = [profile.firstName, profile.lastName].filter(Boolean).join(" ") || email;
  const platformAdmin = (profile.publicMetadata as { platformAdmin?: boolean } | undefined)?.platformAdmin === true;
  const user = await db.one<UserRow>(sql`
    INSERT INTO users (external_id, email, full_name, is_platform_admin)
    VALUES (${userId}, ${email}, ${name}, ${platformAdmin})
    ON CONFLICT (email) DO UPDATE SET external_id = EXCLUDED.external_id, full_name = EXCLUDED.full_name,
      is_platform_admin = EXCLUDED.is_platform_admin
    RETURNING *`);
  await syncMemberships(user);
  return user;
}

/** Mirrors the user's Clerk organization memberships (called at sign-in and when the portfolio is opened). */
export async function syncMemberships(user: UserRow): Promise<void> {
  const client = await clerkClient();
  const { data } = await client.users.getOrganizationMembershipList({ userId: user.external_id, limit: 200 });
  const seen: string[] = [];
  for (const m of data) {
    const org = await db.one<OrganizationRow>(sql`
      INSERT INTO organizations (name, slug, clerk_org_id)
      VALUES (${m.organization.name}, ${`${slugify(m.organization.slug || m.organization.name)}-${m.organization.id.slice(-6).toLowerCase()}`}, ${m.organization.id})
      ON CONFLICT (clerk_org_id) DO UPDATE SET name = EXCLUDED.name
      RETURNING *`);
    const role = ROLE_MAP[m.role] ?? "executive";
    const department = (m.publicMetadata as { department?: string } | undefined)?.department ?? null;
    await db.exec(sql`
      INSERT INTO memberships (organization_id, user_id, role, department_scope)
      VALUES (${org.id}, ${user.id}, ${role}, ${department})
      ON CONFLICT (user_id, organization_id) DO UPDATE SET role = EXCLUDED.role, department_scope = EXCLUDED.department_scope`);
    seen.push(org.id);
  }
  // Memberships removed in Clerk are removed here too (Clerk-backed organizations only).
  await db.exec(sql`
    DELETE FROM memberships m USING organizations o
    WHERE m.organization_id = o.id AND m.user_id = ${user.id} AND o.clerk_org_id IS NOT NULL
      AND NOT (m.organization_id = ANY(${seen}::uuid[]))`);
}

/** A new client organization is created in Clerk first; the consultant who creates it becomes its admin. */
export async function createClerkOrganization(name: string, user: UserRow): Promise<string> {
  const client = await clerkClient();
  const org = await client.organizations.createOrganization({ name, createdBy: user.external_id });
  return org.id;
}
