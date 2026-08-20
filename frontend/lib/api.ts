const CONFIGURED_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const CSRF_COOKIE_NAME = "pp_csrf";
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function apiBaseUrl(): string {
  if (typeof window === "undefined") return CONFIGURED_BASE_URL;
  // Browser requests stay on the page origin and are forwarded by Next.js.
  // This avoids localhost/127.0.0.1 proxy differences, CORS, and split cookie
  // domains while keeping server-side callers on the internal API address.
  return `${window.location.origin}/api/backend`;
}

export function resolveApiAssetUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  if (/^(?:https?:|data:|blob:)/.test(path)) return path;
  return `${apiBaseUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}

export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const prefix = `${encodeURIComponent(name)}=`;
  for (const part of document.cookie.split(";")) {
    const value = part.trim();
    if (value.startsWith(prefix)) return decodeURIComponent(value.slice(prefix.length));
  }
  return null;
}

export function getCsrfToken(): string | null {
  return readCookie(CSRF_COOKIE_NAME);
}

function requestUrl(path: string): string {
  return /^https?:\/\//.test(path) ? path : `${apiBaseUrl()}${path}`;
}

function requestHeaders(options: RequestInit): Headers {
  const headers = new Headers(options.headers);
  if (!(options.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const method = (options.method ?? "GET").toUpperCase();
  const csrf = readCookie(CSRF_COOKIE_NAME);
  if (UNSAFE_METHODS.has(method) && csrf && !headers.has("X-CSRF-Token")) {
    headers.set("X-CSRF-Token", csrf);
  }
  return headers;
}

let refreshInFlight: Promise<boolean> | null = null;

async function refreshBrowserSession(): Promise<boolean> {
  if (!refreshInFlight) {
    const performRefresh = async () => {
      try {
        const probe = await fetch(`${apiBaseUrl()}/api/v1/auth/me`, {
          credentials: "include",
          cache: "no-store",
        });
        if (probe.ok) return true;
      } catch {
        return false;
      }
      const csrf = readCookie(CSRF_COOKIE_NAME);
      if (!csrf) return false;
      try {
        const response = await fetch(`${apiBaseUrl()}/api/v1/auth/refresh`, {
          method: "POST",
          credentials: "include",
          cache: "no-store",
          headers: { "X-CSRF-Token": csrf },
        });
        if (response.status === 409) {
          await new Promise((resolve) => window.setTimeout(resolve, 50));
          const probe = await fetch(`${apiBaseUrl()}/api/v1/auth/me`, {
            credentials: "include",
            cache: "no-store",
          });
          return probe.ok;
        }
        return response.ok;
      } catch {
        return false;
      }
    };
    refreshInFlight = (async () => {
      if (typeof navigator !== "undefined" && navigator.locks) {
        return navigator.locks.request("planpilot-auth-refresh", performRefresh);
      }
      return performRefresh();
    })().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

function mayRefresh(path: string): boolean {
  return !path.includes("/api/v1/auth/login")
    && !path.includes("/api/v1/auth/register")
    && !path.includes("/api/v1/auth/refresh")
    && !path.includes("/api/v1/auth/forgot-password")
    && !path.includes("/api/v1/auth/reset-password");
}

export async function authFetch(
  path: string,
  options: RequestInit = {},
  allowRefresh = true,
): Promise<Response> {
  const response = await fetch(requestUrl(path), {
    ...options,
    headers: requestHeaders(options),
    credentials: "include",
    cache: options.cache ?? "no-store",
  });
  if (response.status === 401 && allowRefresh && mayRefresh(path)) {
    const refreshed = await refreshBrowserSession();
    if (refreshed) return authFetch(path, options, false);
  }
  return response;
}

async function parseResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ detail: response.statusText })) as {
      detail?: unknown;
      message?: string;
    };
    const detail = payload.detail;
    const message = typeof detail === "string"
      ? detail
      : Array.isArray(detail) && detail.length
        ? String((detail[0] as { msg?: string }).msg ?? "请求失败")
        : payload.message ?? `请求失败 (${response.status})`;
    throw new ApiError(message, response.status);
  }
  if (response.status === 204 || response.headers.get("content-length") === "0") {
    return undefined as T;
  }
  return response.json() as Promise<T>;
}

export async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  try {
    return parseResponse<T>(await authFetch(path, options));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("服务器暂时无法连接，请稍后重试", 0);
  }
}

export async function streamServerEvents(
  path: string,
  options: {
    signal: AbortSignal;
    lastEventId?: number;
    onEvent: (event: { id?: string; event?: string; data: string }) => void;
  },
): Promise<void> {
  const headers: Record<string, string> = { Accept: "text/event-stream" };
  if (options.lastEventId !== undefined) headers["Last-Event-ID"] = String(options.lastEventId);
  const response = await authFetch(path, {
    headers,
    cache: "no-store",
    signal: options.signal,
  });
  if (!response.ok || !response.body) throw new ApiError(`事件连接失败 (${response.status})`, response.status);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const parsed: { id?: string; event?: string; data: string } = { data: "" };
      for (const line of block.split("\n")) {
        if (!line || line.startsWith(":")) continue;
        const separator = line.indexOf(":");
        const field = separator >= 0 ? line.slice(0, separator) : line;
        const rawValue = separator >= 0 ? line.slice(separator + 1) : "";
        const fieldValue = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
        if (field === "id") parsed.id = fieldValue;
        if (field === "event") parsed.event = fieldValue;
        if (field === "data") parsed.data = parsed.data ? `${parsed.data}\n${fieldValue}` : fieldValue;
      }
      if (parsed.data) options.onEvent(parsed);
      boundary = buffer.indexOf("\n\n");
    }
  }
}

export const api = {
  get: <T>(path: string) => apiFetch<T>(path),
  post: <T>(path: string, body: unknown) => apiFetch<T>(path, { method: "POST", body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) => apiFetch<T>(path, { method: "PATCH", body: JSON.stringify(body) }),
  del: <T>(path: string) => apiFetch<T>(path, { method: "DELETE" }),
  put: <T>(path: string, body: unknown) => apiFetch<T>(path, { method: "PUT", body: JSON.stringify(body) }),
  upload: <T>(path: string, formData: FormData) => apiFetch<T>(path, { method: "POST", body: formData }),
  openFile: async (path: string): Promise<void> => {
    const response = await authFetch(path);
    if (!response.ok) throw new ApiError("附件打开失败", response.status);
    const objectUrl = URL.createObjectURL(await response.blob());
    window.open(objectUrl, "_blank", "noopener,noreferrer");
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  },
};

export function storeUserInfo(user: unknown) {
  if (typeof window === "undefined") return;
  localStorage.setItem("user_info", JSON.stringify(user));
}

export function getStoredUserInfo(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("user_info");
}

export function clearAccessToken() {
  if (typeof window === "undefined") return;
  // Remove legacy bearer material during migration. HttpOnly cookies can only
  // be cleared by the server's logout response.
  localStorage.removeItem("access_token");
  sessionStorage.removeItem("access_token");
  localStorage.removeItem("user_name");
  sessionStorage.removeItem("user_name");
  localStorage.removeItem("user_info");
  sessionStorage.removeItem("user_info");
  document.cookie = "pp_token=; path=/; SameSite=Strict; max-age=0";
}

export const clearToken = clearAccessToken;

export function getUserName(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = getStoredUserInfo();
    return raw ? (JSON.parse(raw) as { username?: string }).username ?? null : null;
  } catch {
    return null;
  }
}
