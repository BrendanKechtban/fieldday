import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { setup, token } from "./helpers.js";

type Ctx = Awaited<ReturnType<typeof setup>>;
let c: Ctx;
beforeEach(async () => { c = await setup(); });

let rpcId = 0;
/** Streamable-HTTP MCP, JSON response mode, stateless: one JSON-RPC request per POST. */
async function rpc(bearerToken: string | null, method: string, params?: unknown) {
  const req = request(c.app).post("/mcp").set("Accept", "application/json, text/event-stream").set("Content-Type", "application/json");
  if (bearerToken) req.set("Authorization", `Bearer ${bearerToken}`);
  return req.send({ jsonrpc: "2.0", id: ++rpcId, method, params });
}
async function call(bearerToken: string | null, name: string, args: Record<string, unknown>) {
  const res = await rpc(bearerToken, "tools/call", { name, arguments: args });
  const result = res.body?.result;
  const payload = result ? JSON.parse(result.content[0].text) : null;
  return { res, isError: !!result?.isError, payload };
}
const auditRows = () => c.db.query<{ actor: string; action: string; after_json: string; before_json: string; channel: string }>("SELECT actor, action, after_json, before_json, channel FROM audit_events WHERE channel='mcp' ORDER BY id");

describe("MCP: authentication", () => {
  it("rejects a missing token with 401 and a WWW-Authenticate pointer to the resource metadata", async () => {
    const r = await rpc(null, "tools/list");
    expect(r.status).toBe(401);
    expect(r.headers["www-authenticate"]).toMatch(/^Bearer resource_metadata=/);
  });
  it("rejects a token signed by an attacker's key", async () => {
    const forged = await token(c.keys.evil.privateKey, { roles: ["coordinator"], scp: "events.read events.write" });
    expect((await rpc(forged, "tools/list")).status).toBe(401);
  });
  it("rejects a valid token that carries no FieldDay scope at all", async () => {
    const t = await token(c.keys.good.privateKey, { roles: ["coordinator"], scp: "openid profile" });
    expect((await rpc(t, "tools/list")).status).toBe(403);
  });
  it("publishes protected-resource metadata", async () => {
    const r = await request(c.app).get("/.well-known/oauth-protected-resource");
    expect(r.status).toBe(200);
    expect(r.body.scopes_supported).toEqual(["events.read", "events.write"]);
  });
});

describe("MCP: tools and per-tool scope checks (read AND write)", () => {
  it("lists all five tools for an authorised caller", async () => {
    const r = await rpc(c.viewer, "tools/list");
    expect(r.status).toBe(200);
    const names = r.body.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(["change_event_status", "get_event", "get_event_weather", "propose_status_change", "search_events"]);
  });

  it("read tools work with the read scope", async () => {
    await c.mkEvent(40);
    const s = await call(c.viewer, "search_events", { q: "Test" });
    expect(s.isError).toBe(false);
    expect(s.payload.items).toHaveLength(1);
    const g = await call(c.viewer, "get_event", { event_id: 1 });
    expect(g.payload.available).toBe(40);
    const w = await call(c.viewer, "get_event_weather", { event_id: 1 });
    expect(w.isError).toBe(false);
    expect(["unavailable", "stale", "fresh", "out_of_range"]).toContain(w.payload.status);
  });

  it("a read tool is DENIED to a token that only has the write scope (scope is checked per tool, not just on writes)", async () => {
    const writeOnly = await token(c.keys.good.privateKey, { sub: "w-only", roles: ["coordinator"], scp: "events.write" });
    await c.mkEvent();
    const r = await call(writeOnly, "search_events", {});
    expect(r.isError).toBe(true);
    expect(r.payload.error.code).toBe("insufficient_scope");
  });

  it("a read-only token cannot propose or execute a write", async () => {
    await c.mkEvent();
    const p = await call(c.viewer, "propose_status_change", { event_id: 1, new_status: "delayed", reason: "rain expected" });
    expect(p.isError).toBe(true);
    expect(p.payload.error.code).toBe("insufficient_scope");
    const x = await call(c.viewer, "change_event_status", { event_id: 1, new_status: "delayed", confirmation_token: "x".repeat(32) });
    expect(x.isError).toBe(true);
    expect(x.payload.error.code).toBe("insufficient_scope");
    expect((await c.db.query("SELECT status FROM events WHERE id=1"))[0]).toEqual({ status: "scheduled" });
  });

  it("the write scope is not enough without the coordinator role", async () => {
    const noRole = await token(c.keys.good.privateKey, { sub: "norole", roles: ["viewer"], scp: "events.read events.write" });
    await c.mkEvent();
    const p = await call(noRole, "propose_status_change", { event_id: 1, new_status: "delayed", reason: "rain expected" });
    expect(p.isError).toBe(true);
    expect(p.payload.error.code).toBe("forbidden");
  });
});

describe("MCP: confirmed write is bound to the exact proposed change", () => {
  const propose = async (tok: string, event_id = 1, new_status = "delayed", reason = "lightning in the forecast") => {
    const p = await call(tok, "propose_status_change", { event_id, new_status, reason });
    expect(p.isError).toBe(false);
    return p.payload as { token: string; event: { version: number }; proposal: { from: string; to: string; reason: string } };
  };

  it("propose changes nothing; confirm applies exactly that change with the stored reason, via the same service as REST", async () => {
    await c.mkEvent();
    const p = await propose(c.coordinator);
    expect(p.proposal).toMatchObject({ from: "scheduled", to: "delayed", reason: "lightning in the forecast" });
    expect((await c.db.query("SELECT status FROM events WHERE id=1"))[0]).toEqual({ status: "scheduled" });

    const done = await call(c.coordinator, "change_event_status", { event_id: 1, new_status: "delayed", confirmation_token: p.token });
    expect(done.isError).toBe(false);
    expect(done.payload.status).toBe("delayed");
    const hist = (await c.db.query("SELECT to_status, reason, actor FROM event_status_history WHERE event_id=1 ORDER BY id DESC LIMIT 1"))[0];
    expect(hist).toEqual({ to_status: "delayed", reason: "lightning in the forecast", actor: "coord-1" });
  });

  it("a confirmation is single-use, not a reusable 'yes'", async () => {
    await c.mkEvent();
    const p = await propose(c.coordinator);
    const args = { event_id: 1, new_status: "delayed", confirmation_token: p.token };
    expect((await call(c.coordinator, "change_event_status", args)).isError).toBe(false);
    const again = await call(c.coordinator, "change_event_status", args);
    expect(again.isError).toBe(true);
    expect(again.payload.error.code).toBe("bad_confirmation");
  });

  it("a token for 'delayed' cannot be replayed to cancel, and cannot be used on another event", async () => {
    await c.mkEvent(); await c.mkEvent();
    const p = await propose(c.coordinator, 1, "delayed");
    const wrongStatus = await call(c.coordinator, "change_event_status", { event_id: 1, new_status: "canceled", confirmation_token: p.token });
    expect(wrongStatus.payload.error.code).toBe("bad_confirmation");
    const wrongEvent = await call(c.coordinator, "change_event_status", { event_id: 2, new_status: "delayed", confirmation_token: p.token });
    expect(wrongEvent.payload.error.code).toBe("bad_confirmation");
    expect(await c.db.query("SELECT status FROM events ORDER BY id")).toEqual([{ status: "scheduled" }, { status: "scheduled" }]);
  });

  it("another coordinator cannot spend my confirmation token", async () => {
    await c.mkEvent();
    const p = await propose(c.coordinator);
    const other = await token(c.keys.good.privateKey, { sub: "coord-2", roles: ["coordinator"], scp: "events.read events.write" });
    const r = await call(other, "change_event_status", { event_id: 1, new_status: "delayed", confirmation_token: p.token });
    expect(r.payload.error.code).toBe("bad_confirmation");
  });

  it("an event changed after the proposal makes the stale confirmation fail with a version conflict", async () => {
    await c.mkEvent();
    const p = await propose(c.coordinator);
    await request(c.app).patch("/api/events/1").set("Authorization", `Bearer ${c.coordinator}`).send({ title: "Renamed", expected_version: 1 }).expect(200);
    const r = await call(c.coordinator, "change_event_status", { event_id: 1, new_status: "delayed", confirmation_token: p.token });
    expect(r.isError).toBe(true);
    expect(r.payload.error.code).toBe("version_conflict");
  });
});

describe("MCP: every call is audited, secrets are not", () => {
  it("writes an audit row for successful, denied and failed calls and redacts the confirmation token", async () => {
    await c.mkEvent();
    await call(c.viewer, "get_event", { event_id: 1 });
    await call(c.viewer, "propose_status_change", { event_id: 1, new_status: "delayed", reason: "rain expected" }); // denied
    const p = (await call(c.coordinator, "propose_status_change", { event_id: 1, new_status: "delayed", reason: "rain expected" })).payload;
    await call(c.coordinator, "change_event_status", { event_id: 1, new_status: "delayed", confirmation_token: p.token });
    await call(c.coordinator, "change_event_status", { event_id: 1, new_status: "delayed", confirmation_token: p.token }); // replay -> fails

    const all = await auditRows();
    // The successful write ALSO leaves its own data-change row (actor from the validated token, channel 'mcp').
    expect(all.filter((r) => r.action === "event.status").map((r) => r.actor)).toEqual(["coord-1"]);
    const rows = all.filter((r) => r.action.startsWith("mcp."));
    expect(rows.map((r) => `${r.actor}:${r.action}:${JSON.parse(r.after_json).ok}`)).toEqual([
      "viewer-1:mcp.get_event:true",
      "viewer-1:mcp.propose_status_change:false",
      "coord-1:mcp.propose_status_change:true",
      "coord-1:mcp.change_event_status:true",
      "coord-1:mcp.change_event_status:false",
    ]);
    const everything = JSON.stringify(await c.db.query("SELECT before_json, after_json FROM audit_events"));
    expect(everything).not.toContain(p.token);
    expect(rows.find((r) => r.action === "mcp.change_event_status")!.before_json).toContain("[REDACTED]");
  });
});
