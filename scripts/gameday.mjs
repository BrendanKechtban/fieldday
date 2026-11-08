#!/usr/bin/env node
// Game Day driver. Starts its own isolated stack (dev IdP + stub weather provider + real API process on a temp DB),
// runs a scenario, prints raw observations and a PASS/FAIL verdict per assertion, exits non-zero on any FAIL.
// Database: set GAMEDAY_DATABASE_URL to a Postgres server URL (any database on it) and each scenario gets its own throwaway
// database on that server, so concurrency is REAL. Without it the API runs on in-process PGlite, which serializes queries, so
// the capacity scenario still checks correctness but proves less about real concurrency (the output says which one ran).
//   node scripts/gameday.mjs capacity | rate-limit | weather-timeout | sse-recovery | all
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startDevIdp } from "./dev-idp.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  -> ${detail}` : ""}`); if (!ok) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function makeDb() {
  const admin = process.env.GAMEDAY_DATABASE_URL;
  if (!admin) {
    const dir = mkdtempSync(join(tmpdir(), "fieldday-gd-"));
    console.log("database: in-process PGlite (set GAMEDAY_DATABASE_URL for real Postgres concurrency)");
    return { url: `pglite://${join(dir, "pg")}`, async drop() { rmSync(dir, { recursive: true, force: true }); } };
  }
  const name = `gd_${randomBytes(5).toString("hex")}`;
  const run = async (sql) => { const c = new pg.Client({ connectionString: admin }); await c.connect(); try { await c.query(sql); } finally { await c.end(); } };
  await run(`CREATE DATABASE ${name}`);
  const u = new URL(admin); u.pathname = `/${name}`;
  console.log(`database: real Postgres (throwaway database ${name})`);
  return { url: u.toString(), async drop() { await run(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } };
}

async function stack(extraEnv = {}) {
  const idp = await startDevIdp();
  const stub = { mode: "ok", hits: 0 };
  const stubServer = http.createServer((req, res) => {
    stub.hits++;
    if (stub.mode === "hang") return; // never answers: the client's timeout must fire
    const now = Math.floor(Date.now() / 1000);
    const list = Array.from({ length: 40 }, (_, i) => ({ dt: now + i * 10800, main: { temp: 18 }, wind: { speed: 3 }, pop: 0.1, weather: [{ description: "partly cloudy" }] }));
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ list }));
  });
  await new Promise((r) => stubServer.listen(0, "127.0.0.1", r));
  const database = await makeDb();
  const port = 20000 + Math.floor(Math.random() * 20000);
  const env = {
    ...process.env, PORT: String(port), DATABASE_URL: database.url, SEED: "1", BUILD_SHA: "gameday",
    OIDC_ISSUER: idp.issuer, OIDC_AUDIENCE: idp.audience, OIDC_JWKS_URI: idp.jwksUri,
    OPENWEATHER_API_KEY: "stub-key-must-not-leak", OPENWEATHER_BASE_URL: `http://127.0.0.1:${stubServer.address().port}/forecast`,
    WEATHER_TIMEOUT_MS: "500", WEATHER_MAX_RETRIES: "2", WEATHER_CACHE_TTL_MS: "1500", ...extraEnv,
  };
  const child = spawn(process.execPath, ["--import", "tsx", "server/src/index.ts"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let logs = ""; child.stdout.on("data", (d) => (logs += d)); child.stderr.on("data", (d) => (logs += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* starting */ } await sleep(250); }
  const coord = await idp.coordinatorToken();
  const api = (path, init = {}) => fetch(`${base}${path}`, { ...init, headers: { "Content-Type": "application/json", ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}), ...init.headers } });
  return { base, api, coord, stub, logs: () => logs, async stop() { const exited = new Promise((res) => child.once("exit", res)); child.kill("SIGTERM"); await Promise.race([exited, sleep(5000)]); await idp.close(); stubServer.close(); stubServer.closeAllConnections?.(); await database.drop(); } };
}

async function capacity() {
  console.log("\n=== Game Day: capacity can never be exceeded under concurrent requests ===");
  // The write rate limit is raised for THIS scenario only, so that all 30 requests reach the capacity guard (the rate-limit
  // scenario below uses the real default of 30/min and proves that boundary separately).
  const s = await stack({ WRITE_RATE_LIMIT: "500" });
  try {
    const mk = await (await s.api("/api/events", { method: "POST", token: s.coord, body: JSON.stringify({ venue_id: 1, title: "Capacity drill", event_type: "workshop", starts_at: new Date(Date.now() + 864e5).toISOString(), ends_at: new Date(Date.now() + 864e5 + 72e5).toISOString(), capacity: 40 }) })).json();
    const seed = await s.api(`/api/events/${mk.id}/registrations`, { method: "POST", token: s.coord, body: JSON.stringify({ seats: 31 }) });
    check("setup: 31 of 40 places taken", seed.status === 201);
    const before = await (await s.api(`/api/events/${mk.id}`)).json();
    console.log(`before: capacity=${before.capacity} registered=${before.registered} available=${before.available}   (hand-predicted: 9)`);
    check("hand-predicted availability is 9", before.available === 9);

    const over = await s.api(`/api/events/${mk.id}/registrations`, { method: "POST", token: s.coord, body: JSON.stringify({ seats: 10 }) });
    const overBody = await over.json();
    const afterOver = await (await s.api(`/api/events/${mk.id}`)).json();
    check("request for 10 places fails with 409 capacity_exceeded", over.status === 409 && overBody.error.code === "capacity_exceeded", `${over.status} ${overBody.error.code}`);
    check("count unchanged after the failed request", afterOver.registered === 31, `registered=${afterOver.registered}`);

    // 30 simultaneous 2-seat requests against 9 free places: exactly 4 can win (8 seats).
    const results = await Promise.all(Array.from({ length: 30 }, () => s.api(`/api/events/${mk.id}/registrations`, { method: "POST", token: s.coord, body: JSON.stringify({ seats: 2 }) }).then((r) => r.status)));
    const ok = results.filter((x) => x === 201).length, conflict = results.filter((x) => x === 409).length, limited = results.filter((x) => x === 429).length;
    const final = await (await s.api(`/api/events/${mk.id}`)).json();
    console.log(`30 concurrent 2-seat requests -> 201:${ok} 409:${conflict} 429(rate limit):${limited}; final registered=${final.registered}/${final.capacity}`);
    check("registered never exceeds capacity", final.registered <= final.capacity, `${final.registered}<=${final.capacity}`);
    check("accepted seats match successful requests exactly", final.registered === 31 + ok * 2, `31 + ${ok}*2 = ${31 + ok * 2}`);
    check("at most 4 two-seat requests could fit in 9 places", ok <= 4, `ok=${ok}`);
    check("exactly 4 two-seat requests won (8 of the 9 free places), the other 26 got 409", ok === 4 && conflict === 26, `201:${ok} 409:${conflict}`);
    check("every one of the 30 requests reached the capacity guard (none were rate-limited)", limited === 0, `429s=${limited}`);
  } finally { await s.stop(); }
}

async function weatherTimeout() {
  console.log("\n=== Game Day: weather provider times out while a coordinator changes status ===");
  const s = await stack();
  try {
    const list = await (await s.api("/api/events?status=scheduled")).json();
    const ev = list.items.find((e) => Date.parse(e.starts_at) > Date.now() && Date.parse(e.starts_at) < Date.now() + 4 * 864e5);
    const w1 = await (await s.api(`/api/events/${ev.id}/weather`)).json();
    check("baseline: provider healthy -> fresh forecast", w1.status === "fresh", `status=${w1.status} flag=${w1.flag}`);
    await sleep(1700); // let the 1.5 s cache TTL expire so the next call must hit the provider
    s.stub.mode = "hang"; s.stub.hits = 0;
    const t0 = Date.now();
    const [w2, st] = await Promise.all([
      s.api(`/api/events/${ev.id}/weather`).then((r) => r.json()).then((j) => ({ j, ms: Date.now() - t0 })),
      s.api(`/api/events/${ev.id}/status`, { method: "POST", token: s.coord, body: JSON.stringify({ status: "delayed", reason: "Game Day: provider timeout drill" }) }).then(async (r) => ({ code: r.status, ms: Date.now() - t0 })),
    ]);
    console.log(`weather: status=${w2.j.status} after ${w2.ms} ms; provider attempts=${s.stub.hits}; message="${w2.j.message}"`);
    console.log(`coordinator status change: HTTP ${st.code} in ${st.ms} ms (while weather was still retrying)`);
    check("bounded retries: 1 try + 2 retries = 3 provider attempts, no more", s.stub.hits === 3, `attempts=${s.stub.hits}`);
    check("visible degradation: stale result labelled with the last successful timestamp", w2.j.status === "stale" && !!w2.j.fetchedAt && /last successful forecast from/.test(w2.j.message), w2.j.fetchedAt);
    check("core function unaffected: status change succeeded", st.code === 200);
    check("status change was not blocked by the slow provider", st.ms < w2.ms, `${st.ms} ms < ${w2.ms} ms`);
    const detail = await (await s.api(`/api/events/${ev.id}`)).json();
    check("event is now 'delayed' with the reason in its history", detail.status === "delayed" && detail.history[0].reason.includes("Game Day"));
    check("API key never appears in server logs", !s.logs().includes("stub-key-must-not-leak"));
  } finally { await s.stop(); }
}

async function sseRecovery() {
  console.log("\n=== Game Day: disconnect a live viewer, change data, reconnect, recover without loss or duplicates ===");
  const s = await stack();
  try {
    const collect = async (headers, ms) => {
      const ac = new AbortController(); const got = [];
      const res = await fetch(`${s.base}/api/stream`, { headers, signal: ac.signal });
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
      const timer = setTimeout(() => ac.abort(), ms);
      try { for (;;) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value); const parts = buf.split("\n\n"); buf = parts.pop(); for (const p of parts) { const id = /^id: (\d+)/m.exec(p); const ev = /^event: (.+)$/m.exec(p); if (id) got.push({ id: Number(id[1]), type: ev?.[1] }); } } } catch { /* aborted */ }
      clearTimeout(timer); return got;
    };
    const first = collect({}, 1200); await sleep(300);
    await s.api("/api/events/1/status", { method: "POST", token: s.coord, body: JSON.stringify({ status: "delayed", reason: "live drill A" }) });
    const seenBefore = await first;
    const lastSeen = seenBefore.at(-1)?.id ?? 0;
    console.log(`viewer saw ids [${seenBefore.map((e) => e.id)}] then disconnected (lastSeen=${lastSeen})`);
    await s.api("/api/events/1/registrations", { method: "POST", token: s.coord, body: JSON.stringify({ seats: 3 }) });
    await s.api("/api/events/2/status", { method: "POST", token: s.coord, body: JSON.stringify({ status: "canceled", reason: "live drill B" }) });
    await s.api("/api/events/1/status", { method: "POST", token: s.coord, body: JSON.stringify({ status: "scheduled", reason: "live drill C" }) });
    const replay = await collect({ "Last-Event-ID": String(lastSeen) }, 1200);
    const ids = replay.map((e) => e.id);
    console.log(`reconnected with Last-Event-ID=${lastSeen}; received ids [${ids}] types [${replay.map((e) => e.type)}]`);
    check("exactly the 3 missed changes were replayed", replay.length === 3, `count=${replay.length}`);
    check("no duplicates and strictly increasing ids", new Set(ids).size === ids.length && ids.every((v, i) => i === 0 || v > ids[i - 1]));
    check("nothing at or before lastSeen is re-sent", ids.every((v) => v > lastSeen));
    const ahead = await collect({ "Last-Event-ID": "999999" }, 800);
    check("a client ahead of the server (e.g. after a DB reset) is told to resync, not left silent", ahead.some((e) => e.type === "resync"));
  } finally { await s.stop(); }
}

async function rateLimit() {
  console.log("\n=== Rate limiting: login/auth-check, writes, third-party-backed endpoint ===");
  const s = await stack();
  try {
    const burst = async (n, mk) => { const codes = []; for (let i = 0; i < n; i++) codes.push((await mk()).status); return codes; };
    const summarize = (codes) => { const first429 = codes.indexOf(429); return { ok: codes.filter((c) => c !== 429).length, limited: codes.filter((c) => c === 429).length, first429: first429 < 0 ? null : first429 + 1 }; };
    const auth = summarize(await burst(70, () => s.api("/api/me")));
    console.log(`auth endpoint (/api/me, no token) x70 -> allowed=${auth.ok} limited=${auth.limited} first 429 at request #${auth.first429}`);
    check("failed auth attempts are rate limited (limit 60 failures/min/IP)", auth.ok === 60 && auth.limited === 10, `allowed=${auth.ok} limited=${auth.limited}`);
    const wk = summarize(await burst(40, () => s.api("/api/events/1/registrations", { method: "POST", token: s.coord, body: JSON.stringify({ seats: 1 }) })));
    console.log(`writes (coordinator) x40 -> allowed=${wk.ok} limited=${wk.limited} first 429 at request #${wk.first429}`);
    check("a valid coordinator is NOT locked out by the earlier junk auth traffic from the same IP, and gets exactly the 30/min write budget", wk.ok === 30 && wk.limited === 10, `allowed=${wk.ok} limited=${wk.limited}`);
    const list = await (await s.api("/api/events?status=scheduled")).json();
    const ev = list.items.find((e) => Date.parse(e.starts_at) > Date.now() && Date.parse(e.starts_at) < Date.now() + 4 * 864e5);
    const wx = summarize(await burst(25, () => s.api(`/api/events/${ev.id}/weather`)));
    console.log(`third-party-backed (/weather) x25 -> allowed=${wx.ok} limited=${wx.limited} first 429 at request #${wx.first429}; provider hits=${s.stub.hits} (cache absorbs repeats)`);
    check("third-party-backed endpoint is rate limited (limit 20/min)", wx.ok === 20 && wx.limited === 5, `allowed=${wx.ok} limited=${wx.limited}`);
    check("provider was called far fewer times than requests (cache)", s.stub.hits <= 2, `hits=${s.stub.hits}`);
    const r = await s.api("/api/me");
    console.log(`429 body: ${JSON.stringify(await r.json())}  Retry-After: ${r.headers.get("retry-after")}`);
  } finally { await s.stop(); }
}

const which = process.argv[2] ?? "all";
const scenarios = { capacity, "rate-limit": rateLimit, "weather-timeout": weatherTimeout, "sse-recovery": sseRecovery };
if (which !== "all" && !scenarios[which]) { console.error(`unknown scenario '${which}'. Use: ${Object.keys(scenarios).join(" | ")} | all`); process.exit(2); }
for (const [name, fn] of Object.entries(scenarios)) if (which === "all" || which === name) await fn();
console.log(failures ? `\n${failures} assertion(s) FAILED` : "\nall assertions passed");
process.exit(failures ? 1 : 0);
