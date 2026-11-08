import { describe, it, expect } from "vitest";
import { createDeduper } from "../src/live";

describe("live-event dedupe", () => {
  it("accepts increasing ids once, ignores replay overlap and out-of-order duplicates", () => {
    const d = createDeduper();
    expect([1, 2, 2, 3, 1, 4].map((i) => d.accept(i))).toEqual([true, true, false, true, false, true]);
  });
  it("resync adopts the server cursor", () => {
    const d = createDeduper();
    d.accept(50);
    d.reset(5); // server DB was reset; its latest id is 5
    expect(d.accept(6)).toBe(true);
  });
});
