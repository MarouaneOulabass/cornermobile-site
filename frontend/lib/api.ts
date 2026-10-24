/** Thin fetch wrapper. Session = httpOnly cookie; writes carry the CSRF header the API expects. */

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

type Json = Record<string, unknown> | unknown[];

async function request<T>(method: string, path: string, body?: Json | FormData): Promise<T> {
  const headers: Record<string, string> = { "X-Requested-With": "auditflow" };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`/api${path}`, { method, headers, body: payload, credentials: "same-origin" });
  if (res.status === 204) return undefined as T;
  const data = res.headers.get("content-type")?.includes("application/json") ? await res.json() : null;
  if (!res.ok) {
    const detail = data?.detail;
    const message = typeof detail === "string" ? detail : Array.isArray(detail) ? detail.map((d) => d.msg).join(", ") : res.statusText;
    throw new ApiError(res.status, message || `Erreur ${res.status}`);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: Json | FormData) => request<T>("POST", path, body),
  patch: <T>(path: string, body?: Json) => request<T>("PATCH", path, body),
  put: <T>(path: string, body?: Json) => request<T>("PUT", path, body),
  del: <T>(path: string) => request<T>("DELETE", path),
};

export const fetcher = <T>(path: string) => api.get<T>(path);
