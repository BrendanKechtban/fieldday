import { useState } from "react";
import { api, ApiError, TYPES, type EventDetail, type EventType } from "../api";
import { useAsync } from "../useAsync";
import { fromLocalInput, toLocalInput } from "../format";
import { ErrorBox, Field, Loading } from "../components";

/** Create (no `existing`) or edit (PATCH with expected_version; 409 version_conflict reloads the latest). */
export function EventForm({ existing, onDone, onCancel }: { existing?: EventDetail; onDone: (id: number) => void; onCancel: () => void }) {
  const [venues] = useAsync((s) => api.venues(s), []);
  const [v, setV] = useState({
    venue_id: existing?.venue_id ?? 0, title: existing?.title ?? "", description: existing?.description ?? "",
    event_type: (existing?.event_type ?? "workshop") as EventType,
    starts_at: existing ? toLocalInput(existing.starts_at) : "", ends_at: existing ? toLocalInput(existing.ends_at) : "",
    capacity: existing?.capacity ?? 20,
  });
  const [err, setErr] = useState<string | null>(null);
  const [fieldErrs, setFieldErrs] = useState<{ path: string; message: string }[]>([]);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null); setFieldErrs([]);
    try {
      const base = { title: v.title, description: v.description, event_type: v.event_type, starts_at: fromLocalInput(v.starts_at), ends_at: fromLocalInput(v.ends_at), capacity: v.capacity };
      const saved = existing ? await api.updateEvent(existing.id, { ...base, expected_version: existing.version }) : await api.createEvent({ ...base, venue_id: v.venue_id });
      onDone(saved.id);
    } catch (x) {
      if (x instanceof ApiError) {
        if (x.code === "version_conflict") setErr("Someone else modified this event. Go back to reload the latest version, then re-apply your edit.");
        else { setErr(x.message); if (Array.isArray(x.details)) setFieldErrs(x.details as { path: string; message: string }[]); }
      } else setErr("Something went wrong.");
    } finally { setBusy(false); }
  };

  return (
    <section aria-labelledby="form-h">
      <h1 id="form-h">{existing ? "Edit event" : "New event"}</h1>
      {!existing && venues.status === "loading" && <Loading what="venues" />}
      {!existing && venues.status === "error" && <ErrorBox error={venues.error} />}
      <form onSubmit={(e) => void submit(e)} className="stack">
        {!existing && venues.status === "ok" && (
          <Field label="Venue">
            <select required value={v.venue_id} onChange={(e) => setV({ ...v, venue_id: Number(e.target.value) })}>
              <option value={0} disabled>Choose a venue</option>
              {venues.data.items.map((x) => <option key={x.id} value={x.id}>{x.name} — {x.location}</option>)}
            </select>
          </Field>
        )}
        <Field label="Title"><input required maxLength={120} value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} /></Field>
        <Field label="Description"><textarea maxLength={2000} rows={3} value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} /></Field>
        <Field label="Type"><select value={v.event_type} onChange={(e) => setV({ ...v, event_type: e.target.value as EventType })}>{TYPES.map((t) => <option key={t}>{t}</option>)}</select></Field>
        <Field label="Starts"><input required type="datetime-local" value={v.starts_at} onChange={(e) => setV({ ...v, starts_at: e.target.value })} /></Field>
        <Field label="Ends"><input required type="datetime-local" value={v.ends_at} onChange={(e) => setV({ ...v, ends_at: e.target.value })} /></Field>
        <Field label="Capacity" hint={existing ? `Cannot be lower than the ${existing.registered} current registrations.` : undefined}>
          <input required type="number" min={existing?.registered ?? 0} max={10000} value={v.capacity} onChange={(e) => setV({ ...v, capacity: Number(e.target.value) })} />
        </Field>
        {err && <div role="alert" className="alert alert-error">{err}{fieldErrs.length > 0 && <ul>{fieldErrs.map((f) => <li key={f.path + f.message}>{f.path}: {f.message}</li>)}</ul>}</div>}
        <div className="row"><button type="submit" className="primary" disabled={busy || (!existing && v.venue_id === 0)}>{existing ? "Save changes" : "Create event"}</button><button type="button" onClick={onCancel}>Cancel</button></div>
      </form>
    </section>
  );
}
