import { describe, expect, it } from "vitest";
import {
  addDetectionHistory,
  clearDetectionHistory
} from "../src/monitoring/history";
import type { DetectionHistoryEntry } from "../src/types/monitor";

function entry(index: number): DetectionHistoryEntry {
  return {
    id: `event-${index}`,
    tabId: 1,
    mode: "found",
    keyword: "Ticket",
    detectedAt: index,
    pageTitle: "Queue",
    pageUrl: "https://example.com/",
    actionApplied: "continue"
  };
}

describe("local detection history", () => {
  it("orders newest entries first", () => {
    expect(addDetectionHistory([entry(1)], entry(3)).map(({ id }) => id))
      .toEqual(["event-3", "event-1"]);
  });

  it("caps history and removes the oldest entry", () => {
    const history = [entry(3), entry(2), entry(1)];
    expect(addDetectionHistory(history, entry(4), 3).map(({ id }) => id))
      .toEqual(["event-4", "event-3", "event-2"]);
  });

  it("does not duplicate an event id", () => {
    expect(addDetectionHistory([entry(1)], entry(1))).toHaveLength(1);
  });

  it("clears history without touching runtime state", () => {
    const baseline = true;
    expect(clearDetectionHistory()).toEqual([]);
    expect(baseline).toBe(true);
  });

  it("stores only compact event metadata", () => {
    expect(entry(1)).not.toHaveProperty("pageText");
    expect(entry(1)).not.toHaveProperty("excerpt");
  });
});
