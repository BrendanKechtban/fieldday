import { useEffect, useState } from "react";
import { api, STATUSES, TYPES, type ListFilters } from "../api";
import { useAsync } from "../useAsync";
import { useLive } from "../live";
import { fmtDateTime } from "../format";
import { ErrorBox, Loading, StatusBadge, Field } from "../components";
import { useAuth } from "../AuthContext";

const EMPTY = { q: "", status: "", event_type: "", location: "", from: "", to: "" };

export function Board({ onOpen, onCreate }: { onOpen: (id: number) => void; onCreate: () => void }) {
  const [form, setForm] = useState(EMPTY);
  const [applied, setApplied] = useState<ListFilters>({});
  const { subscribe } = useLive();
  const { isCoordinator } = useAuth();
  const [state, reload] = useAsync((s) => api.listEvents(applied, s), [JSON.stringify(applied)]);
  useEffect(() => subscribe(() => reload()), [subscribe, reload]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const f: ListFilters = {};
    if (form.q) f.q = form.q;
    if (form.status) f.status = form.status;
    if (form.event_type) f.event_type = form.event_type;
    if (form.location) f.location = form.location;
    if (form.from) f.from = new Date(`${form.from}T00:00:00`).toISOString();
    if (form.to) f.to = new Date(`${form.to}T23:59:59`).toISOString();
    setApplied(f);
  };
  const clear = () => { setForm(EMPTY); setApplied({}); };
  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value });

  return (
    <section aria-labelledby="board-h">
      <div className="row between">
        <h1 id="board-h">Upcoming events</h1>
        {isCoordinator && <button type="button" className="primary" onClick={onCreate}>New event</button>}
      </div>
      <form className="filters" role="search" aria-label="Filter events" onSubmit={submit}>
        <Field label="Search"><input type="search" value={form.q} onChange={set("q")} placeholder="Title or description" /></Field>
        <Field label="Location"><input value={form.location} onChange={set("location")} placeholder="City or venue" /></Field>
        <Field label="Type">
          <select value={form.event_type} onChange={set("event_type")}><option value="">Any</option>{TYPES.map((t) => <option key={t}>{t}</option>)}</select>
        </Field>
        <Field label="Status">
          <select value={form.status} onChange={set("status")}><option value="">Any</option>{STATUSES.map((t) => <option key={t}>{t}</option>)}</select>
        </Field>
        <Field label="From"><input type="date" value={form.from} onChange={set("from")} /></Field>
        <Field label="To"><input type="date" value={form.to} onChange={set("to")} /></Field>
        <div className="row"><button type="submit" className="primary">Apply filters</button><button type="button" onClick={clear}>Clear</button></div>
      </form>

      {state.status === "loading" && <Loading what="events" />}
      {state.status === "error" && <ErrorBox error={state.error} onRetry={reload} />}
      {state.status === "ok" && (state.data.items.length === 0
        ? <p role="status" className="empty">No events match these filters. <button type="button" onClick={clear}>Clear filters</button></p>
        : (
          <>
            <p className="muted" role="status">{state.data.total} event{state.data.total === 1 ? "" : "s"}</p>
            <ul className="cards">
              {state.data.items.map((e) => (
                <li key={e.id} className="card">
                  <h2><a href={`#/events/${e.id}`} onClick={(ev) => { ev.preventDefault(); onOpen(e.id); }}>{e.title}</a></h2>
                  <p><StatusBadge status={e.status} /> <span className="muted">{e.event_type}</span></p>
                  <p>{fmtDateTime(e.starts_at)} · {e.venue_name}, {e.location}</p>
                  <p><strong>{e.available}</strong> of {e.capacity} places left</p>
                </li>
              ))}
            </ul>
          </>
        ))}
    </section>
  );
}
