import type { Weather } from "../api";
import { fmtDateTime } from "../format";

const FLAG_TEXT = { clear: "Clear", caution: "Caution", advisory: "Advisory" } as const;

export function WeatherPanel({ w }: { w: Weather }) {
  return (
    <section aria-labelledby="wx-h" className="panel">
      <h2 id="wx-h">Weather</h2>
      {(w.status === "unavailable" || w.status === "out_of_range") && <p role="status" className="alert">{w.message}</p>}
      {w.status === "stale" && <p role="status" className="alert alert-warn">{w.message} Last updated {w.fetchedAt ? fmtDateTime(w.fetchedAt) : "earlier"}.</p>}
      {(w.status === "fresh" || w.status === "stale") && w.flag && (
        <>
          <p><span className={`flag flag-${w.flag}`}>Weather flag: {FLAG_TEXT[w.flag]}</span> <span className="muted">(advisory only; events are never canceled automatically)</span></p>
          {w.flagReasons && w.flagReasons.length > 0 && <ul>{w.flagReasons.map((r) => <li key={r}>{r}</li>)}</ul>}
          <dl className="kv">
            <dt>Conditions</dt><dd>{w.summary}</dd>
            <dt>Temperature</dt><dd>{w.tempC} °C</dd>
            <dt>Wind</dt><dd>{w.windMs} m/s</dd>
            <dt>Precipitation chance</dt><dd>{Math.round((w.precipChance ?? 0) * 100)}%</dd>
            {w.status === "fresh" && w.fetchedAt && <><dt>Fetched</dt><dd>{fmtDateTime(w.fetchedAt)}</dd></>}
          </dl>
        </>
      )}
    </section>
  );
}
