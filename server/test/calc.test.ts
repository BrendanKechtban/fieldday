import { describe, it, expect } from "vitest";
import { availablePlaces } from "../src/service.js";
import { weatherFlag } from "../src/weather.js";

describe("availablePlaces (hand-predicted)", () => {
  it("capacity 40 with 31 registered leaves 9", () => expect(availablePlaces(40, 31)).toBe(9));
  it("never goes negative", () => expect(availablePlaces(10, 12)).toBe(0));
});

describe("weatherFlag thresholds (documented in docs/weather-thresholds.md)", () => {
  it("calm weather is clear", () => expect(weatherFlag({ temp: 18, wind: 3, pop: 0.1 }).flag).toBe("clear"));
  it("wind 10 m/s is caution, 15 is advisory", () => {
    expect(weatherFlag({ temp: 18, wind: 10, pop: 0 }).flag).toBe("caution");
    expect(weatherFlag({ temp: 18, wind: 15, pop: 0 }).flag).toBe("advisory");
  });
  it("precipitation 50% is caution, 80% is advisory", () => {
    expect(weatherFlag({ temp: 18, wind: 0, pop: 0.5 }).flag).toBe("caution");
    expect(weatherFlag({ temp: 18, wind: 0, pop: 0.8 }).flag).toBe("advisory");
  });
  it("temperature extremes", () => {
    expect(weatherFlag({ temp: 0, wind: 0, pop: 0 }).flag).toBe("caution");
    expect(weatherFlag({ temp: -10, wind: 0, pop: 0 }).flag).toBe("advisory");
    expect(weatherFlag({ temp: 32, wind: 0, pop: 0 }).flag).toBe("caution");
    expect(weatherFlag({ temp: 38, wind: 0, pop: 0 }).flag).toBe("advisory");
  });
  it("the worst condition wins and reasons are listed", () => {
    const r = weatherFlag({ temp: 18, wind: 16, pop: 0.6 });
    expect(r.flag).toBe("advisory");
    expect(r.reasons.length).toBe(2);
  });
});
