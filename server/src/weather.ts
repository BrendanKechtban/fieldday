import { z } from "zod";
import type { Config } from "./config.js";
import { withSpan, weatherCalls } from "./telemetry.js";

/** OpenWeather 5-day / 3-hour forecast: the supported horizon is 5 days. */
export const FORECAST_HORIZON_MS = 5 * 24 * 3600 * 1000;

const ForecastSchema = z.object({
  list: z.array(
    z.object({
      dt: z.number(),
      main: z.object({ temp: z.number() }),
      wind: z.object({ speed: z.number() }),
      pop: z.number().min(0).max(1).optional().default(0),
      weather: z.array(z.object({ description: z.string() })).default([]),
    }),
  ).min(1),
});
type Forecast = z.infer<typeof ForecastSchema>;

export type WeatherFlag = "clear" | "caution" | "advisory";

/**
 * Documented advisory thresholds (advisory only; never auto-cancels an event).
 *  advisory: wind >= 15 m/s OR precip prob >= 0.80 OR temp <= -10C OR temp >= 38C
 *  caution:  wind >= 10 m/s OR precip prob >= 0.50 OR temp <= 0C  OR temp >= 32C
 */
export function weatherFlag(s: { temp: number; wind: number; pop: number }): { flag: WeatherFlag; reasons: string[] } {
  const adv: string[] = [];
  const cau: string[] = [];
  if (s.wind >= 15) adv.push(`wind ${s.wind} m/s >= 15`); else if (s.wind >= 10) cau.push(`wind ${s.wind} m/s >= 10`);
  if (s.pop >= 0.8) adv.push(`precipitation chance ${Math.round(s.pop * 100)}% >= 80%`); else if (s.pop >= 0.5) cau.push(`precipitation chance ${Math.round(s.pop * 100)}% >= 50%`);
  if (s.temp <= -10) adv.push(`temp ${s.temp}C <= -10`); else if (s.temp <= 0) cau.push(`temp ${s.temp}C <= 0`);
  if (s.temp >= 38) adv.push(`temp ${s.temp}C >= 38`); else if (s.temp >= 32) cau.push(`temp ${s.temp}C >= 32`);
  if (adv.length) return { flag: "advisory", reasons: [...adv, ...cau] };
  if (cau.length) return { flag: "caution", reasons: cau };
  return { flag: "clear", reasons: [] };
}

export interface WeatherResult {
  status: "fresh" | "stale" | "unavailable" | "out_of_range";
  message: string;
  fetchedAt?: string;
  slotTime?: string;
  summary?: string;
  tempC?: number;
  windMs?: number;
  precipChance?: number;
  flag?: WeatherFlag;
  flagReasons?: string[];
}

/** Remove credentials (e.g. appid=KEY in request URLs) from any string before it is logged or returned. */
export function redact(s: string): string {
  return s.replace(/([?&](?:appid|api_key|apikey|key|token)=)[^&\s"']+/gi, "$1[REDACTED]");
}

export type FetchFn = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

interface CacheEntry { fetchedAt: number; data: Forecast }

export class WeatherClient {
  private cache = new Map<string, CacheEntry>();
  public calls = 0;
  constructor(
    private cfg: Pick<Config, "weatherApiKey" | "weatherBaseUrl" | "weatherTimeoutMs" | "weatherMaxRetries" | "weatherCacheTtlMs">,
    private fetchFn: FetchFn = (url, init) => fetch(url, init) as ReturnType<FetchFn>,
    private now: () => number = () => Date.now(),
    private backoffBaseMs = 200,
    private log: (msg: string) => void = (m) => console.warn(m),
  ) {}

  /** Cache is keyed by location rounded to 2 decimals (~1 km); one provider response covers every 3h slot in the horizon. */
  private key(lat: number, lon: number) { return `${lat.toFixed(2)},${lon.toFixed(2)}`; }

  async forEvent(lat: number, lon: number, startsAtIso: string): Promise<WeatherResult> {
    const startMs = Date.parse(startsAtIso);
    const nowMs = this.now();
    if (startMs < nowMs - 3 * 3600 * 1000 || startMs > nowMs + FORECAST_HORIZON_MS) {
      return { status: "out_of_range", message: "No forecast available: the event is outside the provider's 5-day forecast window." };
    }
    const key = this.key(lat, lon);
    const hit = this.cache.get(key);
    if (hit && nowMs - hit.fetchedAt < this.cfg.weatherCacheTtlMs) {
      return this.build(hit, startMs, "fresh");
    }
    if (!this.cfg.weatherApiKey) {
      return hit ? this.build(hit, startMs, "stale") : { status: "unavailable", message: "Weather provider is not configured." };
    }
    try {
      const data = await this.fetchWithRetry(lat, lon);
      const entry = { fetchedAt: this.now(), data };
      this.cache.set(key, entry);
      return this.build(entry, startMs, "fresh");
    } catch (e) {
      this.log(`weather fetch failed: ${redact(e instanceof Error ? e.message : String(e))}`);
      if (hit) return this.build(hit, startMs, "stale");
      return { status: "unavailable", message: "Weather forecast is temporarily unavailable. The event board is unaffected." };
    }
  }

  private build(entry: CacheEntry, startMs: number, status: "fresh" | "stale"): WeatherResult {
    const slot = entry.data.list.reduce((best, cur) => (Math.abs(cur.dt * 1000 - startMs) < Math.abs(best.dt * 1000 - startMs) ? cur : best));
    const { flag, reasons } = weatherFlag({ temp: slot.main.temp, wind: slot.wind.speed, pop: slot.pop });
    const fetchedAt = new Date(entry.fetchedAt).toISOString();
    return {
      status,
      message: status === "fresh" ? "Forecast is current." : `Provider unavailable. Showing last successful forecast from ${fetchedAt}.`,
      fetchedAt,
      slotTime: new Date(slot.dt * 1000).toISOString(),
      summary: slot.weather[0]?.description ?? "n/a",
      tempC: slot.main.temp,
      windMs: slot.wind.speed,
      precipChance: slot.pop,
      flag,
      flagReasons: reasons,
    };
  }

  private async fetchWithRetry(lat: number, lon: number): Promise<Forecast> {
    const url = `${this.cfg.weatherBaseUrl}?lat=${lat}&lon=${lon}&units=metric&appid=${encodeURIComponent(this.cfg.weatherApiKey)}`;
    const attempts = 1 + this.cfg.weatherMaxRetries; // bounded
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      this.calls++;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.cfg.weatherTimeoutMs);
      try {
        const res = await withSpan("openweather.forecast", { "peer.service": "openweathermap", "retry.attempt": i, "url.path": new URL(url).pathname }, () => this.fetchFn(url, { signal: ac.signal }));
        weatherCalls.add(1, { outcome: res.ok ? "ok" : `http_${res.status}` });
        if (!res.ok) {
          // 4xx other than 429 will not succeed on retry
          if (res.status >= 400 && res.status < 500 && res.status !== 429) throw Object.assign(new Error(`provider status ${res.status}`), { fatal: true });
          throw new Error(`provider status ${res.status}`);
        }
        return ForecastSchema.parse(await res.json()); // runtime response validation
      } catch (e) {
        lastErr = e;
        if (!(e as { fatal?: boolean }).fatal) weatherCalls.add(1, { outcome: (e as Error).name === "AbortError" ? "timeout" : "error" });
        if ((e as { fatal?: boolean }).fatal) break;
        if (i < attempts - 1) await new Promise((r) => setTimeout(r, this.backoffBaseMs * 2 ** i));
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error(redact(lastErr instanceof Error ? lastErr.message : String(lastErr)));
  }
}
