import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import type { Config } from "./config.js";
import { authenticate, requireAccess, HttpError, SCOPES, ROLES, type KeyResolver } from "./auth.js";
import type { DB } from "./db.js";
import * as svc from "./service.js";
import { WeatherClient, redact } from "./weather.js";
import { rateLimit, authFailureGuard } from "./ratelimit.js";
import { mountMcp } from "./mcp.js";
import { traceRequests } from "./telemetry.js";

export interface Deps { cfg: Config; db: DB; keys: KeyResolver; weather: WeatherClient }

const idParam = (req: Request): number => {
  const n = Number(req.params.id);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, "bad_request", "Invalid id");
  return n;
};
const ah = (fn: (req: Request, res: Response) => unknown | Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve().then(() => fn(req, res)).catch(next);
};

export function createApp(deps: Deps) {
  const { cfg, db, keys, weather } = deps;
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(helmet({
    contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], connectSrc: ["'self'", ...cfg.corsOrigins], imgSrc: ["'self'", "data:"], frameAncestors: ["'none'"] } },
    strictTransportSecurity: { maxAge: 31536000, includeSubDomains: true },
    referrerPolicy: { policy: "no-referrer" },
  }));
  // Exact-origin allowlist: requests from any other origin get no CORS headers.
  app.use(cors({
    origin: (origin, cb) => cb(null, !origin || cfg.corsOrigins.includes(origin)),
    methods: ["GET", "POST", "PATCH", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "Last-Event-ID", "traceparent", "tracestate"],
    maxAge: 600,
  }));
  app.use(traceRequests);
  app.use(express.json({ limit: "32kb" }));
  app.use((req, res, next) => {
    const rid = (req.headers["x-request-id"] as string | undefined)?.slice(0, 64) ?? randomUUID();
    res.setHeader("X-Request-Id", rid);
    (req as unknown as { rid: string }).rid = rid;
    const start = Date.now();
    res.on("finish", () => {
      // Path only (no query string), and redacted, so keys in URLs never reach logs.
      console.log(JSON.stringify({ t: new Date().toISOString(), rid, method: req.method, path: redact(req.path), status: res.statusCode, ms: Date.now() - start, build: cfg.buildSha }));
    });
    next();
  });

  const auth = authFailureGuard({ max: 60, windowMs: 60_000 }, authenticate(cfg, keys));
  const readLimit = rateLimit({ name: "read", max: 300, windowMs: 60_000 });
  const writeLimit = rateLimit({ name: "write", max: cfg.writeRateLimit, windowMs: 60_000, key: (r) => r.actor?.sub ?? r.ip ?? "x" });
  const weatherLimit = rateLimit({ name: "weather", max: 20, windowMs: 60_000 });
  const noStore = (_q: Request, res: Response, next: NextFunction) => { res.setHeader("Cache-Control", "private, no-store"); res.setHeader("Vary", "Authorization"); next(); };
  const publicCache = (_q: Request, res: Response, next: NextFunction) => { res.setHeader("Cache-Control", "public, max-age=10, stale-while-revalidate=30"); next(); };

  // Shallow by default: monitors and the platform probe this often, and on a scale-to-zero database every probe that touched
  // the database would keep it awake (and burn free-tier compute hours). Use ?deep=1 to also check the database.
  app.get("/healthz", ah(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (req.query.deep !== "1") { res.json({ status: "ok", build: cfg.buildSha, db: null }); return; }
    let dbOk = true;
    try { await db.query("SELECT 1"); } catch { dbOk = false; }
    res.status(dbOk ? 200 : 503).json({ status: dbOk ? "ok" : "degraded", build: cfg.buildSha, db: dbOk });
  }));

  // ---------- public, cacheable ----------
  app.get("/api/venues", readLimit, publicCache, ah(async (_q, res) => res.json({ items: await svc.listVenues(db) })));
  app.get("/api/events", readLimit, publicCache, ah(async (req, res) => res.json(await svc.listEvents(db, svc.ListQuery.parse(req.query)))));
  app.get("/api/events/:id", readLimit, publicCache, ah(async (req, res) => res.json(await svc.getEvent(db, idParam(req)))));
  app.get("/api/events/:id/weather", weatherLimit, publicCache, ah(async (req, res) => {
    const ev = await svc.getEvent(db, idParam(req));
    const result = await weather.forEvent(ev.lat, ev.lon, ev.starts_at);
    if (result.status === "fresh" && result.fetchedAt) {
      await db.query("INSERT INTO weather_snapshots(event_id,fetched_at,forecast_for,payload) VALUES ($1,$2,$3,$4)", [ev.id, result.fetchedAt, result.slotTime ?? ev.starts_at, JSON.stringify(result)]);
    }
    res.json(result); // degraded results are still 200: the board stays usable
  }));

  // Live updates (SSE). Public data only; ids are persisted so clients can resume with Last-Event-ID.
  app.get("/api/stream", ah(async (req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    const hdr = Number(req.headers["last-event-id"] ?? req.query.lastEventId ?? NaN);
    let closed = false;
    req.on("close", () => { closed = true; });
    const latest = await svc.latestLiveId(db);
    let last = Number.isFinite(hdr) ? hdr : latest;
    res.write("retry: 3000\n\n");
    const send = (id: number, type: string, data: string) => res.write(`id: ${id}\nevent: ${type}\ndata: ${data}\n\n`);
    const flush = async () => {
      if (closed) return;
      const rows = await svc.liveSince(db, last);
      for (const r of rows) { send(r.id, r.type, r.payload); last = r.id; }
    };
    if (Number.isFinite(hdr)) {
      // Client ahead of server (e.g. database reset) or too far behind: tell it to reload a snapshot.
      if (hdr > latest || latest - hdr > 500) { send(latest, "resync", JSON.stringify({ reason: hdr > latest ? "ahead" : "gap" })); last = latest; }
      else await flush();
    }
    // Flushes are chained so two quick notifications can never interleave and send events twice or out of order.
    let chain: Promise<void> = Promise.resolve();
    const onLive = () => { chain = chain.then(flush).catch((e) => console.error(redact(String((e as Error)?.message ?? e)))); };
    svc.bus.on("live", onLive);
    const hb = setInterval(() => res.write(": hb\n\n"), 25_000);
    const cleanup = () => { clearInterval(hb); svc.bus.off("live", onLive); };
    if (closed) cleanup(); else req.on("close", cleanup);
  }));

  // ---------- authenticated ----------
  app.get("/api/me", noStore, auth, ah((req, res) => res.json({ sub: req.actor!.sub, roles: req.actor!.roles, scopes: req.actor!.scopes })));

  const coordinator = [writeLimit, noStore, auth, requireAccess({ scope: SCOPES.write, role: ROLES.coordinator })];
  app.post("/api/events", noStore, auth, writeLimit, requireAccess({ scope: SCOPES.write, role: ROLES.coordinator }),
    ah(async (req, res) => res.status(201).json(await svc.createEvent(db, req.actor!.sub, svc.EventInput.parse(req.body)))));
  app.patch("/api/events/:id", noStore, auth, writeLimit, requireAccess({ scope: SCOPES.write, role: ROLES.coordinator }),
    ah(async (req, res) => res.json(await svc.updateEvent(db, req.actor!.sub, idParam(req), svc.EventPatch.parse(req.body)))));
  app.post("/api/events/:id/status", noStore, auth, writeLimit, requireAccess({ scope: SCOPES.write, role: ROLES.coordinator }),
    ah(async (req, res) => res.json(await svc.changeStatus(db, req.actor!.sub, idParam(req), svc.StatusInput.parse(req.body)))));
  app.post("/api/events/:id/registrations", noStore, auth, writeLimit, requireAccess({ scope: SCOPES.write, role: ROLES.coordinator }),
    ah(async (req, res) => res.status(201).json(await svc.registerSeats(db, req.actor!.sub, idParam(req), svc.RegisterInput.parse(req.body)))));
  void coordinator;

  mountMcp(app, { cfg, db, keys, weather });

  app.use("/api", (_req, _res, next) => next(new HttpError(404, "not_found", "No such route")));

  // Consistent JSON error shape: { error: { code, message, details?, requestId } }
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const requestId = (req as unknown as { rid?: string }).rid;
    let status = 500, code = "internal_error", message = "Unexpected server error", details: unknown;
    if (err instanceof HttpError) { status = err.status; code = err.code; message = err.message; details = err.details; }
    else if (err instanceof ZodError) { status = 422; code = "validation_error"; message = "Request validation failed"; details = err.issues.map((i) => ({ path: i.path.join("."), message: i.message })); }
    else if ((err as { type?: string })?.type === "entity.parse.failed") { status = 400; code = "bad_request"; message = "Malformed JSON"; }
    else console.error(redact(String((err as Error)?.stack ?? err)));
        // Errors are never cacheable; keep "private" when the route already marked itself private (authenticated routes).
    const priorCache = String(res.getHeader("Cache-Control") ?? "");
    res.status(status).setHeader("Cache-Control", priorCache.includes("private") ? "private, no-store" : "no-store").json({ error: { code, message, ...(details !== undefined ? { details } : {}), requestId } });
  });
  return app;
}
