/**
 * Who is calling. Clerk in deployed environments (identity, plus organization memberships synced into our
 * tables); local demo accounts with a signed cookie only when explicitly enabled off-Vercel.
 */
import type { NextRequest } from "next/server";
import { db, sql } from "../db";
import { clerkEnabled, devAuthEnabled, env } from "../env";
import { HttpError, SESSION_COOKIE } from "../http";
import type { UserRow } from "../rows";
import { verifySession } from "../security";

export function sessionSecret(): string {
  const secret = env().AUDITFLOW_SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error("AUDITFLOW_SESSION_SECRET (≥ 32 caractères) est requis pour les comptes locaux");
  return secret;
}

export async function findUser(id: string): Promise<UserRow | null> {
  return db.maybeOne<UserRow>(sql`SELECT * FROM users WHERE id = ${id}`);
}

async function devUser(req: NextRequest): Promise<UserRow | null> {
  const bearer = req.headers.get("authorization");
  const token = bearer?.toLowerCase().startsWith("bearer ") ? bearer.slice(7) : req.cookies.get(SESSION_COOKIE)?.value;
  const userId = verifySession(token, sessionSecret());
  return userId ? findUser(userId) : null;
}

export async function getUser(req: NextRequest): Promise<UserRow | null> {
  let user: UserRow | null = null;
  if (clerkEnabled()) {
    const { clerkUser } = await import("./clerk");
    user = await clerkUser();
  } else if (devAuthEnabled()) {
    user = await devUser(req);
  }
  return user && user.is_active ? user : null;
}

export async function requireUser(req: NextRequest): Promise<UserRow> {
  const user = await getUser(req);
  if (!user) throw new HttpError(401, "Authentification requise");
  return user;
}
