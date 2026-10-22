export type Repo = {
  id: number;
  kind: string;
  source: string;
  title: string;
  status: "pending" | "indexing" | "ready" | "failed";
  stats: Record<string, unknown>;
  last_used_at: string;
  summary: string | null; // first sentence of the cached overview; "" or null = none yet
  progress: number | null; // latest index job, 0-100
  message: string | null;
};
export type Source = { n: number; path: string; start_line: number; end_line: number; symbol: string | null };
export type Turn = { role: "user" | "assistant"; content: string };
export type Settings = { apiUrl: string; token: string };

const DEFAULT_API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const URL_KEY = "gitguru.apiUrl";
const TOKEN_KEY = "gitguru.token";

// localStorage can throw (private mode) and does not exist during server rendering.
export function getSettings(): Settings {
  try {
    return {
      apiUrl: localStorage.getItem(URL_KEY) || DEFAULT_API_URL,
      token: localStorage.getItem(TOKEN_KEY) ?? "",
    };
  } catch {
    return { apiUrl: DEFAULT_API_URL, token: "" };
  }
}

export function saveSettings(s: Settings): void {
  localStorage.setItem(URL_KEY, s.apiUrl.trim());
  localStorage.setItem(TOKEN_KEY, s.token.trim());
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

// FastAPI `detail` is a string, or (for 422) a list of {loc, msg} objects.
function detailText(detail: unknown, fallback: string): string {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const msgs = detail.map((d) => (d && typeof d.msg === "string" ? d.msg : JSON.stringify(d)));
    return msgs.join("; ") || fallback;
  }
  return fallback;
}

export async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const { apiUrl, token } = getSettings();
  const headers = new Headers(init.headers);
  headers.set("X-GitGuru-Token", token);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");

  let res: Response;
  try {
    res = await fetch(apiUrl.replace(/\/+$/, "") + path, { ...init, headers });
  } catch {
    throw new ApiError(0, `Cannot reach the API at ${apiUrl}. Check your API URL in Settings.`);
  }
  if (res.ok) return res;
  if (res.status === 401) throw new ApiError(401, "Check your API URL and token in Settings.");
  const body = await res.json().catch(() => null);
  throw new ApiError(res.status, detailText(body?.detail, res.statusText || `HTTP ${res.status}`));
}
