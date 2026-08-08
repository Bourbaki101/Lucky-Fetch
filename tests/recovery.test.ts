import { describe, expect, it } from "vitest";
import { planRecovery } from "../src/background/recovery";
import { createRunningMonitor, pauseMonitor } from "../src/shared/stateMachine";

const running = createRunningMonitor(
  { id: 1, title: "One", url: "https://example.com" },
  {
    intervalMs: 60_000,
    bypassCache: false,
    maximumReloads: null,
    interactionBehavior: "ignore",
    protectActiveTyping: true
  },
  100_000,
  "one"
);

describe("recovery planning", () => {
  it("removes missing tabs, schedules running monitors, and clears orphan alarms", () => {
    const missing = { ...running, tabId: 2, tabInstanceId: "two" };
    const paused = pauseMonitor(
      { ...running, tabId: 3, tabInstanceId: "three" },
      110_000
    );
    const plan = planRecovery(
      [running, missing, paused],
      [
        { id: 1, url: running.pageUrl },
        { id: 3, url: paused.pageUrl }
      ],
      [1, 2, 3, 99]
    );

    expect(plan.keep.map((item) => item.tabId)).toEqual([1, 3]);
    expect(plan.removeTabIds).toEqual([2]);
    expect(plan.scheduleTabIds).toEqual([1]);
    expect(plan.clearAlarmTabIds).toEqual([2, 3, 99]);
  });
});
