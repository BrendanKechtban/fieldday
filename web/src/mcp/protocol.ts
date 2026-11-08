/* Minimal MCP Apps (ui/*) host bridge over postMessage JSON-RPC 2.0.
   Transport is injected so the protocol can be unit-tested with a fake host. */

export interface Transport {
  send(msg: unknown): void;
  /** Subscribe to messages that came from the host window. Returns an unsubscribe fn. */
  listen(cb: (msg: unknown) => void): () => void;
}

export interface ToolResult { content?: { type: string; text?: string }[]; structuredContent?: unknown; isError?: boolean }
export interface Proposal {
  token: string;
  event: { id: number; title: string; status: string; version: number; capacity: number; registered: number; available: number; starts_at: string; venue_name: string; location: string };
  proposal: { event_id: number; from: string; to: string; reason: string };
  expires_in_ms: number;
}

export function windowTransport(win: Window = window): Transport {
  return {
    send: (m) => win.parent.postMessage(m, "*"), // host origin is unknown to an iframe app; the host validates our messages
    listen: (cb) => {
      const f = (e: MessageEvent) => { if (e.source === win.parent) cb(e.data); }; // accept only the embedding host
      win.addEventListener("message", f);
      return () => win.removeEventListener("message", f);
    },
  };
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class HostBridge {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private resultCbs = new Set<(r: ToolResult) => void>();
  private off: () => void;

  constructor(private t: Transport) {
    this.off = t.listen((m) => this.onMessage(m));
  }

  private onMessage(m: unknown) {
    if (typeof m !== "object" || m === null) return;
    const msg = m as { jsonrpc?: string; id?: number; method?: string; params?: unknown; result?: unknown; error?: { message?: string } };
    if (msg.jsonrpc !== "2.0") return;
    if (typeof msg.id === "number" && !msg.method) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? "Host error")); else p.resolve(msg.result);
      return;
    }
    if (msg.method === "ui/notifications/tool-result") this.resultCbs.forEach((cb) => cb(msg.params as ToolResult));
  }

  private request<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.t.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** ui/initialize request, then the ui/notifications/initialized notification. */
  async initialize(): Promise<unknown> {
    const ctx = await this.request("ui/initialize", { protocolVersion: "2025-06-18", appInfo: { name: "fieldday-status-change", version: "1.0.0" }, appCapabilities: {} });
    this.t.send({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
    return ctx;
  }

  onToolResult(cb: (r: ToolResult) => void): () => void { this.resultCbs.add(cb); return () => this.resultCbs.delete(cb); }
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> { return this.request<ToolResult>("tools/call", { name, arguments: args }); }
  dispose() { this.off(); this.pending.forEach((p) => p.reject(new Error("Bridge closed"))); this.pending.clear(); this.resultCbs.clear(); }
}

/** Validates the propose_status_change result (structuredContent, or JSON text as a fallback). Returns null if unusable. */
export function parseProposal(r: ToolResult): Proposal | null {
  if (r.isError) return null;
  let v: unknown = r.structuredContent;
  if (!v) { try { v = JSON.parse(r.content?.find((c) => c.type === "text")?.text ?? ""); } catch { return null; } }
  const p = v as Partial<Proposal> | null;
  if (!p || typeof p.token !== "string" || !p.event || !p.proposal || typeof p.proposal.event_id !== "number" || typeof p.proposal.to !== "string" || typeof p.proposal.reason !== "string") return null;
  return p as Proposal;
}

export interface ToolError { code: string; message: string }
/** Extracts the server's { error: { code, message } } from a failed tool result. */
export function parseToolError(r: ToolResult): ToolError | null {
  if (!r.isError) return null;
  try {
    const e = (JSON.parse(r.content?.find((c) => c.type === "text")?.text ?? "{}") as { error?: ToolError }).error;
    if (e?.message) return { code: e.code ?? "error", message: e.message };
  } catch { /* fall through */ }
  return { code: "error", message: "The change could not be applied." };
}
