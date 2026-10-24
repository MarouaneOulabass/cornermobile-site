/** Sign-in for local demo accounts (Clerk handles it in deployed environments) and the current user. */
import { NextResponse } from "next/server";
import { record } from "../../audit";
import { sessionSecret } from "../../auth/session";
import { requireUser } from "../../auth/session";
import { db, sql } from "../../db";
import { clerkEnabled, devAuthEnabled } from "../../env";
import { body, HttpError, SESSION_COOKIE } from "../../http";
import type { UserRow } from "../../rows";
import { signSession, verifyPassword } from "../../security";
import type { Router } from "../router";
import { LoginIn, pick, USER_OUT } from "../schemas";

const SESSION_HOURS = 12;

export function register(r: Router): void {
  r.post("/auth/login", async (req) => {
    if (clerkEnabled() || !devAuthEnabled()) throw new HttpError(404, "Connexion locale désactivée : utilisez la connexion Clerk");
    const input = await body(req, LoginIn);
    const user = await db.maybeOne<UserRow>(sql`SELECT * FROM users WHERE lower(email) = ${input.email.toLowerCase()}`);
    if (!user || !user.is_active || !verifyPassword(input.password, user.password_hash)) throw new HttpError(401, "Identifiants invalides");
    const token = signSession(user.id, sessionSecret(), SESSION_HOURS * 3600);
    await record("auth.login", { userId: user.id, organizationId: null });
    const res = NextResponse.json({ access_token: token, token_type: "bearer", user: pick(user, USER_OUT) });
    res.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: req.nextUrl.protocol === "https:",
      sameSite: "lax",
      maxAge: SESSION_HOURS * 3600,
      path: "/",
    });
    return res;
  });

  r.post(
    "/auth/logout",
    async () => {
      const res = new NextResponse(null, { status: 204 });
      res.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
      return res;
    },
    204,
  );

  r.get("/auth/me", async (req) => {
    const user = await requireUser(req);
    const memberships = await db.query(sql`
      SELECT m.organization_id, o.name AS organization_name, m.role, m.department_scope
      FROM memberships m JOIN organizations o ON o.id = m.organization_id
      WHERE m.user_id = ${user.id} ORDER BY m.created_at, m.id`);
    return { user: pick(user, USER_OUT), memberships };
  });
}
