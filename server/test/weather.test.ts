import { describe, it, expect } from "vitest";
import { WeatherClient, redact, type FetchFn } from "../src/weather.js";

const cfg = { weatherApiKey: "SECRETKEY123", weatherBaseUrl: "https://wx.test/forecast", weatherTimeoutMs: 20, weatherMaxRetries: 2, weatherCacheTtlMs: 1000 };
const NOW = Date.parse("2026-11-05T12:00:00Z");
const slot = (dtMs: number, o: Partial<{ temp: number; wind: number; pop: number }> = {}) => ({ dt: dtMs / 1000, main: { temp: o.temp ?? 15 }, wind: { speed: o.wind ?? 2 }, pop: o.pop ?? 0, weather: [{ description: "clear sky" }] });
const ok = (list: unknown[]): FetchFn => async () => ({ ok: true, status: 200, json: async () => ({ list }) });
const startIso = new Date(NOW + 24 * 3600_000).toISOString();

describe("WeatherClient", () => {
  it("returns a fresh forecast and the right advisory flag", async () => {
    const c = new WeatherClient(cfg, ok([slot(NOW + 24 * 3600_000, { wind: 16 })]), () => NOW, 1, () => {});
    const r = await c.forEvent(41, -87, startIso);
    expect(r.status).toBe("fresh");
    expect(r.flag).toBe("advisory");
  });

  it("does not pretend a forecast exists beyond the 5-day horizon", async () => {
    let called = 0;
    const c = new WeatherClient(cfg, async () => { called++; throw new Error("x"); }, () => NOW, 1, () => {});
    const r = await c.forEvent(41, -87, new Date(NOW + 9 * 86400_000).toISOString());
    expect(r.status).toBe("out_of_range");
    expect(called).toBe(0);
  });

  it("times out, retries a bounded number of times, then reports unavailable", async () => {
    let calls = 0;
    const hang: FetchFn = (_u, init) => { calls++; return new Promise((_res, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted")))); };
    const c = new WeatherClient(cfg, hang, () => NOW, 1, () => {});
    const r = await c.forEvent(41, -87, startIso);
    expect(calls).toBe(3); // 1 try + 2 retries, never more
    expect(r.status).toBe("unavailable");
    expect(r.message).toMatch(/unavailable/i);
  });

  it("serves the last good forecast, labelled stale with its timestamp, when the provider fails", async () => {
    let t = NOW;
    let fail = false;
    const f: FetchFn = async () => {
      if (fail) throw new Error("down");
      return { ok: true, status: 200, json: async () => ({ list: [slot(NOW + 24 * 3600_000)] }) };
    };
    const c = new WeatherClient(cfg, f, () => t, 1, () => {});
    const first = await c.forEvent(41, -87, startIso);
    expect(first.status).toBe("fresh");
    t += 5000; // past cache TTL
    fail = true;
    const second = await c.forEvent(41, -87, startIso);
    expect(second.status).toBe("stale");
    expect(second.fetchedAt).toBe(first.fetchedAt);
    expect(second.message).toContain(first.fetchedAt!);
  });

  it("serves from cache without calling the provider again inside the TTL", async () => {
    let calls = 0;
    const f: FetchFn = async () => { calls++; return { ok: true, status: 200, json: async () => ({ list: [slot(NOW + 24 * 3600_000)] }) }; };
    const c = new WeatherClient(cfg, f, () => NOW, 1, () => {});
    await c.forEvent(41.001, -87.001, startIso);
    await c.forEvent(41.004, -87.004, startIso); // same ~1km cache key
    expect(calls).toBe(1);
  });

  it("rejects malformed provider payloads (runtime validation)", async () => {
    const c = new WeatherClient(cfg, async () => ({ ok: true, status: 200, json: async () => ({ list: [{ dt: "nope" }] }) }), () => NOW, 1, () => {});
    expect((await c.forEvent(41, -87, startIso)).status).toBe("unavailable");
  });

  it("does not retry a 401 from the provider", async () => {
    let calls = 0;
    const c = new WeatherClient(cfg, async () => { calls++; return { ok: false, status: 401, json: async () => ({}) }; }, () => NOW, 1, () => {});
    await c.forEvent(41, -87, startIso);
    expect(calls).toBe(1);
  });

  it("never leaks the API key into logs", async () => {
    const logs: string[] = [];
    const c = new WeatherClient(cfg, async (url) => { throw new Error(`connect failed for ${url}`); }, () => NOW, 1, (m) => logs.push(m));
    const r = await c.forEvent(41, -87, startIso);
    expect(logs.length).toBeGreaterThan(0);
    for (const l of [...logs, JSON.stringify(r)]) expect(l).not.toContain("SECRETKEY123");
    expect(logs.join("")).toContain("[REDACTED]");
  });

  it("redact() handles several parameter names", () => {
    expect(redact("https://x/y?lat=1&appid=ABC&units=metric")).toBe("https://x/y?lat=1&appid=[REDACTED]&units=metric");
    expect(redact("?api_key=ZZZ")).toBe("?api_key=[REDACTED]");
  });
});
