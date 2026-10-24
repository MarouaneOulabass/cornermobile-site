/** Route-handler plumbing: errors as JSON `{detail}`, body validation, CSRF guard and security headers. */
import { NextResponse, type NextRequest } from "next/server";
import { z, ZodError } from "zod";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly detail: unknown,
  ) {
    super(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
}

export const notFound = (detail = "Élément introuvable") => new HttpError(404, detail);

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
export const SESSION_COOKIE = "af_session";
const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
};

/** Cookie-authenticated writes must carry a custom header, which a cross-site form cannot set. */
function csrfGuard(req: NextRequest): void {
  if (!UNSAFE.has(req.method)) return;
  if (req.headers.get("authorization")) return;
  const hasSession = req.cookies.has(SESSION_COOKIE) || req.cookies.has("__session");
  if (hasSession && req.headers.get("x-requested-with") !== "auditflow") {
    throw new HttpError(403, "En-tête X-Requested-With manquant");
  }
}

export function withSecurityHeaders(res: Response): Response {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!res.headers.has(k)) res.headers.set(k, v);
  return res;
}

export function json(data: unknown, status = 200, headers?: Record<string, string>): Response {
  return NextResponse.json(data, { status, headers });
}

export function noContent(): Response {
  return new Response(null, { status: 204 });
}

type Params = Record<string, string>;
type Handler<P extends Params> = (req: NextRequest, params: P) => Promise<unknown>;

/** Errors as `{detail}` responses: HttpError keeps its status, validation errors are 422, anything else a 500. */
export function errorResponse(req: NextRequest, error: unknown): Response {
  if (error instanceof HttpError) return withSecurityHeaders(json({ detail: error.detail }, error.status));
  if (error instanceof ZodError) return withSecurityHeaders(json({ detail: zodDetail(error, []) }, 422));
  console.error("[auditflow] unhandled error", req.method, req.nextUrl.pathname, error);
  return withSecurityHeaders(json({ detail: "Erreur interne" }, 500));
}

/** Runs a handler: `return value` becomes JSON (a Response is passed through). */
export async function handle<P extends Params>(req: NextRequest, handler: Handler<P>, params: P, status = 200): Promise<Response> {
  try {
    csrfGuard(req);
    const result = await handler(req, params);
    const res = result instanceof Response ? result : json(result ?? null, status);
    return withSecurityHeaders(res);
  } catch (error) {
    return errorResponse(req, error);
  }
}

/** Wraps a handler for a file-based route (`export const GET = route(...)`). */
export function route<P extends Params = Params>(handler: Handler<P>, options: { status?: number } = {}) {
  return async (req: NextRequest, context: { params: Promise<P> }): Promise<Response> => {
    const params = context?.params ? await context.params : ({} as P);
    return handle(req, handler, params, options.status);
  };
}

function zodDetail(error: ZodError, prefix: (string | number)[]) {
  return error.issues.map((i) => ({ loc: [...prefix, ...i.path.map((p) => (typeof p === "symbol" ? String(p) : p))], msg: i.message, type: i.code }));
}

export async function body<T extends z.ZodType>(req: NextRequest, schema: T): Promise<z.infer<T>> {
  let data: unknown;
  try {
    data = await req.json();
  } catch {
    data = {};
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new HttpError(422, zodDetail(parsed.error, ["body"]));
  return parsed.data;
}

export function searchParams<T extends z.ZodType>(req: NextRequest, schema: T): z.infer<T> {
  const parsed = schema.safeParse(Object.fromEntries(req.nextUrl.searchParams.entries()));
  if (!parsed.success) throw new HttpError(422, zodDetail(parsed.error, ["query"]));
  return parsed.data;
}

export const uuidSchema = z.uuid();

export function parseId(value: string): string {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) throw new HttpError(404, "Élément introuvable");
  return parsed.data;
}
