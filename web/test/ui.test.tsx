import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import { Board } from "../src/pages/Board";
import { WeatherPanel } from "../src/pages/WeatherPanel";
import { AuthProvider } from "../src/AuthContext";
import { LiveProvider } from "../src/live";
import { parseHash } from "../src/App";

const ev = (o: object = {}) => ({ id: 1, venue_id: 1, title: "Kite Day", description: "", event_type: "recreation", starts_at: "2026-11-10T15:00:00.000Z", ends_at: "2026-11-10T18:00:00.000Z", capacity: 40, registered: 31, available: 9, status: "scheduled", version: 1, venue_name: "Lakeside", location: "Chicago, IL", ...o });
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
const wrap = (ui: React.ReactElement) => render(<AuthProvider><LiveProvider>{ui}</LiveProvider></AuthProvider>);

beforeEach(() => { vi.stubGlobal("EventSource", undefined); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("Board", () => {
  it("shows loading, then results with available places, and passes axe", async () => {
    vi.stubGlobal("fetch", vi.fn(() => json({ items: [ev()], total: 1 })));
    const { container } = wrap(<Board onOpen={() => {}} onCreate={() => {}} />);
    expect(screen.getByText(/Loading events/)).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "Kite Day" })).toBeInTheDocument();
    expect(screen.getByText(/of 40 places left/)).toBeInTheDocument();
    expect(await axe(container, { rules: { "color-contrast": { enabled: false } } }) /* jsdom cannot compute layout colors */).toHaveNoViolations();
  });
  it("shows an empty state and sends filters as query params", async () => {
    const f = vi.fn(() => json({ items: [], total: 0 }));
    vi.stubGlobal("fetch", f);
    wrap(<Board onOpen={() => {}} onCreate={() => {}} />);
    await screen.findByText(/No events match/);
    await userEvent.type(screen.getByLabelText("Search"), "kite");
    await userEvent.selectOptions(screen.getByLabelText("Status"), "delayed");
    await userEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    await waitFor(() => expect((f.mock.calls.at(-1) as unknown as [string])[0]).toMatch(/q=kite.*status=delayed|status=delayed.*q=kite/));
  });
  it("shows the server error message and a retry button", async () => {
    vi.stubGlobal("fetch", vi.fn(() => json({ error: { code: "internal_error", message: "Unexpected server error", requestId: "r-1" } }, 500)));
    wrap(<Board onOpen={() => {}} onCreate={() => {}} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Unexpected server error");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
  it("hides coordinator controls for anonymous visitors", async () => {
    vi.stubGlobal("fetch", vi.fn(() => json({ items: [ev()], total: 1 })));
    wrap(<Board onOpen={() => {}} onCreate={() => {}} />);
    await screen.findByRole("link", { name: "Kite Day" });
    expect(screen.queryByRole("button", { name: "New event" })).toBeNull();
  });
});

describe("WeatherPanel states", () => {
  it("fresh: flag and reasons", () => {
    render(<WeatherPanel w={{ status: "fresh", message: "ok", fetchedAt: "2026-11-05T10:00:00Z", flag: "advisory", flagReasons: ["wind 16 m/s >= 15"], summary: "windy", tempC: 5, windMs: 16, precipChance: 0.2 }} />);
    expect(screen.getByText(/Weather flag: Advisory/)).toBeInTheDocument();
    expect(screen.getByText("wind 16 m/s >= 15")).toBeInTheDocument();
  });
  it("stale: says so with the timestamp", () => {
    render(<WeatherPanel w={{ status: "stale", message: "Provider unavailable.", fetchedAt: "2026-11-05T10:00:00Z", flag: "clear", flagReasons: [], summary: "clear", tempC: 10, windMs: 2, precipChance: 0 }} />);
    expect(screen.getByRole("status")).toHaveTextContent(/Last updated/);
  });
  it("unavailable and out_of_range: explicit message, no fake data", () => {
    const { rerender } = render(<WeatherPanel w={{ status: "unavailable", message: "Weather forecast is temporarily unavailable." }} />);
    expect(screen.getByText(/temporarily unavailable/)).toBeInTheDocument();
    rerender(<WeatherPanel w={{ status: "out_of_range", message: "No forecast available: outside window." }} />);
    expect(screen.getByText(/No forecast available/)).toBeInTheDocument();
    expect(screen.queryByText(/Weather flag/)).toBeNull();
  });
});

describe("routing", () => {
  it("parses hashes", () => {
    expect(parseHash("#/events/12")).toEqual({ name: "event", id: 12 });
    expect(parseHash("#/events/12/edit")).toEqual({ name: "edit", id: 12 });
    expect(parseHash("#/new")).toEqual({ name: "new" });
    expect(parseHash("")).toEqual({ name: "board" });
  });
});
