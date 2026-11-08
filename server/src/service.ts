import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { LIVE_LOG_LOCK, type DB, type Queryable, type Row } from "./db.js";
import { HttpError } from "./auth.js";
import { EventEmitter } from "node:events";

export const STATUSES = ["scheduled", "delayed", "canceled", "completed"] as const;
export type Status = (typeof STATUSES)[number];
export const TYPES = ["workshop", "recreation", "community"] as const;

export const bus = new EventEmitter();
bus.setMaxListeners(0);

/** Pure calculation: places left. Hand-predicted test: capacity 40, 31 taken => 9. */
export function availablePlaces(capacity: number, registered: number): number {
  return Math.max(0, capacity - registered);
}

export const EventInput = z.object({
  venue_id: z.number().int().positive(),
  title: z.string().trim().min(1).max(120),
  description: z.string().max(2000).default(""),
  event_type: z.enum(TYPES),
  starts_at: z.string().datetime(),
  ends_at: z.string().datetime(),
  capacity: z.number().int().min(0).max(10000),
}).refine((v) => Date.parse(v.ends_at) > Date.parse(v.starts_at), { message: "ends_at must be after starts_at", path: ["ends_at"] });
export const EventPatch = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(2000).optional(),
  event_type: z.enum(TYPES).optional(),
  starts_at: z.string().datetime().optional(),
  ends_at: z.string().datetime().optional(),
  capacity: z.number().int().min(0).max(10000).optional(),
  expected_version: z.number().int().positive(),
}).strict();
export const StatusInput = z.object({
  status: z.enum(STATUSES),
  reason: z.string().trim().min(3).max(500),
  expected_version: z.number().int().positive().optional(),
});
export const RegisterInput = z.object({ seats: z.number().int().min(1).max(100), label: z.string().trim().min(1).max(60).default("Synthetic attendee") });
export const ListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(STATUSES).optional(),
  event_type: z.enum(TYPES).optional(),
  location: z.string().trim().max(100).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function audit(q: Queryable, actor: string, action: string, entity: string, entityId: number | null, before: unknown, after: unknown, channel = "rest") {
  await q.query("INSERT INTO audit_events(at,actor,action,entity,entity_id,before_json,after_json,channel) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [
    new Date().toISOString(), actor, action, entity, entityId, before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after), channel,
  ]);
}

/**
 * Append to the persisted live-event log. Called INSIDE the write transaction so the log and the data can never disagree.
 * The transaction-scoped advisory lock makes ids COMMIT in the order they were assigned: without it, two concurrent writers
 * could commit id 8 before id 7, and a client that had already seen 8 would never receive 7.
 */
async function logLive(q: Queryable, type: string, payload: unknown): Promise<number> {
  await q.query("SELECT pg_advisory_xact_lock($1)", [LIVE_LOG_LOCK]);
  const rows = await q.query<{ id: number }>("INSERT INTO live_events(at,type,payload) VALUES ($1,$2,$3) RETURNING id", [new Date().toISOString(), type, JSON.stringify(payload)]);
  return rows[0]!.id;
}
export function announce(id: number) { bus.emit("live", id); }

const eventSelect = `SELECT e.*, v.name AS venue_name, v.location AS location, v.lat AS lat, v.lon AS lon FROM events e JOIN venues v ON v.id = e.venue_id`;

export interface EventDetail {
  id: number; venue_id: number; title: string; description: string; event_type: string;
  starts_at: string; ends_at: string; capacity: number; registered: number; status: Status;
  version: number; created_at: string; updated_at: string;
  venue_name: string; location: string; lat: number; lon: number; available: number;
}

export function decorate(r: Row): EventDetail {
  const e = r as unknown as Omit<EventDetail, "available">;
  return { ...e, available: availablePlaces(e.capacity, e.registered) };
}

export async function listEvents(db: Queryable, q: z.infer<typeof ListQuery>) {
  const where: string[] = [];
  const args: (string | number)[] = [];
  const p = (v: string | number) => { args.push(v); return `$${args.length}`; };
  if (q.q) { const a = p(`%${q.q}%`); where.push(`(e.title ILIKE ${a} OR e.description ILIKE ${a})`); }
  if (q.status) where.push(`e.status = ${p(q.status)}`);
  if (q.event_type) where.push(`e.event_type = ${p(q.event_type)}`);
  if (q.location) { const a = p(`%${q.location}%`); where.push(`(v.location ILIKE ${a} OR v.name ILIKE ${a})`); }
  if (q.from) where.push(`e.starts_at >= ${p(q.from)}`);
  if (q.to) where.push(`e.starts_at <= ${p(q.to)}`);
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = (await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM events e JOIN venues v ON v.id=e.venue_id ${w}`, args))[0]!.c;
  const lim = p(q.limit), off = p(q.offset);
  const rows = await db.query(`${eventSelect} ${w} ORDER BY e.starts_at ASC, e.id ASC LIMIT ${lim} OFFSET ${off}`, args);
  return { items: rows.map(decorate), total };
}

/** lock=true takes a row lock (SELECT ... FOR UPDATE) so a read-then-write inside a transaction cannot interleave with another writer. */
export async function getEvent(db: Queryable, id: number, lock = false) {
  const r = (await db.query(`${eventSelect} WHERE e.id = $1${lock ? " FOR UPDATE OF e" : ""}`, [id]))[0];
  if (!r) throw new HttpError(404, "not_found", "Event not found");
  const history = await db.query<{ from_status: string | null; to_status: string; reason: string; at: string }>(
    "SELECT from_status, to_status, reason, at FROM event_status_history WHERE event_id = $1 ORDER BY id DESC", [id]);
  return { ...decorate(r), history };
}

export async function listVenues(db: Queryable) { return db.query("SELECT id,name,location FROM venues ORDER BY name"); }

export async function createEvent(db: DB, actor: string, input: z.infer<typeof EventInput>, channel = "rest") {
  const venue = (await db.query("SELECT id FROM venues WHERE id = $1", [input.venue_id]))[0];
  if (!venue) throw new HttpError(422, "validation_error", "Unknown venue_id", { field: "venue_id" });
  const { id, liveId } = await db.tx(async (q) => {
    const now = new Date().toISOString();
    const eid = (await q.query<{ id: number }>(
      "INSERT INTO events(venue_id,title,description,event_type,starts_at,ends_at,capacity,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id",
      [input.venue_id, input.title, input.description, input.event_type, input.starts_at, input.ends_at, input.capacity, now, now],
    ))[0]!.id;
    await q.query("INSERT INTO event_status_history(event_id,from_status,to_status,reason,actor,at) VALUES ($1,$2,$3,$4,$5,$6)", [eid, null, "scheduled", "Event created", actor, now]);
    const after = await getEvent(q, eid);
    await audit(q, actor, "event.create", "event", eid, null, after, channel);
    return { id: eid, liveId: await logLive(q, "event.created", { id: eid }) };
  });
  announce(liveId);
  return getEvent(db, id);
}

export async function updateEvent(db: DB, actor: string, id: number, patch: z.infer<typeof EventPatch>) {
  const liveId = await db.tx(async (q) => {
    const before = await getEvent(q, id, true);
    if (before.version !== patch.expected_version) throw new HttpError(409, "version_conflict", "Event was modified by someone else", { current_version: before.version });
    const next = {
      title: patch.title ?? before.title, description: patch.description ?? before.description, event_type: patch.event_type ?? before.event_type,
      starts_at: patch.starts_at ?? before.starts_at, ends_at: patch.ends_at ?? before.ends_at, capacity: patch.capacity ?? before.capacity,
    };
    if (Date.parse(next.ends_at) <= Date.parse(next.starts_at)) throw new HttpError(422, "validation_error", "ends_at must be after starts_at");
    if (next.capacity < before.registered) throw new HttpError(422, "validation_error", "capacity cannot be lower than current registrations", { registered: before.registered });
    await q.query("UPDATE events SET title=$1,description=$2,event_type=$3,starts_at=$4,ends_at=$5,capacity=$6,version=version+1,updated_at=$7 WHERE id=$8",
      [next.title, next.description, next.event_type, next.starts_at, next.ends_at, next.capacity, new Date().toISOString(), id]);
    const after = await getEvent(q, id);
    await audit(q, actor, "event.update", "event", id, before, after);
    return logLive(q, "event.updated", { id });
  });
  announce(liveId);
  return getEvent(db, id);
}

export async function changeStatus(db: DB, actor: string, id: number, input: z.infer<typeof StatusInput>, channel = "rest") {
  const liveId = await db.tx(async (q) => {
    const before = await getEvent(q, id, true);
    if (input.expected_version !== undefined && before.version !== input.expected_version) {
      throw new HttpError(409, "version_conflict", "Event was modified by someone else", { current_version: before.version });
    }
    if (before.status === input.status) throw new HttpError(409, "no_change", `Event is already ${input.status}`);
    const now = new Date().toISOString();
    await q.query("UPDATE events SET status=$1,version=version+1,updated_at=$2 WHERE id=$3", [input.status, now, id]);
    await q.query("INSERT INTO event_status_history(event_id,from_status,to_status,reason,actor,at) VALUES ($1,$2,$3,$4,$5,$6)", [id, before.status, input.status, input.reason, actor, now]);
    const after = await getEvent(q, id);
    await audit(q, actor, "event.status", "event", id, { status: before.status, version: before.version }, { status: after.status, version: after.version, reason: input.reason }, channel);
    return logLive(q, "event.status", { id, status: input.status });
  });
  announce(liveId);
  return getEvent(db, id);
}

/**
 * Atomic registration. The single conditional UPDATE is the capacity guard: it only matches when registered + seats <= capacity.
 * Postgres locks the row for the UPDATE and a concurrent request re-checks the condition after the first one commits, so the
 * count can never pass capacity. The CHECK constraint (registered <= capacity) is a second line of defence.
 */
export async function registerSeats(db: DB, actor: string, id: number, input: z.infer<typeof RegisterInput>) {
  const liveId = await db.tx(async (q) => {
    const before = await getEvent(q, id, true);
    if (before.status === "canceled" || before.status === "completed") throw new HttpError(409, "event_closed", `Cannot register for a ${before.status} event`);
    const updated = await q.query("UPDATE events SET registered = registered + $1, version = version + 1, updated_at = $2 WHERE id = $3 AND registered + $1 <= capacity RETURNING id",
      [input.seats, new Date().toISOString(), id]);
    if (updated.length !== 1) {
      throw new HttpError(409, "capacity_exceeded", `Only ${before.available} places available; requested ${input.seats}`, { available: before.available, requested: input.seats });
    }
    await q.query("INSERT INTO synthetic_registrations(event_id,label,seats,created_at) VALUES ($1,$2,$3,$4)", [id, input.label, input.seats, new Date().toISOString()]);
    const after = await getEvent(q, id);
    await audit(q, actor, "event.register", "event", id, { registered: before.registered }, { registered: after.registered });
    return logLive(q, "event.capacity", { id, registered: after.registered, capacity: after.capacity });
  });
  announce(liveId);
  return getEvent(db, id);
}

export async function liveSince(db: Queryable, lastId: number, limit = 500) {
  return db.query<{ id: number; type: string; payload: string; at: string }>("SELECT id, type, payload, at FROM live_events WHERE id > $1 ORDER BY id ASC LIMIT $2", [lastId, limit]);
}
export async function latestLiveId(db: Queryable): Promise<number> {
  return (await db.query<{ m: number }>("SELECT COALESCE(MAX(id),0)::int AS m FROM live_events"))[0]!.m;
}

// ---- MCP confirmation tokens: single-use, bound to (actor, event, new status, reason, version) ----
const hash = (t: string) => createHash("sha256").update(t).digest("hex");

export async function createConfirmation(db: Queryable, actor: string, ttlMs: number, eventId: number, status: Status, reason: string) {
  const ev = await getEvent(db, eventId);
  if (ev.status === status) throw new HttpError(409, "no_change", `Event is already ${status}`);
  const token = randomBytes(24).toString("base64url");
  await db.query("INSERT INTO mcp_confirmations(token_hash,actor,event_id,new_status,reason,expected_version,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [hash(token), actor, eventId, status, reason, ev.version, new Date(Date.now() + ttlMs).toISOString()]);
  return { token, event: ev, proposal: { event_id: eventId, from: ev.status, to: status, reason }, expires_in_ms: ttlMs };
}

export async function consumeConfirmation(db: DB, actor: string, token: string, eventId: number, status: Status) {
  return db.tx(async (q) => {
    // FOR UPDATE: two simultaneous uses of one token cannot both pass the used_at check.
    const row = (await q.query("SELECT * FROM mcp_confirmations WHERE token_hash = $1 FOR UPDATE", [hash(token)]))[0];
    if (!row) throw new HttpError(403, "bad_confirmation", "Unknown confirmation token");
    if (row.used_at) throw new HttpError(403, "bad_confirmation", "Confirmation already used");
    if (row.actor !== actor) throw new HttpError(403, "bad_confirmation", "Confirmation belongs to a different user");
    if (Date.parse(row.expires_at as string) < Date.now()) throw new HttpError(403, "bad_confirmation", "Confirmation expired");
    if (row.event_id !== eventId || row.new_status !== status) throw new HttpError(403, "bad_confirmation", "Confirmation does not match this exact change");
    await q.query("UPDATE mcp_confirmations SET used_at = $1 WHERE token_hash = $2", [new Date().toISOString(), hash(token)]);
    return { reason: row.reason as string, expected_version: row.expected_version as number };
  });
}

export async function seed(db: DB) {
  const n = (await db.query<{ c: number }>("SELECT COUNT(*)::int AS c FROM venues"))[0]!.c;
  if (n > 0) return;
  for (const [name, loc, lat, lon] of [["Lakeside Meadow", "Chicago, IL", 41.88, -87.62], ["Pine Ridge Trailhead", "Madison, WI", 43.07, -89.4], ["Riverbend Park", "Milwaukee, WI", 43.04, -87.91]] as const) {
    await db.query("INSERT INTO venues(name,location,lat,lon) VALUES ($1,$2,$3,$4)", [name, loc, lat, lon]);
  }
  const now = Date.now();
  const day = 86400000;
  const mk = async (venue: number, title: string, type: string, offsetDays: number, cap: number, desc: string) => {
    const s = new Date(now + offsetDays * day); s.setUTCHours(15, 0, 0, 0);
    const e = new Date(s.getTime() + 3 * 3600000);
    await createEvent(db, "seed", { venue_id: venue, title, description: desc, event_type: type as "workshop", starts_at: s.toISOString(), ends_at: e.toISOString(), capacity: cap }, "seed");
  };
  await mk(1, "Sunrise Yoga on the Meadow", "recreation", 1, 40, "Synthetic demo event.");
  await mk(2, "Trail Safety Workshop", "workshop", 2, 25, "Synthetic demo event.");
  await mk(3, "Riverbend Community Cleanup", "community", 3, 60, "Synthetic demo event.");
  await mk(1, "Kite Flying Afternoon", "recreation", 4, 30, "Synthetic demo event.");
  await mk(2, "Night Sky Photography", "workshop", 12, 20, "Synthetic demo event beyond the 5-day forecast window.");
  await mk(3, "Autumn Fun Run", "recreation", -3, 80, "Synthetic past event.");
}
