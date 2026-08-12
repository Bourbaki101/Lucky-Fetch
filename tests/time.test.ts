import { describe, expect, it } from "vitest";
import {
  badgeForMonitor,
  badgeForReloadDeadline,
  nearestActiveReloadAt
} from "../src/shared/badge";
import {
  createKeywordConfig,
  createKeywordRuntime
} from "../src/monitoring/runtime";
import {
  formatCountdown,
  getMaxMonitorDelay,
  intervalToMs,
  remainingMs,
  remainingReloadMs,
  validateInterval,
  validateMonitorDelayForReload
} from "../src/shared/time";
import type { TabMonitor } from "../src/types/monitor";

const monitor = (overrides: Partial<TabMonitor> = {}): TabMonitor => ({
  tabId: 1,
  tabInstanceId: "instance",
  pageTitle: "Example",
  pageUrl: "https://example.com/",
  reloadEnabled: true,
  intervalMs: 60_000,
  bypassCache: false,
  maximumReloads: null,
  interactionBehavior: "ignore",
  protectActiveTyping: true,
  reloadCount: 0,
  status: "running",
  lastReloadAt: null,
  nextReloadAt: 160_000,
  lastUserInteractionAt: null,
  typingProtectionUntil: null,
    errorMessage: null,
    profileId: null,
    profileName: null,
  keywordMonitoring: createKeywordConfig(),
  keywordRuntime: createKeywordRuntime(),
  detectionHistory: [],
  createdAt: 100_000,
  updatedAt: 100_000,
  ...overrides
});

describe("time helpers", () => {
  it("converts supported units", () => {
    expect(intervalToMs(30, "seconds")).toBe(30_000);
    expect(intervalToMs(2, "minutes")).toBe(120_000);
    expect(intervalToMs(1.5, "hours")).toBe(5_400_000);
  });

  it("accepts 10 seconds and rejects values below the minimum", () => {
    expect(validateInterval("", "seconds").valid).toBe(false);
    expect(validateInterval("-1", "minutes").valid).toBe(false);
    expect(validateInterval("9.999", "seconds")).toMatchObject({
      valid: false,
      error: "Minimum reload interval is 10 seconds."
    });
    expect(validateInterval("744", "hours").valid).toBe(false);
    expect(validateInterval("10", "seconds").intervalMs).toBe(10_000);
  });

  it("caps monitor delay at exactly half of the reload interval", () => {
    expect(getMaxMonitorDelay(10_000)).toBe(5_000);
    expect(getMaxMonitorDelay(60_000)).toBe(30_000);
    expect(validateMonitorDelayForReload(10_000, 5_000, true)).toBeNull();
    expect(validateMonitorDelayForReload(10_000, 5_001, true)).toBe(
      "Monitor delay must be 5 seconds or less with a 10-second reload interval."
    );
    expect(validateMonitorDelayForReload(10_000, 60_000, false)).toBeNull();
  });

  it("uses the normalized custom reload interval and floors odd seconds", () => {
    expect(getMaxMonitorDelay(14_000)).toBe(7_000);
    expect(validateMonitorDelayForReload(14_000, 7_000, true)).toBeNull();
    expect(validateMonitorDelayForReload(14_000, 8_000, true)).toBe(
      "Monitor delay must be 7 seconds or less with a 14-second reload interval."
    );
    expect(validateMonitorDelayForReload(14_000, 16_000, true)).not.toBeNull();
    expect(getMaxMonitorDelay(17_000)).toBe(8_000);
    expect(validateMonitorDelayForReload(17_000, 8_000, true)).toBeNull();
    expect(validateMonitorDelayForReload(17_000, 9_000, true)).not.toBeNull();
    expect(getMaxMonitorDelay(25_000)).toBe(12_000);
  });

  it("revalidates the same delay when the effective reload interval changes", () => {
    expect(validateMonitorDelayForReload(30_000, 10_000, true)).toBeNull();
    expect(validateMonitorDelayForReload(14_000, 10_000, true)).toBe(
      "Monitor delay must be 7 seconds or less with a 14-second reload interval."
    );
  });

  it("calculates remaining time from the absolute timestamp", () => {
    expect(remainingMs(10_000, 7_500)).toBe(2_500);
    expect(remainingMs(10_000, 12_000)).toBe(0);
    expect(remainingMs(null, 12_000)).toBeNull();
    expect(formatCountdown(65_000)).toBe("1:05");
    expect(formatCountdown(Number.NaN)).toBe("—");
    expect(formatCountdown(-1_000)).toBe("0:00");
  });

  it("rejects a deadline that cannot belong to the effective reload schedule", () => {
    expect(remainingReloadMs(114_000, 14_000, 100_000)).toBe(14_000);
    expect(remainingReloadMs(999_000, 14_000, 100_000)).toBeNull();
  });
});

describe("badge formatting", () => {
  it("uses remaining timestamp and compact status markers", () => {
    expect(badgeForMonitor(monitor(), 115_000).text).toBe("45");
    expect(
      badgeForMonitor(monitor({ nextReloadAt: 280_000 }), 100_000).text
    ).toBe("");
    expect(badgeForMonitor(monitor({ status: "paused" })).text).toBe("Ⅱ");
    expect(badgeForMonitor(monitor({ status: "error" })).text).toBe("!");
    expect(badgeForMonitor(monitor({ nextReloadAt: null })).text).toBe("ON");
    expect(badgeForMonitor(undefined).text).toBe("");
  });

  it("calculates whole remaining seconds from the absolute deadline", () => {
    expect(badgeForReloadDeadline(130_000, 100_000).text).toBe("30");
    expect(badgeForReloadDeadline(130_000, 100_001).text).toBe("30");
    expect(badgeForReloadDeadline(130_000, 101_000).text).toBe("29");
    expect(badgeForReloadDeadline(130_000, 130_001).text).toBe("0");
  });

  it("selects the earliest deadline across running monitors", () => {
    expect(
      nearestActiveReloadAt([
        monitor({ tabId: 1, nextReloadAt: 160_000 }),
        monitor({ tabId: 2, nextReloadAt: 130_000 }),
        monitor({ tabId: 3, status: "paused", nextReloadAt: 120_000 })
      ], 100_000)
    ).toBe(130_000);
    expect(
      nearestActiveReloadAt([
        monitor({ status: "stopped", nextReloadAt: null })
      ], 100_000)
    ).toBeNull();
    expect(
      nearestActiveReloadAt([
        monitor({ intervalMs: 14_000, nextReloadAt: 999_000 })
      ], 100_000)
    ).toBeNull();
  });
});
