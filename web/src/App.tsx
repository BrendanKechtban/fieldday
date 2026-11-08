import { useEffect, useRef, useState } from "react";
import { AuthProvider, useAuth } from "./AuthContext";
import { LiveProvider, useLive } from "./live";
import { Board } from "./pages/Board";
import { Detail } from "./pages/Detail";
import { EventForm } from "./pages/EventForm";
import { api } from "./api";
import { useAsync } from "./useAsync";
import { ErrorBox, Loading } from "./components";

export type Route = { name: "board" } | { name: "event"; id: number } | { name: "new" } | { name: "edit"; id: number };

export function parseHash(h: string): Route {
  const m = /^#\/events\/(\d+)(\/edit)?$/.exec(h);
  if (m) return m[2] ? { name: "edit", id: Number(m[1]) } : { name: "event", id: Number(m[1]) };
  if (h === "#/new") return { name: "new" };
  return { name: "board" };
}

function useRoute(): [Route, (h: string) => void] {
  const [r, setR] = useState(() => parseHash(window.location.hash));
  useEffect(() => { const f = () => setR(parseHash(window.location.hash)); window.addEventListener("hashchange", f); return () => window.removeEventListener("hashchange", f); }, []);
  return [r, (h) => { window.location.hash = h; }];
}

function EditLoader({ id, onDone, onCancel }: { id: number; onDone: (id: number) => void; onCancel: () => void }) {
  const [s, reload] = useAsync((sig) => api.getEvent(id, sig), [id]);
  if (s.status === "loading") return <Loading what="event" />;
  if (s.status === "error") return <ErrorBox error={s.error} onRetry={reload} />;
  return <EventForm existing={s.data} onDone={onDone} onCancel={onCancel} />;
}

function Shell() {
  const [route, go] = useRoute();
  const auth = useAuth();
  const live = useLive();
  const main = useRef<HTMLElement>(null);
  const first = useRef(true);
  useEffect(() => { if (first.current) { first.current = false; return; } main.current?.focus(); }, [route]); // move focus to content on navigation

  return (
    <>
      <a className="skip" href="#main" onClick={(e) => { e.preventDefault(); main.current?.focus(); }}>Skip to content</a>
      <header className="top">
        <a className="brand" href="#/">FieldDay</a>
        <span className={`live ${live.connected ? "on" : "off"}`} role="status">{live.connected ? "Live" : "Reconnecting…"}</span>
        <nav aria-label="Account" className="row">
          {auth.busy ? <span className="muted">Signing in…</span> : auth.signedIn
            ? <><span>{auth.name}{auth.isCoordinator ? " (coordinator)" : " (viewer)"}</span><button type="button" onClick={auth.logout}>Sign out</button></>
            : <button type="button" onClick={auth.login}>Sign in</button>}
        </nav>
      </header>
      <main id="main" tabIndex={-1} ref={main}>
        {auth.error && <p role="alert" className="alert alert-error">{auth.error}</p>}
        {route.name === "board" && <Board onOpen={(id) => go(`#/events/${id}`)} onCreate={() => go("#/new")} />}
        {route.name === "event" && <Detail id={route.id} onBack={() => go("#/")} onEdit={() => go(`#/events/${route.id}/edit`)} />}
        {route.name === "new" && (auth.isCoordinator ? <EventForm onDone={(id) => go(`#/events/${id}`)} onCancel={() => go("#/")} /> : <p role="alert" className="alert">Only coordinators can create events. Sign in with a coordinator account.</p>)}
        {route.name === "edit" && (auth.isCoordinator ? <EditLoader id={route.id} onDone={(id) => go(`#/events/${id}`)} onCancel={() => go(`#/events/${route.id}`)} /> : <p role="alert" className="alert">Only coordinators can edit events.</p>)}
      </main>
      <div className="sr-only" aria-live="polite" aria-atomic="true">{live.announcement}</div>
      <footer className="foot muted">All organizations, events and registrations are synthetic. Weather flags are advisory only.</footer>
    </>
  );
}

export default function App() {
  return <AuthProvider><LiveProvider><Shell /></LiveProvider></AuthProvider>;
}
