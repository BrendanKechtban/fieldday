import type { Transport } from "../src/mcp/protocol";

/** Plays the role of the MCP host: records what the app sends and lets tests push messages to it. */
export function fakeHost() {
  const sent: any[] = [];
  const subs = new Set<(m: unknown) => void>();
  let onSend: (m: any) => void = () => {};
  const transport: Transport = {
    send: (m) => { sent.push(m); onSend(m); },
    listen: (cb) => { subs.add(cb); return () => subs.delete(cb); },
  };
  return {
    transport, sent,
    push: (m: unknown) => subs.forEach((s) => s(m)),
    handle: (fn: (m: any) => void) => { onSend = fn; },
    reply: (id: number, result: unknown) => subs.forEach((s) => s({ jsonrpc: "2.0", id, result })),
  };
}
export const proposal = {
  token: "SECRET-CONFIRM-TOKEN-123",
  event: { id: 7, title: "Trail Safety Workshop", status: "scheduled", version: 3, capacity: 25, registered: 4, available: 21, starts_at: "2026-11-10T15:00:00.000Z", venue_name: "Pine Ridge", location: "Madison, WI" },
  proposal: { event_id: 7, from: "scheduled", to: "delayed", reason: "Thunderstorm forecast" },
  expires_in_ms: 300000,
};
