import { describe, it, expect } from "vitest";
import { migrateUp, migrateDown, currentVersion, type DB } from "../src/db.js";
import { openTestDb } from "./helpers.js";

const tables = async (db: DB) =>
  (await db.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name <> 'schema_migrations'")).map((r) => r.table_name).sort();

describe("migrations", () => {
  it("applies, reverses completely, and re-applies", async () => {
    const db = await openTestDb();
    expect(await currentVersion(db)).toBe(0);
    await migrateUp(db);
    expect(await currentVersion(db)).toBe(1);
    expect(await tables(db)).toEqual(expect.arrayContaining(["venues", "events", "synthetic_registrations", "weather_snapshots", "audit_events"]));
    await migrateDown(db);
    expect(await currentVersion(db)).toBe(0);
    expect(await tables(db)).toEqual([]);
    // the trigger function is dropped too, not left behind
    expect(await db.query("SELECT proname FROM pg_proc WHERE proname = 'audit_events_immutable' AND pronamespace = current_schema()::regnamespace")).toEqual([]);
    await migrateUp(db);
    expect(await currentVersion(db)).toBe(1);
  });
  it("is idempotent when run twice", async () => {
    const db = await openTestDb();
    await migrateUp(db);
    expect(await migrateUp(db)).toEqual([]);
  });
  it("two instances migrating at the same time apply each migration exactly once", async () => {
    const db = await openTestDb();
    const results = await Promise.all([migrateUp(db), migrateUp(db), migrateUp(db)]);
    expect(results.flat()).toEqual([1]);
    expect(await currentVersion(db)).toBe(1);
  });
  it("has the justified status/start index and foreign keys enforced", async () => {
    const db = await openTestDb();
    await migrateUp(db);
    const idx = await db.query("SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_events_status_starts'");
    expect(idx.length).toBe(1);
    await expect(db.query("INSERT INTO events(venue_id,title,event_type,starts_at,ends_at,capacity,created_at,updated_at) VALUES (999,'x','workshop','2030-01-01T00:00:00Z','2030-01-01T01:00:00Z',1,'a','a')")).rejects.toThrow(/foreign key/i);
  });
  it("the database itself refuses registrations beyond capacity (CHECK constraint, independent of app code)", async () => {
    const db = await openTestDb();
    await migrateUp(db);
    await db.query("INSERT INTO venues(name,location,lat,lon) VALUES ('v','l',1,1)");
    await expect(db.query("INSERT INTO events(venue_id,title,event_type,starts_at,ends_at,capacity,registered,created_at,updated_at) VALUES (1,'x','workshop','2030-01-01T00:00:00Z','2030-01-01T01:00:00Z',5,6,'a','a')")).rejects.toThrow(/check/i);
  });
});
