import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeMonitorDraft,
  readMonitorDraft,
  removeMonitorDraft,
  writeMonitorDraft
} from "../src/storage/drafts";
import type { PendingMonitorDraft } from "../src/types/monitor";

function makeDraft(
  overrides: Partial<PendingMonitorDraft> = {}
): PendingMonitorDraft {
  return {
    version: 1,
    tabId: 7,
    pageOrigin: "https://example.com/*",
    savedAt: 1_000,
    reloadConfig: {
      intervalMs: 60_000,
      bypassCache: true,
      maximumReloads: 5,
      interactionBehavior: "delay",
      protectActiveTyping: true
    },
    keywordConfig: {
      enabled: true,
      keywords: [{ id: "keyword-1", value: "New Ticket" }],
      mode: "found",
      caseSensitive: false,
      scanDelayMs: 2_000,
      actionOnDetection: "continue",
      highlightMatches: false,
      notificationMessage: "There is a new ticket!",
      bringToFront: "never",
      autoOpenResult: "off"
    },
    siteAccessPreference: "site",
    startState: "pending",
    ...overrides
  };
}

function installStorageMock() {
  const data: Record<string, unknown> = {};
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: data[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => {
            Object.assign(data, structuredClone(value));
          })
        }
      }
    }
  });
  return data;
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "chrome");
});

describe("pending monitor drafts", () => {
  it("round-trips the complete validated form", async () => {
    installStorageMock();
    const draft = makeDraft();
    await writeMonitorDraft(draft);
    await expect(readMonitorDraft(7)).resolves.toEqual(draft);
  });

  it("preserves denied state and technical diagnostics across remounts", async () => {
    installStorageMock();
    const denied = makeDraft({
      startState: "denied",
      technicalError: "Permission request returned false."
    });
    await writeMonitorDraft(denied);
    await expect(readMonitorDraft(7)).resolves.toEqual(denied);
  });

  it("rejects corrupt drafts without partially restoring the form", () => {
    expect(
      normalizeMonitorDraft({
        ...makeDraft(),
        keywordConfig: {
          ...makeDraft().keywordConfig,
          keywords: [{ id: "keyword-1", value: " " }]
        }
      })
    ).toBeNull();
  });

  it("rejects a combined monitor delay above half the reload interval", () => {
    expect(
      normalizeMonitorDraft(
        makeDraft({
          reloadConfig: { ...makeDraft().reloadConfig, intervalMs: 10_000 },
          keywordConfig: { ...makeDraft().keywordConfig, scanDelayMs: 5_001 }
        })
      )
    ).toBeNull();
    expect(
      normalizeMonitorDraft(
        makeDraft({
          reloadConfig: { ...makeDraft().reloadConfig, intervalMs: 10_000 },
          keywordConfig: { ...makeDraft().keywordConfig, scanDelayMs: 5_000 }
        })
      )
    ).not.toBeNull();
  });

  it("removes only the explicitly discarded tab draft", async () => {
    installStorageMock();
    await writeMonitorDraft(makeDraft());
    await writeMonitorDraft(makeDraft({ tabId: 8 }));
    await removeMonitorDraft(7);
    await expect(readMonitorDraft(7)).resolves.toBeNull();
    await expect(readMonitorDraft(8)).resolves.toMatchObject({ tabId: 8 });
  });

  it("migrates a legacy single-keyword draft with highlighting off", () => {
    const draft = makeDraft() as unknown as Record<string, unknown>;
    draft.keywordConfig = {
      enabled: true,
      keyword: "No tickets found",
      mode: "found",
      caseSensitive: false,
      scanDelayMs: 2_000,
      actionOnDetection: "continue",
      notificationMessage: "Queue"
    };
    const normalized = normalizeMonitorDraft(draft);
    expect(normalized?.keywordConfig.keywords).toHaveLength(1);
    expect(normalized?.keywordConfig.keywords[0]?.value).toBe(
      "No tickets found"
    );
    expect(normalized?.keywordConfig.highlightMatches).toBe(false);
  });
});
