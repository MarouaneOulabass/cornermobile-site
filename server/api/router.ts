/**
 * The API under /api is served by one catch-all route handler (app/api/[...path]/route.ts) that dispatches to the
 * route modules below, so the HTTP contract stays exactly the one the web app was written against.
 */
import type { NextRequest } from "next/server";
import { handle, HttpError, withSecurityHeaders, json } from "../http";

export type Params = Record<string, string>;
export type RouteHandler = (req: NextRequest, params: Params) => Promise<unknown>;

interface RouteDef {
  method: string;
  segments: string[];
  handler: RouteHandler;
  status: number;
}

export class Router {
  private readonly routes: RouteDef[] = [];

  private add(method: string, pattern: string, handler: RouteHandler, status = 200): void {
    this.routes.push({ method, segments: pattern.split("/").filter(Boolean), handler, status });
  }
  get(pattern: string, handler: RouteHandler, status?: number) {
    this.add("GET", pattern, handler, status);
  }
  post(pattern: string, handler: RouteHandler, status?: number) {
    this.add("POST", pattern, handler, status);
  }
  put(pattern: string, handler: RouteHandler, status?: number) {
    this.add("PUT", pattern, handler, status);
  }
  patch(pattern: string, handler: RouteHandler, status?: number) {
    this.add("PATCH", pattern, handler, status);
  }
  delete(pattern: string, handler: RouteHandler, status?: number) {
    this.add("DELETE", pattern, handler, status);
  }

  /** First route (in registration order) whose pattern matches; `:name` segments become params. */
  match(method: string, path: string): { route: RouteDef; params: Params } | { allowed: string[] } | null {
    const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
    const allowed: string[] = [];
    for (const route of this.routes) {
      if (route.segments.length !== parts.length) continue;
      const params: Params = {};
      const ok = route.segments.every((seg, i) => {
        if (seg.startsWith(":")) {
          params[seg.slice(1)] = parts[i];
          return true;
        }
        return seg === parts[i];
      });
      if (!ok) continue;
      if (route.method === method) return { route, params };
      allowed.push(route.method);
    }
    return allowed.length ? { allowed } : null;
  }

  async dispatch(req: NextRequest, prefix = "/api"): Promise<Response> {
    const path = req.nextUrl.pathname.startsWith(prefix) ? req.nextUrl.pathname.slice(prefix.length) : req.nextUrl.pathname;
    const found = this.match(req.method === "HEAD" ? "GET" : req.method, path);
    if (!found) return withSecurityHeaders(json({ detail: "Not Found" }, 404));
    if ("allowed" in found) {
      return withSecurityHeaders(json({ detail: "Method Not Allowed" }, 405, { Allow: found.allowed.join(", ") }));
    }
    return handle(req, found.route.handler, found.params, found.route.status);
  }
}

export function badRequest(detail: unknown, status = 422): HttpError {
  return new HttpError(status, detail);
}
