import { startTelemetry } from "./telemetry.js";
startTelemetry();
import { loadConfig } from "./config.js";
import { openDb, migrateUp } from "./db.js";
import { makeKeyResolver } from "./auth.js";
import { WeatherClient } from "./weather.js";
import { createApp } from "./app.js";
import { seed } from "./service.js";

const cfg = loadConfig();
if (!cfg.issuer || !cfg.audience || !cfg.jwksUri) {
  console.error("OIDC_ISSUER, OIDC_AUDIENCE and OIDC_JWKS_URI are required");
  process.exit(1);
}
if (!cfg.databaseUrl) {
  console.error("DATABASE_URL is required (postgres://... or pglite://./dir for local dev)");
  process.exit(1);
}
const db = await openDb(cfg.databaseUrl);
await migrateUp(db);
if (process.env.SEED === "1") await seed(db);
const app = createApp({ cfg, db, keys: makeKeyResolver(cfg), weather: new WeatherClient(cfg) });
const server = app.listen(cfg.port, () => console.log(JSON.stringify({ msg: "listening", port: cfg.port, build: cfg.buildSha })));
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => server.close(() => { void db.close().finally(() => process.exit(0)); }));
