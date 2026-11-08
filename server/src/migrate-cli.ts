import { loadConfig } from "./config.js";
import { openDb, migrateUp, migrateDown, currentVersion } from "./db.js";

const cmd = process.argv[2] ?? "up";
const url = loadConfig().databaseUrl;
if (!url) { console.error("DATABASE_URL is required"); process.exit(1); }
const db = await openDb(url);
try {
  if (cmd === "up") console.log("applied:", await migrateUp(db));
  else if (cmd === "down") console.log("reverted:", await migrateDown(db, Number(process.argv[3] ?? 1)));
  else console.log("version:", await currentVersion(db));
} finally { await db.close(); }
