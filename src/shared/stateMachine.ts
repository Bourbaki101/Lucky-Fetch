import {
  ACTIVE_TYPING_IDLE_MS,
  DEFAULT_KEYWORD_MONITORING
} from "./constants";
import type {
  InteractionEvent,
  KeywordMonitoringConfig,
  MonitorSettings,
  TabMonitor,
  TabSummary
} from "../types/monitor";

export function createRunningMonitor(
  tab: TabSummary,
  settings: MonitorSettings,
  now: number,
  tabInstanceId: string,
  keywordMonitoring: KeywordMonitoringConfig = {
    ...DEFAULT_KEYWORD_MONITORING
  }
): TabMonitor {
  return {
    ...settings,
    tabId: tab.id,
    tabInstanceId,
    pageTitle: tab.title,
    pageUrl: tab.url,
    reloadCount: 0,
    status: "running",
    lastReloadAt: null,
    nextReloadAt: now + settings.intervalMs,
    lastUserInteractionAt: null,
    typingProtectionUntil: null,
    errorMessage: null,
    keywordMonitoring,
    keywordRuntime: {
      lastMatchState: null,
      lastScanAt: null,
      lastConfirmedAt: null,
      lastDetectionAt: null,
      lastScanStatus: "idle",
      lastError: null,
      navigationGeneration: 0,
      navigationStartedAt: now,
      lastCompletedGeneration: null,
      lastScannedGeneration: null,
      pendingScan: null,
      scanProgress: null,
      lastMatchedKeywords: [],
      matchingFrameCount: 0,
      highlightedOccurrenceCount: 0,
      highlightTruncated: false,
      lastHighlightError: null,
      lastActionResultSignature: null,
      lastFocusAt: null,
      lastClickAt: null
    },
    detectionHistory: [],
    createdAt: now,
    updatedAt: now
  };
}

export function pauseMonitor(monitor: TabMonitor, now: number): TabMonitor {
  return {
    ...monitor,
    status: "paused",
    nextReloadAt: null,
    errorMessage: null,
    updatedAt: now
  };
}

export function resumeMonitor(monitor: TabMonitor, now: number): TabMonitor {
  return {
    ...monitor,
    status: "running",
    nextReloadAt: now + monitor.intervalMs,
    typingProtectionUntil: null,
    errorMessage: null,
    updatedAt: now
  };
}

export function stopMonitor(monitor: TabMonitor, now: number): TabMonitor {
  return {
    ...monitor,
    status: "stopped",
    nextReloadAt: null,
    typingProtectionUntil: null,
    errorMessage: null,
    updatedAt: now
  };
}

export function errorMonitor(
  monitor: TabMonitor,
  message: string,
  now: number
): TabMonitor {
  return {
    ...monitor,
    status: "error",
    nextReloadAt: null,
    typingProtectionUntil: null,
    errorMessage: message,
    updatedAt: now
  };
}

export function recordAcceptedReload(
  monitor: TabMonitor,
  now: number
): TabMonitor {
  const reloadCount = monitor.reloadCount + 1;
  const completed =
    monitor.maximumReloads !== null &&
    reloadCount >= monitor.maximumReloads;

  return {
    ...monitor,
    reloadCount,
    status: completed ? "completed" : "running",
    lastReloadAt: now,
    nextReloadAt: completed ? null : now + monitor.intervalMs,
    typingProtectionUntil: null,
    errorMessage: null,
    updatedAt: now
  };
}

export function recordManualReload(
  monitor: TabMonitor,
  now: number
): TabMonitor {
  const next = recordAcceptedReload(monitor, now);
  if (next.status === "completed" || monitor.status === "running") {
    return next;
  }
  return {
    ...next,
    status: monitor.status,
    nextReloadAt: null
  };
}

export function applyInteraction(
  monitor: TabMonitor,
  event: InteractionEvent
): TabMonitor {
  const protectedUntil =
    monitor.protectActiveTyping && event.activeTyping
      ? event.occurredAt + ACTIVE_TYPING_IDLE_MS
      : monitor.typingProtectionUntil;

  const base: TabMonitor = {
    ...monitor,
    lastUserInteractionAt: event.occurredAt,
    typingProtectionUntil: protectedUntil,
    updatedAt: event.occurredAt
  };

  if (monitor.status !== "running") return base;

  switch (monitor.interactionBehavior) {
    case "delay":
      return {
        ...base,
        nextReloadAt: event.occurredAt + monitor.intervalMs
      };
    case "pause":
      return {
        ...base,
        status: "paused",
        nextReloadAt: null
      };
    case "stop":
      return {
        ...base,
        status: "stopped",
        nextReloadAt: null,
        typingProtectionUntil: null
      };
    case "ignore":
      return base;
  }
}

export function maximumReached(monitor: TabMonitor): boolean {
  return (
    monitor.maximumReloads !== null &&
    monitor.reloadCount >= monitor.maximumReloads
  );
}
