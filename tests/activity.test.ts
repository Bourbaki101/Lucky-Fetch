import { describe, expect, it } from "vitest";
import {
  getActiveLuckyFetchTabs,
  getRemainingReloadMs
} from "../src/shared/activity";
import { createKeywordConfig, createKeywordRuntime } from "../src/monitoring/runtime";
import type { TabMonitor } from "../src/types/monitor";

function monitor(overrides: Partial<TabMonitor> = {}): TabMonitor {
  return {
    tabId: 1,
    tabInstanceId: "instance-1",
    pageTitle: "Example",
    pageUrl: "https://example.com/tickets",
    intervalMs: 10_000,
    bypassCache: false,
    maximumReloads: null,
    interactionBehavior: "ignore",
    protectActiveTyping: true,
    reloadCount: 0,
    status: "running",
    lastReloadAt: null,
    nextReloadAt: 110_000,
    lastUserInteractionAt: null,
    typingProtectionUntil: null,
    errorMessage: null,
    keywordMonitoring: createKeywordConfig(),
    keywordRuntime: createKeywordRuntime(),
    detectionHistory: [],
    createdAt: 100_000,
    updatedAt: 100_000,
    ...overrides
  };
}

describe("Activity selectors", () => {
  it("returns only tabs with active Lucky Fetch work", () => {
    const entries = getActiveLuckyFetchTabs([
      monitor(),
      monitor({ tabId: 2, status: "stopped", nextReloadAt: null })
    ]);
    expect(entries.map((entry) => entry.tabId)).toEqual([1]);
  });

  it("builds a reload-only entry", () => {
    expect(getActiveLuckyFetchTabs([monitor()])[0]).toMatchObject({
      reloadActive: true,
      monitorActive: false,
      hostname: "example.com"
    });
  });

  it("builds a monitor-only entry", () => {
    const keywordMonitoring = {
      ...createKeywordConfig(),
      enabled: true,
      keywords: [{ id: "available", value: "Available" }]
    };
    expect(
      getActiveLuckyFetchTabs([
        monitor({ nextReloadAt: null, keywordMonitoring })
      ])[0]
    ).toMatchObject({
      reloadActive: false,
      monitorActive: true,
      keywords: ["Available"]
    });
  });

  it("builds a combined Reload and Monitor entry", () => {
    const keywordMonitoring = {
      ...createKeywordConfig(),
      enabled: true,
      keywords: [{ id: "resolved", value: "Resolved" }]
    };
    expect(getActiveLuckyFetchTabs([monitor({ keywordMonitoring })])[0])
      .toMatchObject({ reloadActive: true, monitorActive: true });
  });

  it("derives remaining time from the same absolute reload deadline", () => {
    const entry = getActiveLuckyFetchTabs([monitor()])[0]!;
    expect(getRemainingReloadMs(entry, 103_000)).toBe(7_000);
    expect(getRemainingReloadMs(entry, 111_000)).toBe(0);
  });

  it("surfaces an existing detection as Needs Attention without a new state machine", () => {
    const keywordRuntime = {
      ...createKeywordRuntime(),
      lastDetectionAt: 105_000,
      lastMatchState: true
    };
    const entry = getActiveLuckyFetchTabs([
      monitor({
        status: "stopped",
        nextReloadAt: null,
        keywordRuntime,
        detectionHistory: [{
          id: "detection-1",
          tabId: 1,
          mode: "found",
          keyword: "Available",
          matchedKeywords: [{ id: "available", value: "Available" }],
          detectedAt: 105_000,
          pageTitle: "Example",
          pageUrl: "https://example.com/tickets",
          actionApplied: "stop"
        }]
      })
    ])[0];
    expect(entry).toMatchObject({
      needsAttention: true,
      attentionLabel: 'Found: "Available"',
      reloadActive: false,
      monitorActive: false
    });
  });
});
