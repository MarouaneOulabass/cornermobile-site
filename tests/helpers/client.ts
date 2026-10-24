/** In-process API client: requests go straight to the /api router, as the catch-all route handler does. */
import { NextRequest } from "next/server";
import { apiRouter } from "@/server/api";

export const DEMO_PASSWORD = process.env.AUDITFLOW_DEMO_PASSWORD ?? "demo-test";

export interface TestResponse {
  status: number;
  headers: Headers;
  body: string;
  bytes: Uint8Array;
  json<T = any>(): T; // eslint-disable-line @typescript-eslint/no-explicit-any
  cookies: Map<string, string>;
}

type Headers_ = Record<string, string>;

export class TestClient {
  /** Cookies kept between requests, like a browser (cleared by login() to test bearer tokens). */
  readonly cookies = new Map<string, string>();

  async request(method: string, path: string, opts: { json?: unknown; headers?: Headers_; form?: FormData } = {}): Promise<TestResponse> {
    const headers = new Headers(opts.headers);
    let body: BodyInit | undefined;
    if (opts.form) body = opts.form;
    else if (opts.json !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(opts.json);
    }
    if (this.cookies.size && !headers.has("cookie")) headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    const req = new NextRequest(new URL(path, "http://localhost"), { method, headers, body });
    const res = await apiRouter().dispatch(req);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
    const cookies = new Map<string, string>();
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const [k, ...v] = pair.split("=");
      const value = v.join("=");
      cookies.set(k, value);
      if (value && !/max-age=0/i.test(c)) this.cookies.set(k, value);
      else this.cookies.delete(k);
    }
    return { status: res.status, headers: res.headers, body: text, bytes, json: () => JSON.parse(text), cookies };
  }

  get(path: string, headers?: Headers_) {
    return this.request("GET", path, { headers });
  }
  post(path: string, json?: unknown, headers?: Headers_) {
    return this.request("POST", path, { json, headers });
  }
  put(path: string, json?: unknown, headers?: Headers_) {
    return this.request("PUT", path, { json, headers });
  }
  patch(path: string, json?: unknown, headers?: Headers_) {
    return this.request("PATCH", path, { json, headers });
  }
  delete(path: string, headers?: Headers_) {
    return this.request("DELETE", path, { headers });
  }

  /** Signs in and returns bearer headers (the cookie is dropped so each call states who it is). */
  async login(email: string): Promise<Headers_> {
    const res = await this.post("/api/auth/login", { email, password: DEMO_PASSWORD });
    if (res.status !== 200) throw new Error(`login ${email}: ${res.status} ${res.body}`);
    this.cookies.clear();
    return { Authorization: `Bearer ${res.json().access_token}` };
  }
}
