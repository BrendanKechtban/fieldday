import { generateKeyPair, SignJWT, type KeyLike } from "jose";
import { randomBytes } from "node:crypto";
import { openDb, migrateUp, type DB } from "../src/db.js";
import { createApp } from "../src/app.js";
import { WeatherClient, type FetchFn } from "../src/weather.js";
import { loadConfig } from "../src/config.js";
import * as svc from "../src/service.js";

export const ISS = "https://login.test/tenant/v2.0";
export const AUD = "api://fieldday-test";

export async function makeKeys() {
  const a = await generateKeyPair("RS256");
  const b = await generateKeyPair("RS256"); // an attacker's key
  return { good: a, evil: b };
}

export async function token(key: KeyLike, o: { sub?: string; roles?: string[]; scp?: string; iss?: string; aud?: string; expSec?: number } = {}) {
  return new SignJWT({ roles: o.roles ?? [], scp: o.scp ?? "" })
    .setProtectedHeader({ alg: "RS256" })
    .setSubject(o.sub ?? "user-1")
    .setIssuer(o.iss ?? ISS)
    .setAudience(o.aud ?? AUD)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + (o.expSec ?? 600))
    .sign(key);
}

/**
 * Test database. With TEST_DATABASE_URL set, tests run against a REAL Postgres server (each setup() gets its own schema, so runs
 * are isolated and true concurrency is exercised). Without it they fall back to an in-process PGlite so `npm test` needs no setup.
 */
const opened: { db: DB; schema?: string }[] = [];
let sharedPglite: DB | null = null; // one WASM database per test file (a fresh one per test exhausts memory), wiped between tests
export async function openTestDb(): Promise<DB> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    if (!sharedPglite) { sharedPglite = await openDb("pglite://memory"); opened.push({ db: sharedPglite }); }
    await sharedPglite.exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    return sharedPglite;
  }
  const schema = `t_${randomBytes(6).toString("hex")}`;
  const admin = await openDb(url, { max: 1 });
  await admin.exec(`CREATE SCHEMA ${schema}`);
  await admin.close();
  const db = await openDb(url, { schema, max: 4 });
  opened.push({ db, schema });
  return db;
}
export async function closeTestDbs() {
  const url = process.env.TEST_DATABASE_URL;
  const schemas = opened.filter((o) => o.schema).map((o) => o.schema!);
  await Promise.all(opened.splice(0).map((o) => o.db.close().catch(() => {})));
  sharedPglite = null;
  if (url && schemas.length) {
    const admin = await openDb(url, { max: 1 });
    for (const s of schemas) await admin.exec(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
    await admin.close();
  }
}

export async function setup(opts: { fetchFn?: FetchFn; weatherEnv?: Record<string, string> } = {}) {
  const k = await makeKeys();
  const db = await openTestDb();
  await migrateUp(db);
  const cfg = loadConfig({ OIDC_ISSUER: ISS, OIDC_AUDIENCE: AUD, OIDC_JWKS_URI: "unused", OPENWEATHER_API_KEY: "SECRETKEY123", CORS_ORIGINS: "https://app.test", BUILD_SHA: "test", ...opts.weatherEnv });
  const weather = new WeatherClient(cfg, opts.fetchFn ?? (async () => { throw new Error("network disabled in tests"); }), () => Date.now(), 1, () => {});
  const app = createApp({ cfg, db, keys: k.good.publicKey, weather });
  await db.query("INSERT INTO venues(name,location,lat,lon) VALUES ('Test Venue','Chicago, IL',41.88,-87.62)");
  const coordinator = await token(k.good.privateKey, { sub: "coord-1", roles: ["coordinator"], scp: "events.read events.write" });
  const viewer = await token(k.good.privateKey, { sub: "viewer-1", roles: ["viewer"], scp: "events.read" });
  const mkEvent = async (capacity = 40, startOffsetH = 24) => {
    const s = new Date(Date.now() + startOffsetH * 3600_000);
    return svc.createEvent(db, "setup", { venue_id: 1, title: "Test Event", description: "", event_type: "workshop", starts_at: s.toISOString(), ends_at: new Date(s.getTime() + 7200_000).toISOString(), capacity });
  };
  return { app, db, cfg, weather, keys: k, coordinator, viewer, mkEvent };
}
