import { describe, expect, it } from "vitest";
import { createRunningMonitor } from "../src/shared/stateMachine";
import { normalizePersistedState } from "../src/storage/storage";

function phaseOneMonitor() {
  const monitor = createRunningMonitor(
    { id: 1, title: "Page", url: "https://example.com/" },
    {
      intervalMs: 30_000,
      bypassCache: false,
      maximumReloads: null,
      interactionBehavior: "ignore",
      protectActiveTyping: true
    },
    1_000,
    "instance"
  );
  const legacy: Record<string, unknown> = { ...monitor };
  delete legacy.keywordMonitoring;
  delete legacy.keywordRuntime;
  delete legacy.detectionHistory;
  return legacy;
}

describe("keyword state persistence migration", () => {
  it("migrates Phase 1 state with an unknown baseline", () => {
    const state = normalizePersistedState({
      version: 1,
      monitors: { "1": phaseOneMonitor() }
    });
    expect(state.version).toBe(6);
    expect(state.profiles).toEqual([]);
    expect(state.monitors["1"]?.keywordMonitoring.enabled).toBe(false);
    expect(
      state.monitors["1"]?.keywordMonitoring.notificationMessage
    ).toBe("");
    expect(state.monitors["1"]?.keywordRuntime.lastMatchState).toBeNull();
    expect(state.monitors["1"]?.keywordMonitoring.bringToFront).toBe("never");
    expect(state.monitors["1"]?.keywordMonitoring.autoOpenResult).toBe("off");
    expect(
      state.monitors["1"]?.keywordRuntime.lastActionResultSignature
    ).toBeNull();
    expect(state.monitors["1"]?.keywordRuntime.lastFocusAt).toBeNull();
    expect(state.monitors["1"]?.keywordRuntime.lastClickAt).toBeNull();
  });

  it("preserves a valid runtime baseline", () => {
    const current = createRunningMonitor(
      { id: 1, title: "Page", url: "https://example.com/" },
      {
        intervalMs: 30_000,
        bypassCache: false,
        maximumReloads: null,
        interactionBehavior: "ignore",
        protectActiveTyping: true
      },
      1_000,
      "instance"
    );
    current.keywordRuntime.lastMatchState = true;
    const state = normalizePersistedState({
      version: 2,
      monitors: { "1": current }
    });
    expect(state.monitors["1"]?.keywordRuntime.lastMatchState).toBe(true);
  });

  it("migrates a legacy single keyword idempotently without resetting baseline", () => {
    const monitor = {
      ...phaseOneMonitor(),
      keywordMonitoring: {
        enabled: true,
        keyword: "  No items to display  ",
        mode: "found",
        caseSensitive: false,
        scanDelayMs: 2_000,
        actionOnDetection: "continue",
        notificationMessage: "Queue"
      },
      keywordRuntime: {
        ...createRunningMonitor(
          { id: 1, title: "Page", url: "https://example.com/" },
          {
            intervalMs: 30_000,
            bypassCache: false,
            maximumReloads: null,
            interactionBehavior: "ignore",
            protectActiveTyping: true
          },
          1_000,
          "instance"
        ).keywordRuntime,
        lastMatchState: true
      }
    };
    const first = normalizePersistedState({
      version: 2,
      monitors: { "1": monitor }
    });
    const second = normalizePersistedState(first);
    expect(first.monitors["1"]?.keywordMonitoring.keywords).toEqual(
      second.monitors["1"]?.keywordMonitoring.keywords
    );
    expect(first.monitors["1"]?.keywordMonitoring.keywords[0]?.value).toBe(
      "No items to display"
    );
    expect(first.monitors["1"]?.keywordRuntime.lastMatchState).toBe(true);
    expect(first.monitors["1"]?.keywordMonitoring.highlightMatches).toBe(false);
  });

  it("repairs corrupt keyword configuration safely", () => {
    const monitor = {
      ...phaseOneMonitor(),
      keywordMonitoring: {
        enabled: true,
        keyword: " ",
        mode: "changed",
        caseSensitive: "yes",
        scanDelayMs: -1,
        actionOnDetection: "email"
      }
    };
    const state = normalizePersistedState({
      version: 2,
      monitors: { "1": monitor }
    });
    expect(state.monitors["1"]?.keywordMonitoring.enabled).toBe(false);
    expect(state.monitors["1"]?.keywordRuntime.lastError?.code).toBe(
      "CORRUPT_STATE"
    );
  });

  it("sanitizes history to compact fields and newest-first order", () => {
    const current = createRunningMonitor(
      { id: 1, title: "Page", url: "https://example.com/" },
      {
        intervalMs: 30_000,
        bypassCache: false,
        maximumReloads: null,
        interactionBehavior: "ignore",
        protectActiveTyping: true
      },
      1_000,
      "instance"
    );
    current.detectionHistory = [
      {
        id: "old",
        tabId: 1,
        mode: "found",
        keyword: "Ticket",
        detectedAt: 1,
        pageTitle: "Page",
        pageUrl: "https://example.com/",
        actionApplied: "continue",
        pageText: "must not survive"
      } as never,
      {
        id: "new",
        tabId: 1,
        mode: "lost",
        keyword: "Ticket",
        detectedAt: 2,
        pageTitle: "Page",
        pageUrl: "https://example.com/",
        actionApplied: "pause"
      }
    ];
    const state = normalizePersistedState({
      version: 2,
      monitors: { "1": current }
    });
    expect(state.monitors["1"]?.detectionHistory.map(({ id }) => id)).toEqual([
      "new",
      "old"
    ]);
    expect(state.monitors["1"]?.detectionHistory[1]).not.toHaveProperty(
      "pageText"
    );
  });

  it("normalizes persisted notification history to the newest 15 entries", () => {
    const notificationHistory = Array.from({ length: 16 }, (_, index) => ({
      id: `notification-${index + 1}`,
      state: index % 2 === 0 ? "found" : "lost",
      keyword: `Keyword ${index + 1}`,
      timestamp: index + 1,
      triggerLabel: "  Queue alert  ",
      pageText: "must not survive"
    }));
    const state = normalizePersistedState({
      version: 4,
      monitors: {},
      notificationHistory
    });

    expect(state.notificationHistory).toHaveLength(15);
    expect(state.notificationHistory[0]).toEqual({
      id: "notification-16",
      state: "lost",
      keyword: "Keyword 16",
      timestamp: 16,
      triggerLabel: "Queue alert"
    });
    expect(state.notificationHistory.at(-1)?.id).toBe("notification-2");
  });

  it("normalizes persisted reload intervals without silently changing the monitor delay", () => {
    const current = createRunningMonitor(
      { id: 1, title: "Page", url: "https://example.com/" },
      {
        intervalMs: 5_000,
        bypassCache: false,
        maximumReloads: null,
        interactionBehavior: "ignore",
        protectActiveTyping: true
      },
      1_000,
      "instance"
    );
    current.keywordMonitoring = {
      ...current.keywordMonitoring,
      enabled: true,
      keywords: [{ id: "available", value: "Available" }],
      scanDelayMs: 10_000
    };
    const state = normalizePersistedState({
      version: 4,
      monitors: { "1": current }
    });
    expect(state.monitors["1"]?.intervalMs).toBe(10_000);
    expect(state.monitors["1"]?.keywordMonitoring.scanDelayMs).toBe(10_000);
  });

  it("persists a trimmed, duplicate-free maximum of five Quick Triggers", () => {
    const first = normalizePersistedState({
      version: 5,
      monitors: {},
      quickTriggers: [
        " Accept ",
        "accept",
        "Available",
        "Resolved",
        "Ready",
        "Complete",
        "Ignored"
      ]
    });
    const restored = normalizePersistedState(first);
    expect(restored.quickTriggers).toEqual([
      "Accept",
      "Available",
      "Resolved",
      "Ready",
      "Complete"
    ]);
  });
});
