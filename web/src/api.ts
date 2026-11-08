import { API_BASE } from "./config";

export type Status = "scheduled" | "delayed" | "canceled" | "completed";
export type EventType = "workshop" | "recreation" | "community";
export const STATUSES: Status[] = ["scheduled", "delayed", "canceled", "completed"];
export const TYPES: EventType[] = ["workshop", "recreation", "community"];

export interface EventSummary {
  id: number; venue_id: number; title: string; description: string; event_type: EventType;
  starts_at: string; ends_at: string; capacity: number; registered: number; available: number;
  status: Status; version: number; venue_name: string; location: string;
}
export interface HistoryRow { from_status: string | null; to_status: string; reason: string; at: string }
export interface EventDetail extends EventSummary { history: HistoryRow[] }
export interface Venue { id: number; name: string; location: string }
export interface Weather {
  status: "fresh" | "stale" | "unavailable" | "out_of_range"; message: string; fetchedAt?: string; slotTime?: string;
  summary?: string; tempC?: number; windMs?: number; precipChance?: number;
  flag?: "clear" | "caution" | "advisory"; flagReasons?: string[];
}
export interface ListFilters { q?: string; status?: string; event_type?: string; location?: string; from?: string; to?: string }

/** Matches the server's { error: { code, message, details?, requestId } } shape. */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: Record<string, unknown>, public requestId?: string) { super(message); }
}

/** W3C trace context: one trace id per user action lets the API continue the same distributed trace. */
function newTraceparent(): string {
  const hex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");
  return `00-${hex(16)}-${hex(8)}-01`;
}

let tokenGetter: () => string | null = () => null;
export const setTokenGetter = (fn: () => string | null) => { tokenGetter = fn; };

async function request<T>(path: string, init: RequestInit & { auth?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json", traceparent: newTraceparent() };
  if (init.body) headers["Content-Type"] = "application/json";
  const t = init.auth ? tokenGetter() : null;
  if (t) headers.Authorization = `Bearer ${t}`;
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) }, signal: init.signal });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError(0, "network_error", "Cannot reach the server. Check your connection and try again.");
  }
  if (!res.ok) {
    let body: { error?: { code?: string; message?: string; details?: Record<string, unknown>; requestId?: string } } = {};
    try { body = await res.json(); } catch { /* non-JSON error */ }
    throw new ApiError(res.status, body.error?.code ?? "http_error", body.error?.message ?? `Request failed (${res.status})`, body.error?.details, body.error?.requestId);
  }
  return (await res.json()) as T;
}

const qs = (o: Record<string, string | number | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

export const api = {
  listEvents: (f: ListFilters, signal?: AbortSignal) => request<{ items: EventSummary[]; total: number }>(`/api/events${qs({ ...f, limit: 50 })}`, { signal }),
  getEvent: (id: number, signal?: AbortSignal) => request<EventDetail>(`/api/events/${id}`, { signal }),
  getWeather: (id: number, signal?: AbortSignal) => request<Weather>(`/api/events/${id}/weather`, { signal }),
  venues: (signal?: AbortSignal) => request<{ items: Venue[] }>(`/api/venues`, { signal }),
  createEvent: (body: unknown) => request<EventDetail>(`/api/events`, { method: "POST", body: JSON.stringify(body), auth: true }),
  updateEvent: (id: number, body: unknown) => request<EventDetail>(`/api/events/${id}`, { method: "PATCH", body: JSON.stringify(body), auth: true }),
  changeStatus: (id: number, body: { status: Status; reason: string; expected_version?: number }) =>
    request<EventDetail>(`/api/events/${id}/status`, { method: "POST", body: JSON.stringify(body), auth: true }),
  register: (id: number, body: { seats: number; label?: string }) =>
    request<EventDetail>(`/api/events/${id}/registrations`, { method: "POST", body: JSON.stringify(body), auth: true }),
};
