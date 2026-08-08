import { DEFAULT_KEYWORD_MONITORING } from "../shared/constants";
import {
  pauseMonitor,
  stopMonitor
} from "../shared/stateMachine";
import type {
  DetectionAction,
  KeywordMonitoringConfig,
  KeywordMonitoringRuntime,
  TabMonitor
} from "../types/monitor";

export function createKeywordRuntime(): KeywordMonitoringRuntime {
  return {
    lastMatchState: null,
    lastScanAt: null,
    lastConfirmedAt: null,
    lastDetectionAt: null,
    lastScanStatus: "idle",
    lastError: null,
    navigationGeneration: 0,
    navigationStartedAt: null,
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
  };
}

export function createKeywordConfig(): KeywordMonitoringConfig {
  return {
    ...DEFAULT_KEYWORD_MONITORING,
    keywords: [...DEFAULT_KEYWORD_MONITORING.keywords]
  };
}

export function applyDetectionAction(
  monitor: TabMonitor,
  action: DetectionAction,
  now: number
): TabMonitor {
  switch (action) {
    case "continue":
      return { ...monitor, updatedAt: now };
    case "pause":
      return pauseMonitor(monitor, now);
    case "stop":
      return stopMonitor(monitor, now);
  }
}
