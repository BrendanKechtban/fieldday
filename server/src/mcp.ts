import type { Express, Request, Response } from "express";
import { readFileSync, existsSync } from "node:fs";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Deps } from "./app.js";
import { bearer, verifyToken, HttpError, SCOPES, ROLES, type Actor } from "./auth.js";
import * as svc from "./service.js";

const UI_URI = "ui://fieldday/status-change";
const UI_MIME = "text/html;profile=mcp-app";

function loadUiHtml(): string {
  // Works from source (server/src), from the compiled build (server/dist/src) and when MCP_APP_HTML is set explicitly.
  const candidates = [process.env.MCP_APP_HTML, "../../web/dist/mcp-app.html", "../../../web/dist/mcp-app.html", "../../../../web/dist/mcp-app.html"]
    .filter((c): c is string => !!c)
    .map((c) => (c.startsWith("/") ? c : new URL(c, import.meta.url).pathname));
  const p = candidates.find((c) => existsSync(c));
  if (p) return readFileSync(p, "utf8");
  return "<!doctype html><meta charset=utf-8><title>FieldDay</title><body>MCP App bundle not built. Run npm run build -w web.</body>";
}

const text = (v: unknown, isError = false) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v) }], isError, ...(isError ? {} : { structuredContent: typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined }) });

/**
 * Every tool (read AND write) goes through run(): per-tool scope check, optional role check,
 * and an audit row written for every call, including denied and failed ones.
 */
function buildServer(deps: Deps, actor: Actor) {
  const { db, cfg, weather } = deps;
  const server = new McpServer({ name: "fieldday", version: "1.0.0" });

  async function run(tool: string, needs: { scope: string; role?: string }, args: unknown, fn: () => unknown | Promise<unknown>) {
    const redacted = JSON.parse(JSON.stringify(args ?? {}, (k, v) => (k === "confirmation_token" ? "[REDACTED]" : v)));
    try {
      if (!actor.scopes.includes(needs.scope)) throw new HttpError(403, "insufficient_scope", `Tool ${tool} requires scope ${needs.scope}`);
      if (needs.role && !actor.roles.includes(needs.role)) throw new HttpError(403, "forbidden", `Tool ${tool} requires role ${needs.role}`);
      const out = await fn();
      await svc.audit(db, actor.sub, `mcp.${tool}`, "mcp_tool", null, redacted, { ok: true }, "mcp");
      return text(out);
    } catch (e) {
      const err = e instanceof HttpError ? { code: e.code, message: e.message, details: e.details } : { code: "internal_error", message: "Tool failed" };
      try { await svc.audit(db, actor.sub, `mcp.${tool}`, "mcp_tool", null, redacted, { ok: false, ...err }, "mcp"); } catch { /* auditing a failure must not mask it */ }
      return text({ error: err }, true);
    }
  }

  server.registerResource("status-change-app", UI_URI, { title: "Status change confirmation", mimeType: UI_MIME }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: UI_MIME, text: loadUiHtml() }],
  }));

  const R = { scope: SCOPES.read };
  server.registerTool("search_events", {
    description: "Search events by text, status, type, location and date range.",
    inputSchema: { q: z.string().max(100).optional(), status: z.enum(svc.STATUSES).optional(), event_type: z.enum(svc.TYPES).optional(), location: z.string().max(100).optional(), limit: z.number().int().min(1).max(50).optional() },
    annotations: { readOnlyHint: true },
  }, (a) => run("search_events", R, a, () => svc.listEvents(db, svc.ListQuery.parse(a))));

  server.registerTool("get_event", {
    description: "Get one event with capacity, status history and availability.",
    inputSchema: { event_id: z.number().int().positive() },
    annotations: { readOnlyHint: true },
  }, (a) => run("get_event", R, a, () => svc.getEvent(db, a.event_id)));

  server.registerTool("get_event_weather", {
    description: "Get the advisory weather flag for an event. May be stale or unavailable; the result says so.",
    inputSchema: { event_id: z.number().int().positive() },
    annotations: { readOnlyHint: true },
  }, (a) => run("get_event_weather", R, a, async () => {
    const ev = await svc.getEvent(db, a.event_id);
    return weather.forEvent(ev.lat, ev.lon, ev.starts_at);
  }));

  // Step 1 of the confirmed write: a preview that changes nothing and returns a single-use token bound to this exact change.
  server.registerTool("propose_status_change", {
    description: "Preview a status change for an event. Changes nothing. Returns a single-use confirmation token valid only for this exact event, status and reason.",
    inputSchema: { event_id: z.number().int().positive(), new_status: z.enum(svc.STATUSES), reason: z.string().min(3).max(500) },
    annotations: { readOnlyHint: true },
    _meta: { ui: { resourceUri: UI_URI } },
  }, (a) => run("propose_status_change", { scope: SCOPES.write, role: ROLES.coordinator }, a, () => svc.createConfirmation(db, actor.sub, cfg.mcpConfirmTtlMs, a.event_id, a.new_status, a.reason)));

  // Step 2: executes only with a valid token for exactly this change. Same service function as REST.
  server.registerTool("change_event_status", {
    description: "Apply a previously proposed status change. Requires the confirmation_token from propose_status_change.",
    inputSchema: { event_id: z.number().int().positive(), new_status: z.enum(svc.STATUSES), confirmation_token: z.string().min(10) },
    annotations: { destructiveHint: true, readOnlyHint: false },
  }, (a) => run("change_event_status", { scope: SCOPES.write, role: ROLES.coordinator }, a, async () => {
    const c = await svc.consumeConfirmation(db, actor.sub, a.confirmation_token, a.event_id, a.new_status);
    return svc.changeStatus(db, actor.sub, a.event_id, { status: a.new_status, reason: c.reason, expected_version: c.expected_version }, "mcp");
  }));

  return server;
}

export function mountMcp(app: Express, deps: Deps) {
  const base = process.env.PUBLIC_BASE_URL ?? "";
  app.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.json({ resource: `${base}/mcp`, authorization_servers: [deps.cfg.issuer], scopes_supported: [SCOPES.read, SCOPES.write], bearer_methods_supported: ["header"] });
  });

  const handler = async (req: Request, res: Response) => {
    const t = bearer(req);
    let actor: Actor;
    try {
      if (!t) throw new Error("no token");
      actor = await verifyToken(t, deps.cfg, deps.keys);
    } catch {
      res.status(401).setHeader("WWW-Authenticate", `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`).json({ error: { code: "unauthenticated", message: "Valid bearer token required" } });
      return;
    }
    if (!actor.scopes.includes(SCOPES.read) && !actor.scopes.includes(SCOPES.write)) {
      res.status(403).json({ error: { code: "insufficient_scope", message: "Token has no FieldDay scope" } });
      return;
    }
    const server = buildServer(deps, actor);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };
  app.post("/mcp", handler);
  app.get("/mcp", (_req, res) => res.status(405).json({ error: { code: "method_not_allowed", message: "Stateless server: use POST" } }));
}
