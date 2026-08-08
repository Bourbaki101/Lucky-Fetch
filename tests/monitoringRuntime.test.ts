import { describe, expect, it } from "vitest";
import {
  applyDetectionAction,
  createKeywordConfig,
  createKeywordRuntime
} from "../src/monitoring/runtime";
import { createRunningMonitor } from "../src/shared/stateMachine";

function monitor() {
  return createRunningMonitor(
    { id: 1, title: "Page", url: "https://example.com/" },
    {
      intervalMs: 30_000,
      bypassCache: false,
      maximumReloads: null,
      interactionBehavior: "ignore",
      protectActiveTyping: true
    },
    1_000,
    "instance",
    {
      ...createKeywordConfig(),
      enabled: true,
      keywords: [{ id: "keyword-1", value: "Ticket" }]
    }
  );
}

describe("after-detection actions", () => {
  it("Continue preserves running state and reload scheduling", () => {
    const current = monitor();
    const updated = applyDetectionAction(current, "continue", 2_000);
    expect(updated.status).toBe("running");
    expect(updated.nextReloadAt).toBe(current.nextReloadAt);
  });

  it("Pause cancels the modeled reload deadline and preserves runtime", () => {
    const current = {
      ...monitor(),
      keywordRuntime: {
        ...createKeywordRuntime(),
        lastMatchState: true
      }
    };
    const updated = applyDetectionAction(current, "pause", 2_000);
    expect(updated.status).toBe("paused");
    expect(updated.nextReloadAt).toBeNull();
    expect(updated.keywordRuntime.lastMatchState).toBe(true);
  });

  it("Stop cancels the modeled reload deadline and preserves history", () => {
    const current = monitor();
    const updated = applyDetectionAction(current, "stop", 2_000);
    expect(updated.status).toBe("stopped");
    expect(updated.nextReloadAt).toBeNull();
    expect(updated.detectionHistory).toEqual(current.detectionHistory);
  });
});
