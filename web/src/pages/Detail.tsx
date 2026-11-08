import { useEffect, useState } from "react";
import { api, ApiError, STATUSES, type EventDetail, type Status } from "../api";
import { useAsync } from "../useAsync";
import { useLive } from "../live";
import { useAuth } from "../AuthContext";
import { fmtDateTime } from "../format";
import { ErrorBox, Loading, StatusBadge, Field } from "../components";
import { WeatherPanel } from "./WeatherPanel";

function describe(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === "capacity_exceeded") return `Not enough places: only ${String(e.details?.available ?? 0)} available (requested ${String(e.details?.requested ?? "?")}). Nothing was changed.`;
    if (e.code === "version_conflict") return "Someone else changed this event. The latest version has been loaded; review it and try again.";
    if (e.status === 401) return "Your session has expired. Please sign in again.";
    if (e.status === 403) return "You do not have permission to do that.";
    return e.message;
  }
  return "Something went wrong.";
}

function CoordinatorPanel({ ev, onChanged, onEdit }: { ev: EventDetail; onChanged: () => void; onEdit: () => void }) {
  const [status, setStatus] = useState<Status>(ev.status);
  const [reason, setReason] = useState("");
  const [seats, setSeats] = useState(1);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true); setMsg(null);
    try { await fn(); setMsg({ kind: "ok", text: ok }); setReason(""); }
    catch (e) { setMsg({ kind: "error", text: describe(e) }); }
    finally { setBusy(false); onChanged(); }
  };

  return (
    <section aria-labelledby="coord-h" className="panel">
      <h2 id="coord-h">Coordinator actions</h2>
      <div className="grid2">
        <form onSubmit={(e) => { e.preventDefault(); void run(() => api.changeStatus(ev.id, { status, reason, expected_version: ev.version }), "Status changed."); }}>
          <h3>Change status</h3>
          <Field label="New status"><select value={status} onChange={(e) => setStatus(e.target.value as Status)}>{STATUSES.map((s) => <option key={s}>{s}</option>)}</select></Field>
          <Field label="Reason (required)"><input required minLength={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <button type="submit" className="primary" disabled={busy || status === ev.status || reason.trim().length < 3}>Apply status</button>
        </form>
        <form onSubmit={(e) => { e.preventDefault(); void run(() => api.register(ev.id, { seats }), `Added ${seats} synthetic registration${seats === 1 ? "" : "s"}.`); }}>
          <h3>Add synthetic registration</h3>
          <Field label="Seats" hint={`${ev.available} places available`}><input type="number" min={1} max={100} value={seats} onChange={(e) => setSeats(Number(e.target.value))} /></Field>
          <button type="submit" disabled={busy || !Number.isInteger(seats) || seats < 1}>Register seats</button>
        </form>
      </div>
      <p><button type="button" onClick={onEdit}>Edit event details</button></p>
      {msg && <p role={msg.kind === "error" ? "alert" : "status"} className={`alert ${msg.kind === "error" ? "alert-error" : "alert-ok"}`}>{msg.text}</p>}
    </section>
  );
}

export function Detail({ id, onBack, onEdit }: { id: number; onBack: () => void; onEdit: () => void }) {
  const [state, reload] = useAsync((s) => api.getEvent(id, s), [id]);
  const [wx, reloadWx] = useAsync((s) => api.getWeather(id, s), [id]);
  const { subscribe } = useLive();
  const { isCoordinator } = useAuth();
  useEffect(() => subscribe((m) => { if (m.type === "resync" || ("data" in m && m.data.id === id)) reload(); }), [subscribe, id, reload]);

  return (
    <section aria-labelledby="ev-h">
      <p><a href="#/" onClick={(e) => { e.preventDefault(); onBack(); }}>← All events</a></p>
      {state.status === "loading" && <Loading what="event" />}
      {state.status === "error" && <ErrorBox error={state.error} onRetry={reload} />}
      {state.status === "ok" && (() => {
        const ev = state.data;
        return (
          <>
            <h1 id="ev-h">{ev.title}</h1>
            <p><StatusBadge status={ev.status} /> <span className="muted">{ev.event_type}</span></p>
            {ev.description && <p>{ev.description}</p>}
            <dl className="kv panel">
              <dt>Starts</dt><dd>{fmtDateTime(ev.starts_at)}</dd>
              <dt>Ends</dt><dd>{fmtDateTime(ev.ends_at)}</dd>
              <dt>Venue</dt><dd>{ev.venue_name}, {ev.location}</dd>
              <dt>Capacity</dt><dd>{ev.capacity}</dd>
              <dt>Synthetic registrations</dt><dd>{ev.registered}</dd>
              <dt>Places available</dt><dd><strong>{ev.available}</strong></dd>
            </dl>
            {wx.status === "loading" && <Loading what="weather" />}
            {wx.status === "error" && <ErrorBox error={wx.error} onRetry={reloadWx} />}
            {wx.status === "ok" && <WeatherPanel w={wx.data} />}
            {isCoordinator && <CoordinatorPanel ev={ev} onChanged={reload} onEdit={onEdit} />}
            <section aria-labelledby="hist-h" className="panel">
              <h2 id="hist-h">Status history</h2>
              {ev.history.length === 0 ? <p className="empty">No history yet.</p> : (
                <ol className="history">
                  {ev.history.map((h, i) => (
                    <li key={i}><strong>{h.from_status ?? "—"} → {h.to_status}</strong> <span className="muted">{fmtDateTime(h.at)}</span><br />{h.reason}</li>
                  ))}
                </ol>
              )}
            </section>
          </>
        );
      })()}
    </section>
  );
}
