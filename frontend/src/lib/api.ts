export const BACKEND_URL = (import.meta.env.VITE_BACKEND_URL || "http://localhost:5000").replace(/\/$/, "");

export type ApiResult =
  | { ok: true; status: number; data: Record<string, unknown> }
  | { ok: false; status: number | null; error: string };

/**
 * Call the backend and normalize every outcome (success, error JSON, network failure)
 * into one shape the UI can render. `credentials: "include"` sends the session cookie.
 */
export async function callBackend(path: string, init?: RequestInit): Promise<ApiResult> {
  let res: Response;
  try {
    res = await fetch(`${BACKEND_URL}${path}`, { credentials: "include", ...init });
  } catch {
    return {
      ok: false,
      status: null,
      error: `Could not reach ${BACKEND_URL}. Is the backend running? (Also check CORS / FRONTEND_URL.)`,
    };
  }

  let body: Record<string, unknown> = {};
  try {
    body = await res.json();
  } catch {
    return { ok: false, status: res.status, error: `HTTP ${res.status}: response was not JSON` };
  }

  if (!res.ok || body.ok === false) {
    const error = typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
    return { ok: false, status: res.status, error };
  }
  return { ok: true, status: res.status, data: body };
}
