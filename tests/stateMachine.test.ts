import { describe, expect, it } from "vitest";
import {
  applyInteraction,
  createRunningMonitor,
  pauseMonitor,
  recordAcceptedReload,
  recordManualReload,
  resumeMonitor,
  stopMonitor
} from "../src/shared/stateMachine";
import type { MonitorSettings } from "../src/types/monitor";

const settings: MonitorSettings = {
  intervalMs: 30_000,
  bypassCache: false,
  maximumReloads: null,
  interactionBehavior: "ignore",
  protectActiveTyping: true
};

const create = (overrides: Partial<MonitorSettings> = {}) =>
  createRunningMonitor(
    { id: 12, title: "Test", url: "https://example.com" },
    { ...settings, ...overrides },
    100_000,
    "tab-instance"
  );

describe("monitor state transitions", () => {
  it("never schedules a runtime interval below 10 seconds", () => {
    const started = create({ intervalMs: 1_000 });
    expect(started.intervalMs).toBe(10_000);
    expect(started.nextReloadAt).toBe(110_000);
  });

  it("starts, pauses, resumes, and stops with absolute timestamps", () => {
    const started = create();
    expect(started.nextReloadAt).toBe(130_000);

    const paused = pauseMonitor(started, 110_000);
    expect(paused.status).toBe("paused");
    expect(paused.nextReloadAt).toBeNull();

    const resumed = resumeMonitor(paused, 120_000);
    expect(resumed.status).toBe("running");
    expect(resumed.nextReloadAt).toBe(150_000);

    const stopped = stopMonitor(resumed, 125_000);
    expect(stopped.status).toBe("stopped");
    expect(stopped.nextReloadAt).toBeNull();
  });

  it("completes exactly at the maximum reload count", () => {
    let current = create({ maximumReloads: 2 });
    current = recordAcceptedReload(current, 130_000);
    expect(current.status).toBe("running");
    expect(current.reloadCount).toBe(1);
    current = recordAcceptedReload(current, 160_000);
    expect(current.status).toBe("completed");
    expect(current.reloadCount).toBe(2);
    expect(current.nextReloadAt).toBeNull();
  });

  it("resets running countdown on Reload Now but preserves paused state", () => {
    const running = recordManualReload(create(), 110_000);
    expect(running.nextReloadAt).toBe(140_000);

    const paused = recordManualReload(pauseMonitor(create(), 105_000), 110_000);
    expect(paused.status).toBe("paused");
    expect(paused.nextReloadAt).toBeNull();
    expect(paused.reloadCount).toBe(1);
  });
});

describe("interaction decisions", () => {
  const event = {
    kind: "input" as const,
    occurredAt: 110_000,
    activeTyping: true
  };

  it("ignores, delays, pauses, or stops according to the setting", () => {
    const ignored = applyInteraction(create(), event);
    expect(ignored.status).toBe("running");
    expect(ignored.nextReloadAt).toBe(130_000);

    const delayed = applyInteraction(
      create({ interactionBehavior: "delay" }),
      event
    );
    expect(delayed.nextReloadAt).toBe(140_000);

    const paused = applyInteraction(
      create({ interactionBehavior: "pause" }),
      event
    );
    expect(paused.status).toBe("paused");

    const stopped = applyInteraction(
      create({ interactionBehavior: "stop" }),
      event
    );
    expect(stopped.status).toBe("stopped");
  });

  it("records a five-second active typing protection window", () => {
    const protectedMonitor = applyInteraction(create(), event);
    expect(protectedMonitor.typingProtectionUntil).toBe(115_000);

    const unprotected = applyInteraction(
      create({ protectActiveTyping: false }),
      event
    );
    expect(unprotected.typingProtectionUntil).toBeNull();
  });
});
