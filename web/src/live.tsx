import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { API_BASE } from "./config";

export interface LiveMsg { id: number; type: string; data: { id?: number } }
type Listener = (m: LiveMsg | { type: "resync" }) => void;
interface Ctx { connected: boolean; announcement: string; subscribe(l: Listener): () => void }
const LiveCtx = createContext<Ctx>({ connected: false, announcement: "", subscribe: () => () => {} });
export const useLive = () => useContext(LiveCtx);

/** Dedupes by persisted event id: anything <= lastSeen (replay overlap after reconnect) is ignored. */
export function createDeduper() {
  let last = 0;
  return { accept(id: number) { if (id <= last) return false; last = id; return true; }, reset(id = 0) { last = id; }, get last() { return last; } };
}

const LABELS: Record<string, string> = { "event.status": "An event's status changed", "event.capacity": "An event's capacity changed", "event.updated": "An event was updated", "event.created": "A new event was added" };

export function LiveProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const listeners = useRef(new Set<Listener>());
  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const dedupe = createDeduper();
    const es = new EventSource(`${API_BASE}/api/stream`);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false); // browser reconnects automatically and sends Last-Event-ID
    const handle = (ev: MessageEvent<string>) => {
      const id = Number(ev.lastEventId);
      if (!Number.isFinite(id) || !dedupe.accept(id)) return;
      let data: LiveMsg["data"] = {};
      try { data = JSON.parse(ev.data) as LiveMsg["data"]; } catch { return; }
      setAnnouncement(`${LABELS[ev.type] ?? "Live update received"}.`);
      listeners.current.forEach((l) => l({ id, type: ev.type, data }));
    };
    for (const t of Object.keys(LABELS)) es.addEventListener(t, handle as EventListener);
    es.addEventListener("resync", ((ev: MessageEvent<string>) => {
      const id = Number(ev.lastEventId);
      dedupe.reset(Number.isFinite(id) ? id : 0); // server told us our cursor is invalid: adopt its latest id, reload snapshot
      listeners.current.forEach((l) => l({ type: "resync" }));
    }) as EventListener);
    return () => es.close();
  }, []);
  const subscribe = (l: Listener) => { listeners.current.add(l); return () => { listeners.current.delete(l); }; };
  return <LiveCtx.Provider value={{ connected, announcement, subscribe }}>{children}</LiveCtx.Provider>;
}
