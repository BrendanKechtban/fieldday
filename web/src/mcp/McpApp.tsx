import { useEffect, useRef, useState } from "react";
import { HostBridge, parseProposal, parseToolError, windowTransport, type Proposal, type Transport } from "./protocol";

type Phase = { k: "connecting" } | { k: "waiting" } | { k: "review"; p: Proposal } | { k: "applying"; p: Proposal } | { k: "done"; p: Proposal } | { k: "failed"; p: Proposal; code: string; message: string } | { k: "cancelled" } | { k: "bad" };

const HINTS: Record<string, string> = {
  bad_confirmation: "This confirmation is no longer valid (already used, expired, or for a different change). Ask for a new proposal.",
  version_conflict: "The event changed after this proposal was made. Ask for a new proposal.",
  insufficient_scope: "Your token is read-only, so this change cannot be applied.",
  forbidden: "Your account is not a coordinator, so this change cannot be applied.",
};

export function McpApp({ transport }: { transport?: Transport }) {
  const [phase, setPhase] = useState<Phase>({ k: "connecting" });
  const bridge = useRef<HostBridge | null>(null);
  // The single-use confirmation token is held only here (a ref): never rendered, never logged.
  const token = useRef<string | null>(null);

  useEffect(() => {
    const b = new HostBridge(transport ?? windowTransport());
    bridge.current = b;
    let live = true; // ignore results from a bridge disposed by StrictMode's double mount
    const off = b.onToolResult((r) => {
      if (!live) return;
      const p = parseProposal(r);
      if (!p) { setPhase({ k: "bad" }); return; }
      token.current = p.token;
      setPhase({ k: "review", p: { ...p, token: "" } });
    });
    b.initialize().then(() => { if (live) setPhase((s) => (s.k === "connecting" ? { k: "waiting" } : s)); }).catch(() => { if (live) setPhase({ k: "bad" }); });
    return () => { live = false; off(); b.dispose(); };
  }, [transport]);

  const confirm = async (p: Proposal) => {
    const t = token.current;
    if (!t || !bridge.current) return;
    setPhase({ k: "applying", p });
    try {
      const res = await bridge.current.callTool("change_event_status", { event_id: p.proposal.event_id, new_status: p.proposal.to, confirmation_token: t });
      token.current = null; // single use either way
      const err = parseToolError(res);
      setPhase(err ? { k: "failed", p, ...err } : { k: "done", p });
    } catch (e) {
      token.current = null;
      setPhase({ k: "failed", p, code: "host_error", message: (e as Error).message });
    }
  };
  const cancel = () => { token.current = null; setPhase({ k: "cancelled" }); };

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 12, maxWidth: 520 }}>
      <h1 style={{ fontSize: "1.1rem" }}>Confirm event status change</h1>
      {phase.k === "connecting" && <p role="status">Connecting…</p>}
      {phase.k === "waiting" && <p role="status">Waiting for a proposed change…</p>}
      {phase.k === "bad" && <p role="alert">Could not read the proposal. Ask for a new one.</p>}
      {phase.k === "cancelled" && <p role="status">Cancelled. Nothing was changed.</p>}
      {(phase.k === "review" || phase.k === "applying" || phase.k === "done" || phase.k === "failed") && (
        <>
          <dl>
            <dt>Event</dt><dd>{phase.p.event.title} (#{phase.p.event.id})</dd>
            <dt>Venue</dt><dd>{phase.p.event.venue_name}, {phase.p.event.location}</dd>
            <dt>Places</dt><dd>{phase.p.event.registered} of {phase.p.event.capacity} taken</dd>
            <dt>Proposed change</dt><dd><strong>{phase.p.proposal.from} → {phase.p.proposal.to}</strong></dd>
            <dt>Reason</dt><dd>{phase.p.proposal.reason}</dd>
          </dl>
          {(phase.k === "review" || phase.k === "applying") && (
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" onClick={() => void confirm(phase.p)} disabled={phase.k === "applying"}>{phase.k === "applying" ? "Applying…" : "Confirm"}</button>
              <button type="button" onClick={cancel} disabled={phase.k === "applying"}>Cancel</button>
            </div>
          )}
          {phase.k === "done" && <p role="status">Done. Status is now {phase.p.proposal.to}.</p>}
          {phase.k === "failed" && <p role="alert">{HINTS[phase.code] ?? phase.message}</p>}
        </>
      )}
    </main>
  );
}
