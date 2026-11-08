import { describe, it, expect } from "vitest";
import { HostBridge, parseProposal, parseToolError } from "../src/mcp/protocol";
import { fakeHost, proposal } from "./fakeHost";

describe("MCP Apps host bridge", () => {
  it("sends ui/initialize, then ui/notifications/initialized after the host replies", async () => {
    const h = fakeHost();
    h.handle((m) => { if (m.method === "ui/initialize") queueMicrotask(() => h.reply(m.id, { hostContext: {} })); });
    const b = new HostBridge(h.transport);
    await b.initialize();
    expect(h.sent.map((m) => m.method)).toEqual(["ui/initialize", "ui/notifications/initialized"]);
    expect(h.sent[0].jsonrpc).toBe("2.0");
  });
  it("delivers tool-result notifications and ignores non-JSON-RPC noise", () => {
    const h = fakeHost();
    const b = new HostBridge(h.transport);
    const got: unknown[] = [];
    b.onToolResult((r) => got.push(r));
    h.push("junk"); h.push({ method: "ui/notifications/tool-result", params: {} }); // no jsonrpc field -> ignored
    h.push({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: proposal } });
    expect(got).toHaveLength(1);
  });
  it("correlates tools/call responses by id and surfaces host errors", async () => {
    const h = fakeHost();
    const b = new HostBridge(h.transport);
    h.handle((m) => queueMicrotask(() => (m.params.name === "ok" ? h.reply(m.id, { content: [] }) : h.push({ jsonrpc: "2.0", id: m.id, error: { message: "denied" } }))));
    await expect(b.callTool("ok", {})).resolves.toEqual({ content: [] });
    await expect(b.callTool("bad", {})).rejects.toThrow("denied");
  });
  it("parses proposals from structuredContent or JSON text, rejects malformed", () => {
    expect(parseProposal({ structuredContent: proposal })?.proposal.to).toBe("delayed");
    expect(parseProposal({ content: [{ type: "text", text: JSON.stringify(proposal) }] })?.token).toBe(proposal.token);
    expect(parseProposal({ structuredContent: { token: 1 } })).toBeNull();
    expect(parseProposal({ isError: true, content: [] })).toBeNull();
  });
  it("extracts server error codes", () => {
    expect(parseToolError({ isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code: "bad_confirmation", message: "used" } }) }] })).toEqual({ code: "bad_confirmation", message: "used" });
    expect(parseToolError({ content: [] })).toBeNull();
  });
});
