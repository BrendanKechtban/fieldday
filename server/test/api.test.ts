import { describe, it, expect } from "vitest";
import request from "supertest";
import { AddressInfo } from "node:net";
import { setup, token, ISS, AUD } from "./helpers.js";
import * as svc from "../src/service.js";

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

describe("registration capacity (hand-predicted: 40 capacity, 31 taken => 9 left)", () => {
  it("rejects a request for 10 more places and leaves the count unchanged", async () => {
    const { app, coordinator, mkEvent, db } = await setup();
    const ev = await mkEvent(40);
    const r1 = await request(app).post(`/api/events/${ev.id}/registrations`).set(auth(coordinator)).send({ seats: 31 });
    expect(r1.status).toBe(201);
    expect(r1.body.available).toBe(9);
    const r2 = await request(app).post(`/api/events/${ev.id}/registrations`).set(auth(coordinator)).send({ seats: 10 });
    expect(r2.status).toBe(409);
    expect(r2.body.error.code).toBe("capacity_exceeded");
    expect((await svc.getEvent(db, ev.id)).registered).toBe(31);
    const regs = (await db.query<{ s: number }>("SELECT COALESCE(SUM(seats),0)::int AS s FROM synthetic_registrations WHERE event_id=$1", [ev.id]))[0]!;
    expect(regs.s).toBe(31);
  });

  it("never oversells under concurrent requests", async () => {
    const { app, coordinator, mkEvent, db } = await setup();
    const ev = await mkEvent(10);
    const results = await Promise.all(Array.from({ length: 25 }, () => request(app).post(`/api/events/${ev.id}/registrations`).set(auth(coordinator)).send({ seats: 1 })));
    // 25 < 30/min write limit and < 60/min auth limit, so every request reaches the capacity check
    expect(results.filter((r) => r.status === 201).length).toBe(10);
    expect(results.filter((r) => r.status === 409).length).toBe(15);
    expect((await svc.getEvent(db, ev.id)).registered).toBe(10);
  });
});

describe("authorization is enforced on the server", () => {
  it("401 without a token, 401 for garbage", async () => {
    const { app, mkEvent } = await setup();
    const ev = await mkEvent();
    expect((await request(app).post(`/api/events/${ev.id}/status`).send({ status: "delayed", reason: "rain" })).status).toBe(401);
    expect((await request(app).post(`/api/events/${ev.id}/status`).set(auth("garbage")).send({ status: "delayed", reason: "rain" })).status).toBe(401);
  });

  it("a viewer (read scope, viewer role) cannot modify anything", async () => {
    const { app, viewer, mkEvent, db } = await setup();
    const ev = await mkEvent();
    for (const [method, url, body] of [
      ["post", "/api/events", { venue_id: 1, title: "x", event_type: "workshop", starts_at: "2030-01-01T10:00:00Z", ends_at: "2030-01-01T11:00:00Z", capacity: 5 }],
      ["patch", `/api/events/${ev.id}`, { capacity: 5, expected_version: 1 }],
      ["post", `/api/events/${ev.id}/status`, { status: "canceled", reason: "no reason" }],
      ["post", `/api/events/${ev.id}/registrations`, { seats: 1 }],
    ] as const) {
      const r = await request(app)[method](url).set(auth(viewer)).send(body);
      expect(r.status, `${method} ${url}`).toBe(403);
    }
    expect((await svc.getEvent(db, ev.id)).status).toBe("scheduled");
  });

  it("coordinator role without the write scope is refused", async () => {
    const { app, keys, mkEvent } = await setup();
    const ev = await mkEvent();
    const t = await token(keys.good.privateKey, { roles: ["coordinator"], scp: "events.read" });
    const r = await request(app).post(`/api/events/${ev.id}/status`).set(auth(t)).send({ status: "delayed", reason: "rain" });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("insufficient_scope");
  });

  it("write scope without the coordinator role is refused", async () => {
    const { app, keys, mkEvent } = await setup();
    const ev = await mkEvent();
    const t = await token(keys.good.privateKey, { roles: ["viewer"], scp: "events.read events.write" });
    expect((await request(app).post(`/api/events/${ev.id}/status`).set(auth(t)).send({ status: "delayed", reason: "rain" })).status).toBe(403);
  });

  it.each([
    ["wrong issuer", { iss: "https://evil.test" }],
    ["wrong audience", { aud: "api://other" }],
    ["expired", { expSec: -60 }],
  ])("rejects a token with %s", async (_n, o) => {
    const { app, keys } = await setup();
    const t = await token(keys.good.privateKey, { roles: ["coordinator"], scp: "events.read events.write", ...o });
    expect((await request(app).get("/api/me").set(auth(t))).status).toBe(401);
  });

  it("rejects a token signed by a different key", async () => {
    const { app, keys } = await setup();
    const t = await token(keys.evil.privateKey, { roles: ["coordinator"], scp: "events.read events.write" });
    expect((await request(app).get("/api/me").set(auth(t))).status).toBe(401);
  });

  it("accepts a valid token and reports roles from validated claims", async () => {
    const { app, coordinator } = await setup();
    const r = await request(app).get("/api/me").set(auth(coordinator));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ sub: "coord-1", roles: ["coordinator"] });
    expect(r.headers["cache-control"]).toContain("no-store");
  });
  void ISS; void AUD;
});

describe("validation, errors and consistency", () => {
  it("uses one JSON error shape with a request id", async () => {
    const { app, coordinator } = await setup();
    const r = await request(app).post("/api/events").set(auth(coordinator)).send({ title: "" });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatchObject({ code: "validation_error" });
    expect(Array.isArray(r.body.error.details)).toBe(true);
    expect(r.body.error.requestId).toBeTruthy();
    expect((await request(app).get("/api/events/99999")).body.error.code).toBe("not_found");
    expect((await request(app).get("/api/events/abc")).status).toBe(400);
  });

  it("rejects ends_at before starts_at and capacity below current registrations", async () => {
    const { app, coordinator, mkEvent } = await setup();
    const bad = await request(app).post("/api/events").set(auth(coordinator)).send({ venue_id: 1, title: "x", event_type: "workshop", starts_at: "2030-01-01T10:00:00Z", ends_at: "2030-01-01T09:00:00Z", capacity: 5 });
    expect(bad.status).toBe(422);
    const ev = await mkEvent(10);
    await request(app).post(`/api/events/${ev.id}/registrations`).set(auth(coordinator)).send({ seats: 6 });
    const low = await request(app).patch(`/api/events/${ev.id}`).set(auth(coordinator)).send({ capacity: 5, expected_version: 2 });
    expect(low.status).toBe(422);
  });

  it("detects stale edits with optimistic versioning", async () => {
    const { app, coordinator, mkEvent } = await setup();
    const ev = await mkEvent();
    const ok = await request(app).patch(`/api/events/${ev.id}`).set(auth(coordinator)).send({ title: "A", expected_version: 1 });
    expect(ok.status).toBe(200);
    const stale = await request(app).patch(`/api/events/${ev.id}`).set(auth(coordinator)).send({ title: "B", expected_version: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("version_conflict");
  });

  it("filters the public list by text, status, type, location and date", async () => {
    const { app, coordinator, mkEvent } = await setup();
    const a = await mkEvent(10, 24);
    await mkEvent(10, 48);
    await request(app).post(`/api/events/${a.id}/status`).set(auth(coordinator)).send({ status: "delayed", reason: "storm front" });
    expect((await request(app).get("/api/events?status=delayed")).body.total).toBe(1);
    expect((await request(app).get("/api/events?status=canceled")).body.total).toBe(0);
    expect((await request(app).get("/api/events?q=Test")).body.total).toBe(2);
    expect((await request(app).get("/api/events?location=chicago")).body.total).toBe(2);
    expect((await request(app).get("/api/events?location=nowhere")).body.total).toBe(0);
    expect((await request(app).get("/api/events?event_type=community")).body.total).toBe(0);
    expect((await request(app).get("/api/events?status=bogus")).status).toBe(422);
  });

  it("serves public lists as shared-cacheable and authenticated responses as private/no-store", async () => {
    const { app, coordinator } = await setup();
    expect((await request(app).get("/api/events")).headers["cache-control"]).toMatch(/public/);
    expect((await request(app).get("/api/me").set(auth(coordinator))).headers["cache-control"]).toMatch(/no-store/);
    expect((await request(app).get("/api/me")).headers["cache-control"]).toBe("private, no-store"); // even the 401 on an authenticated route
  });
});

describe("audit trail and status history", () => {
  it("records actor from the validated token with before/after, and cannot be altered", async () => {
    const { app, coordinator, mkEvent, db } = await setup();
    const ev = await mkEvent();
    await request(app).post(`/api/events/${ev.id}/status`).set(auth(coordinator)).send({ status: "delayed", reason: "lightning nearby" });
    const row = (await db.query<{ actor: string; before_json: string; after_json: string }>("SELECT * FROM audit_events WHERE action='event.status'"))[0]!;
    expect(row.actor).toBe("coord-1");
    expect(JSON.parse(row.before_json).status).toBe("scheduled");
    expect(JSON.parse(row.after_json)).toMatchObject({ status: "delayed", reason: "lightning nearby" });
    await expect(db.query("UPDATE audit_events SET actor='mallory'")).rejects.toThrow(/append-only/);
    await expect(db.query("DELETE FROM audit_events")).rejects.toThrow(/append-only/);
    await expect(db.query("TRUNCATE audit_events")).rejects.toThrow(/append-only/);
    const detail = await request(app).get(`/api/events/${ev.id}`);
    expect(detail.body.history[0]).toMatchObject({ from_status: "scheduled", to_status: "delayed", reason: "lightning nearby" });
  });

  it("a failed write leaves no audit row and no live event", async () => {
    const { app, coordinator, mkEvent, db } = await setup();
    const ev = await mkEvent(5);
    const before = (await db.query<{ c: number }>("SELECT COUNT(*)::int c FROM audit_events"))[0]!.c;
    const live = (await svc.latestLiveId(db));
    await request(app).post(`/api/events/${ev.id}/registrations`).set(auth(coordinator)).send({ seats: 6 });
    expect((await db.query<{ c: number }>("SELECT COUNT(*)::int c FROM audit_events"))[0]!.c).toBe(before);
    expect((await svc.latestLiveId(db))).toBe(live);
  });
});

describe("weather endpoint degrades without breaking the board", () => {
  it("returns 200 with an explicit unavailable state when the provider is down", async () => {
    const { app, mkEvent } = await setup({ fetchFn: async () => { throw new Error("down"); } });
    const ev = await mkEvent(10, 24);
    const r = await request(app).get(`/api/events/${ev.id}/weather`);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("unavailable");
    expect((await request(app).get("/api/events")).status).toBe(200);
  });
  it("says no forecast exists for events beyond the horizon", async () => {
    const { app, mkEvent } = await setup();
    const ev = await mkEvent(10, 24 * 12);
    expect((await request(app).get(`/api/events/${ev.id}/weather`)).body.status).toBe("out_of_range");
  });
});

describe("rate limiting", () => {
  it("throttles repeated authenticated-endpoint attempts with 429 and Retry-After", async () => {
    const { app } = await setup();
    let last = 200;
    let retry: string | undefined;
    for (let i = 0; i < 70; i++) { const r = await request(app).get("/api/me"); last = r.status; retry = r.headers["retry-after"]; if (last === 429) break; }
    expect(last).toBe(429);
    expect(retry).toBeTruthy();
  });
  it("failed-auth throttling never locks out a valid token coming from the same IP (regression)", async () => {
    const { app, coordinator, mkEvent } = await setup();
    const ev = await mkEvent(1000);
    for (let i = 0; i < 70; i++) await request(app).get("/api/me"); // exhaust the failed-auth budget for this IP
    expect((await request(app).get("/api/me")).status).toBe(429);   // anonymous junk is now refused with 429...
    const rs = await Promise.all(Array.from({ length: 35 }, () => request(app).post(`/api/events/${ev.id}/registrations`).set(auth(coordinator)).send({ seats: 1 })));
    expect(rs.filter((r) => r.status === 201).length).toBe(30);      // ...but the real coordinator still gets the full write budget
    expect(rs.filter((r) => r.status === 429).length).toBe(5);
    expect((await request(app).get("/api/me").set(auth(coordinator))).status).toBe(200);
  });
  it("throttles writes per actor", async () => {
    const { app, coordinator, mkEvent } = await setup();
    const ev = await mkEvent(1000);
    const rs = await Promise.all(Array.from({ length: 40 }, () => request(app).post(`/api/events/${ev.id}/registrations`).set(auth(coordinator)).send({ seats: 1 })));
    expect(rs.filter((r) => r.status === 201).length).toBe(30); // exactly the per-actor write budget
    expect(rs.filter((r) => r.status === 429).length).toBe(10);
  });
});

describe("CORS exact-origin allowlist and security headers", () => {
  it("allows only the configured origin", async () => {
    const { app } = await setup();
    const ok = await request(app).get("/api/events").set("Origin", "https://app.test");
    expect(ok.headers["access-control-allow-origin"]).toBe("https://app.test");
    const bad = await request(app).get("/api/events").set("Origin", "https://evil.test");
    expect(bad.headers["access-control-allow-origin"]).toBeUndefined();
    expect(ok.headers["vary"]).toMatch(/Origin/i);
    expect(bad.headers["vary"]).toMatch(/Origin/i); // a cached denial must not be served to the allowed origin
    const sub =await request(app).get("/api/events").set("Origin", "https://app.test.evil.test");
    expect(sub.headers["access-control-allow-origin"]).toBeUndefined();
  });
  it("sets HSTS, CSP, nosniff and hides the framework", async () => {
    const { app } = await setup();
    const r = await request(app).get("/healthz");
    expect(r.headers["strict-transport-security"]).toBeTruthy();
    expect(r.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["x-powered-by"]).toBeUndefined();
    expect(r.body).toMatchObject({ status: "ok", build: "test", db: null });
  });
  it("healthz is shallow by default (never touches the database) and checks it only with ?deep=1", async () => {
    const { app, db } = await setup();
    let queries = 0;
    const real = db.query.bind(db);
    db.query = (async (...args: Parameters<typeof real>) => { queries++; return real(...args); }) as typeof db.query;
    const shallow = await request(app).get("/healthz");
    expect(shallow.status).toBe(200);
    expect(queries).toBe(0);
    const deep = await request(app).get("/healthz?deep=1");
    expect(deep.body).toMatchObject({ status: "ok", db: true });
    expect(queries).toBe(1);
  });
});

describe("live updates (SSE) with replay and dedup ids", () => {
  it("persists ids that increase monotonically and replays only what a client missed", async () => {
    const { app, coordinator, mkEvent, db } = await setup();
    const ev = await mkEvent();
    const cursor = (await svc.latestLiveId(db));
    await request(app).post(`/api/events/${ev.id}/status`).set(auth(coordinator)).send({ status: "delayed", reason: "fog patch" });
    await request(app).post(`/api/events/${ev.id}/registrations`).set(auth(coordinator)).send({ seats: 2 });
    const missed = (await svc.liveSince(db, cursor));
    expect(missed.map((m) => m.type)).toEqual(["event.status", "event.capacity"]);
    expect(missed[1]!.id).toBeGreaterThan(missed[0]!.id);
    expect((await svc.liveSince(db, missed[1]!.id))).toEqual([]);
  });

  it("streams over HTTP: a reconnecting client with Last-Event-ID receives the missed events exactly once", async () => {
    const { app, coordinator, mkEvent, db } = await setup();
    const ev = await mkEvent();
    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    try {
      const cursor = (await svc.latestLiveId(db));
      // client is "disconnected" while two changes happen
      await request(app).post(`/api/events/${ev.id}/status`).set(auth(coordinator)).send({ status: "delayed", reason: "fog patch" });
      await request(app).post(`/api/events/${ev.id}/registrations`).set(auth(coordinator)).send({ seats: 3 });
      const ac = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port}/api/stream`, { headers: { "Last-Event-ID": String(cursor) }, signal: ac.signal });
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const reader = res.body!.getReader();
      let buf = "";
      const dec = new TextDecoder();
      while ((buf.match(/^id: /gm) ?? []).length < 2) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value); }
      // a live event while connected
      await request(app).post(`/api/events/${ev.id}/registrations`).set(auth(coordinator)).send({ seats: 1 });
      while ((buf.match(/^id: /gm) ?? []).length < 3) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value); }
      ac.abort();
      const ids = [...buf.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
      expect(ids.length).toBe(3);
      expect(new Set(ids).size).toBe(3); // no duplicates
      expect(ids).toEqual([...ids].sort((a, b) => a - b));
      expect(buf).toContain("event: event.status");
    } finally { server.close(); }
  });

  it("tells a client with a cursor ahead of the server to resync", async () => {
    const { app } = await setup();
    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    try {
      const ac = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port}/api/stream`, { headers: { "Last-Event-ID": "99999" }, signal: ac.signal });
      const reader = res.body!.getReader();
      let buf = "";
      while (!buf.includes("event: resync")) { const { value, done } = await reader.read(); if (done) break; buf += new TextDecoder().decode(value); }
      ac.abort();
      expect(buf).toContain("event: resync");
    } finally { server.close(); }
  });
});
