export interface Migration { version: number; name: string; up: string; down: string }

export const migrations: Migration[] = [
  {
    version: 1,
    name: "init",
    up: `
CREATE TABLE venues (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  location TEXT NOT NULL,
  lat DOUBLE PRECISION NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lon DOUBLE PRECISION NOT NULL CHECK (lon BETWEEN -180 AND 180)
);
CREATE TABLE events (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  venue_id INTEGER NOT NULL REFERENCES venues(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  event_type TEXT NOT NULL CHECK (event_type IN ('workshop','recreation','community')),
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  capacity INTEGER NOT NULL CHECK (capacity >= 0),
  registered INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','delayed','canceled','completed')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (registered >= 0 AND registered <= capacity),
  CHECK (ends_at > starts_at)
);
-- Justified index: the public list filters by status and orders by start time.
CREATE INDEX idx_events_status_starts ON events(status, starts_at);
CREATE TABLE synthetic_registrations (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id),
  label TEXT NOT NULL,
  seats INTEGER NOT NULL CHECK (seats > 0),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_regs_event ON synthetic_registrations(event_id);
CREATE TABLE weather_snapshots (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id),
  fetched_at TEXT NOT NULL,
  forecast_for TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX idx_weather_event ON weather_snapshots(event_id, fetched_at);
CREATE TABLE event_status_history (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  reason TEXT NOT NULL,
  actor TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX idx_hist_event ON event_status_history(event_id, id);
CREATE TABLE audit_events (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  before_json TEXT,
  after_json TEXT,
  channel TEXT NOT NULL DEFAULT 'rest'
);
-- Append-only: block UPDATE, DELETE and TRUNCATE at the database level.
CREATE FUNCTION audit_events_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END;
$$;
CREATE TRIGGER audit_no_update_delete BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON audit_events FOR EACH STATEMENT EXECUTE FUNCTION audit_events_immutable();
CREATE TABLE live_events (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE TABLE mcp_confirmations (
  token_hash TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  event_id INTEGER NOT NULL,
  new_status TEXT NOT NULL,
  reason TEXT NOT NULL,
  expected_version INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
`,
    down: `
DROP TABLE mcp_confirmations;
DROP TABLE live_events;
DROP TRIGGER audit_no_truncate ON audit_events;
DROP TRIGGER audit_no_update_delete ON audit_events;
DROP FUNCTION audit_events_immutable();
DROP TABLE audit_events;
DROP TABLE event_status_history;
DROP TABLE weather_snapshots;
DROP TABLE synthetic_registrations;
DROP INDEX idx_events_status_starts;
DROP TABLE events;
DROP TABLE venues;
`,
  },
];
