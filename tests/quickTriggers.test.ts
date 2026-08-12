import { describe, expect, it } from "vitest";
import {
  addQuickTrigger,
  normalizeQuickTriggers,
  removeQuickTrigger
} from "../src/shared/quickTriggers";

describe("Quick Triggers", () => {
  it("trims and saves deliberate non-empty triggers", () => {
    expect(addQuickTrigger([], "  Available  ")).toEqual(["Available"]);
    expect(addQuickTrigger([], "   ")).toEqual([]);
  });

  it("deduplicates case-insensitively", () => {
    expect(addQuickTrigger(["Available"], " available ")).toEqual([
      "Available"
    ]);
  });

  it("keeps at most five triggers", () => {
    expect(
      normalizeQuickTriggers(["One", "Two", "Three", "Four", "Five", "Six"])
    ).toEqual(["One", "Two", "Three", "Four", "Five"]);
  });

  it("removes a saved trigger without disturbing the others", () => {
    expect(removeQuickTrigger(["Accept", "Available", "Resolved"], " available "))
      .toEqual(["Accept", "Resolved"]);
  });
});
