import {
  NOTIFICATION_HISTORY_LIMIT,
  STORAGE_KEY
} from "../shared/constants";
import { getMaxMonitorDelay, normalizeIntervalMs } from "../shared/time";
import { normalizeQuickTriggers } from "../shared/quickTriggers";
import { validateKeywordConfig } from "../monitoring/matching";
import {
  createKeywordConfig,
  createKeywordRuntime
} from "../monitoring/runtime";
import type {
  DetectionHistoryEntry,
  KeywordRule,
  KeywordMonitoringConfig,
  KeywordMonitoringRuntime,
  PersistedState,
  NotificationHistoryEntry,
  TabMonitor,
  TypedHighlightError,
  TypedMonitorError
} from "../types/monitor";
import { HIGHLIGHT_ERROR_CODES, MONITOR_ERROR_CODES } from "../types/monitor";

const EMPTY_STATE: PersistedState = {
  version: 5,
  monitors: {},
  notificationHistory: [],
  quickTriggers: []
};

function legacyKeywordId(value: string): string {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return `legacy-${(hash >>> 0).toString(36)}`;
}

function isTypedHighlightError(value: unknown): value is TypedHighlightError {
  if (!value || typeof value !== "object") return false;
  const error = value as Partial<TypedHighlightError>;
  return (
    typeof error.code === "string" &&
    HIGHLIGHT_ERROR_CODES.includes(
      error.code as (typeof HIGHLIGHT_ERROR_CODES)[number]
    ) &&
    typeof error.message === "string" &&
    typeof error.occurredAt === "number" &&
    Number.isFinite(error.occurredAt) &&
    typeof error.recoverable === "boolean"
  );
}

function isTypedError(value: unknown): value is TypedMonitorError {
  if (!value || typeof value !== "object") return false;
  const error = value as Partial<TypedMonitorError>;
  return (
    typeof error.code === "string" &&
    MONITOR_ERROR_CODES.includes(
      error.code as (typeof MONITOR_ERROR_CODES)[number]
    ) &&
    typeof error.message === "string" &&
    typeof error.occurredAt === "number" &&
    Number.isFinite(error.occurredAt) &&
    typeof error.recoverable === "boolean"
  );
}

function normalizeRuntime(value: unknown): KeywordMonitoringRuntime {
  const defaults = createKeywordRuntime();
  if (!value || typeof value !== "object") return defaults;
  const candidate = value as Partial<KeywordMonitoringRuntime>;
  const rawScanStatus = (value as { lastScanStatus?: string }).lastScanStatus;
  return {
    lastMatchState:
      candidate.lastMatchState === true || candidate.lastMatchState === false
        ? candidate.lastMatchState
        : null,
    lastScanAt:
      typeof candidate.lastScanAt === "number" &&
      Number.isFinite(candidate.lastScanAt)
        ? candidate.lastScanAt
        : null,
    lastConfirmedAt:
      typeof candidate.lastConfirmedAt === "number" &&
      Number.isFinite(candidate.lastConfirmedAt)
        ? candidate.lastConfirmedAt
        : (candidate.lastMatchState === true || candidate.lastMatchState === false) &&
            typeof candidate.lastScanAt === "number" &&
            Number.isFinite(candidate.lastScanAt)
          ? candidate.lastScanAt
          : null,
    lastDetectionAt:
      typeof candidate.lastDetectionAt === "number" &&
      Number.isFinite(candidate.lastDetectionAt)
        ? candidate.lastDetectionAt
        : null,
    lastScanStatus:
      rawScanStatus === "matched" || rawScanStatus === "not-matched"
        ? "complete"
        : [
            "idle",
            "waiting-for-load",
            "waiting-for-delay",
            "scanning",
            "complete",
            "partial",
            "retrying",
            "incomplete",
            "error"
          ].includes(rawScanStatus ?? "")
          ? rawScanStatus as KeywordMonitoringRuntime["lastScanStatus"]
          : "idle",
    lastError: isTypedError(candidate.lastError)
          ? {
          code: candidate.lastError.code,
          message: candidate.lastError.message,
          ...(typeof candidate.lastError.technicalMessage === "string"
            ? { technicalMessage: candidate.lastError.technicalMessage }
            : {}),
          occurredAt: candidate.lastError.occurredAt,
          recoverable: candidate.lastError.recoverable
        }
      : null,
    navigationGeneration:
      Number.isInteger(candidate.navigationGeneration) &&
      (candidate.navigationGeneration ?? -1) >= 0
        ? candidate.navigationGeneration!
        : 0,
    navigationStartedAt:
      typeof candidate.navigationStartedAt === "number" &&
      Number.isFinite(candidate.navigationStartedAt)
        ? candidate.navigationStartedAt
        : null,
    lastCompletedGeneration:
      Number.isInteger(candidate.lastCompletedGeneration) &&
      (candidate.lastCompletedGeneration ?? -1) >= 0
        ? candidate.lastCompletedGeneration!
        : null,
    lastScannedGeneration:
      Number.isInteger(candidate.lastScannedGeneration) &&
      (candidate.lastScannedGeneration ?? -1) >= 0
        ? candidate.lastScannedGeneration!
        : null,
    pendingScan:
      candidate.pendingScan &&
      Number.isInteger(candidate.pendingScan.generation) &&
      candidate.pendingScan.generation >= 0 &&
      typeof candidate.pendingScan.pageUrl === "string" &&
      typeof candidate.pendingScan.scheduledFor === "number" &&
      Number.isFinite(candidate.pendingScan.scheduledFor) &&
      typeof candidate.pendingScan.alarmName === "string"
        ? {
            generation: candidate.pendingScan.generation,
            pageUrl: candidate.pendingScan.pageUrl,
            scheduledFor: candidate.pendingScan.scheduledFor,
            alarmName: candidate.pendingScan.alarmName,
            retryNumber:
              Number.isInteger(candidate.pendingScan.retryNumber) &&
              (candidate.pendingScan.retryNumber ?? -1) >= 0
                ? candidate.pendingScan.retryNumber!
                : 0,
            reason: candidate.pendingScan.reason === "partial-scan-retry"
              ? "partial-scan-retry"
              : "initial-delay"
          }
        : null,
    scanProgress:
      candidate.scanProgress &&
      Number.isInteger(candidate.scanProgress.generation) &&
      Number.isInteger(candidate.scanProgress.retryNumber) &&
      Number.isInteger(candidate.scanProgress.totalDiscoveredFrameCount) &&
      Number.isInteger(candidate.scanProgress.scannedFrameCount) &&
      Number.isInteger(candidate.scanProgress.pendingFrameCount) &&
      Number.isInteger(candidate.scanProgress.restrictedFrameCount) &&
      Array.isArray(candidate.scanProgress.matchedFrameIds) &&
      candidate.scanProgress.matchedFrameIds.every(Number.isInteger) &&
      typeof candidate.scanProgress.conclusive === "boolean"
        ? {
            generation: candidate.scanProgress.generation,
            retryNumber: candidate.scanProgress.retryNumber,
            totalDiscoveredFrameCount:
              candidate.scanProgress.totalDiscoveredFrameCount,
            scannedFrameCount: candidate.scanProgress.scannedFrameCount,
            pendingFrameCount: candidate.scanProgress.pendingFrameCount,
            restrictedFrameCount: candidate.scanProgress.restrictedFrameCount,
            matchedFrameIds: [...candidate.scanProgress.matchedFrameIds],
            conclusive: candidate.scanProgress.conclusive
          }
        : null,
    lastMatchedKeywords: Array.isArray(candidate.lastMatchedKeywords)
      ? candidate.lastMatchedKeywords
          .filter(
            (keyword) =>
              keyword &&
              typeof keyword.id === "string" &&
              typeof keyword.value === "string"
          )
          .map((keyword) => ({
            id: keyword.id,
            value: keyword.value
          }))
          .slice(0, 20)
      : [],
    matchingFrameCount:
      Number.isInteger(candidate.matchingFrameCount) &&
      (candidate.matchingFrameCount ?? -1) >= 0
        ? candidate.matchingFrameCount!
        : 0,
    highlightedOccurrenceCount:
      Number.isInteger(candidate.highlightedOccurrenceCount) &&
      (candidate.highlightedOccurrenceCount ?? -1) >= 0
        ? candidate.highlightedOccurrenceCount!
        : 0,
    highlightTruncated: candidate.highlightTruncated === true,
    lastHighlightError: isTypedHighlightError(candidate.lastHighlightError)
      ? { ...candidate.lastHighlightError }
      : null,
    lastActionResultSignature:
      typeof candidate.lastActionResultSignature === "string"
        ? candidate.lastActionResultSignature
        : null,
    lastFocusAt:
      typeof candidate.lastFocusAt === "number" &&
      Number.isFinite(candidate.lastFocusAt)
        ? candidate.lastFocusAt
        : null,
    lastClickAt:
      typeof candidate.lastClickAt === "number" &&
      Number.isFinite(candidate.lastClickAt)
        ? candidate.lastClickAt
        : null
  };
}

function normalizeHistoryEntry(
  value: unknown
): DetectionHistoryEntry | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Partial<DetectionHistoryEntry>;
  const valid =
    typeof entry.id === "string" &&
    Number.isInteger(entry.tabId) &&
    typeof entry.keyword === "string" &&
    typeof entry.detectedAt === "number" &&
    Number.isFinite(entry.detectedAt) &&
    typeof entry.pageTitle === "string" &&
    typeof entry.pageUrl === "string" &&
    ["found", "lost"].includes(entry.mode ?? "") &&
    ["continue", "pause", "stop"].includes(entry.actionApplied ?? "");
  if (!valid) return null;
  return {
    id: entry.id!,
    tabId: entry.tabId!,
    mode: entry.mode!,
    keyword: entry.keyword!,
    ...(Array.isArray(entry.matchedKeywords)
      ? {
          matchedKeywords: entry.matchedKeywords
            .filter(
              (keyword) =>
                keyword &&
                typeof keyword.id === "string" &&
                typeof keyword.value === "string"
            )
            .map((keyword) => ({
              id: keyword.id,
              value: keyword.value
            }))
            .slice(0, 20)
        }
      : {}),
    detectedAt: entry.detectedAt!,
    pageTitle: entry.pageTitle!,
    pageUrl: entry.pageUrl!,
    actionApplied: entry.actionApplied!
  };
}

function normalizeNotificationHistoryEntry(
  value: unknown
): NotificationHistoryEntry | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Partial<NotificationHistoryEntry>;
  if (
    typeof entry.id !== "string" ||
    !["found", "lost"].includes(entry.state ?? "") ||
    typeof entry.keyword !== "string" ||
    typeof entry.timestamp !== "number" ||
    !Number.isFinite(entry.timestamp)
  ) {
    return null;
  }
  return {
    id: entry.id,
    state: entry.state!,
    keyword: entry.keyword,
    timestamp: entry.timestamp,
    ...(typeof entry.triggerLabel === "string" && entry.triggerLabel.trim()
      ? { triggerLabel: entry.triggerLabel.trim() }
      : {})
  };
}

function corruptStateError(): TypedMonitorError {
  return {
    code: "CORRUPT_STATE",
    message:
      "Saved keyword-monitoring settings were invalid and were reset safely.",
    occurredAt: Date.now(),
    recoverable: true
  };
}

function normalizeMonitor(value: unknown): TabMonitor | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<TabMonitor>;
  const intervalMs = normalizeIntervalMs(candidate.intervalMs);
  const hadKeywordConfig = candidate.keywordMonitoring !== undefined;
  let keywordMonitoring = createKeywordConfig();
  let configWasCorrupt = false;
  if (hadKeywordConfig) {
    const supplied = candidate.keywordMonitoring as
      | (Partial<KeywordMonitoringConfig> & { keyword?: unknown })
      | undefined;
    let keywords: KeywordRule[] | null = null;
    if (supplied && Array.isArray(supplied.keywords)) {
      keywords = supplied.keywords
        .filter(
          (keyword): keyword is KeywordRule =>
            keyword &&
            typeof keyword === "object" &&
            typeof (keyword as KeywordRule).id === "string" &&
            typeof (keyword as KeywordRule).value === "string"
        )
        .map((keyword) => ({
          id: keyword.id,
          value: keyword.value.trim()
        }));
    } else if (supplied && typeof supplied.keyword === "string") {
      const legacyValue = supplied.keyword.trim();
      keywords =
        legacyValue.length > 0
          ? [{ id: legacyKeywordId(legacyValue), value: legacyValue }]
          : [];
    }
    const normalizedSupplied: KeywordMonitoringConfig | null =
      supplied && typeof supplied === "object" && keywords
        ? {
            enabled: supplied.enabled,
            keywords,
            mode: supplied.mode,
            caseSensitive: supplied.caseSensitive,
            scanDelayMs: supplied.scanDelayMs,
            actionOnDetection: supplied.actionOnDetection,
            highlightMatches:
              typeof supplied.highlightMatches === "boolean"
                ? supplied.highlightMatches
                : false,
            notificationMessage:
              typeof supplied.notificationMessage === "string"
                ? supplied.notificationMessage
                : "",
            bringToFront: ["found", "missing", "all"].includes(
              supplied.bringToFront ?? ""
            )
              ? supplied.bringToFront
              : "never",
            autoOpenResult: [
              "scroll-highlight",
              "click",
              "click-and-focus"
            ].includes(supplied.autoOpenResult ?? "")
              ? supplied.autoOpenResult
              : "off"
          } as KeywordMonitoringConfig
        : null;
    if (
      normalizedSupplied &&
      validateKeywordConfig(normalizedSupplied) === null
    ) {
      keywordMonitoring = {
        enabled: normalizedSupplied.enabled,
        keywords: normalizedSupplied.keywords,
        mode: normalizedSupplied.mode,
        caseSensitive: normalizedSupplied.caseSensitive,
        scanDelayMs: normalizedSupplied.enabled
          ? Math.min(
              normalizedSupplied.scanDelayMs,
              getMaxMonitorDelay(intervalMs)
            )
          : normalizedSupplied.scanDelayMs,
        actionOnDetection: normalizedSupplied.actionOnDetection,
        highlightMatches: normalizedSupplied.highlightMatches,
        notificationMessage: normalizedSupplied.notificationMessage,
        bringToFront: normalizedSupplied.bringToFront,
        autoOpenResult: normalizedSupplied.autoOpenResult
      };
    } else {
      configWasCorrupt = true;
    }
  }

  const keywordRuntime = normalizeRuntime(candidate.keywordRuntime);
  if (configWasCorrupt) {
    keywordRuntime.lastError = corruptStateError();
    keywordRuntime.lastScanStatus = "error";
  }

  return {
    ...(candidate as TabMonitor),
    intervalMs,
    keywordMonitoring,
    keywordRuntime,
    detectionHistory: Array.isArray(candidate.detectionHistory)
      ? candidate.detectionHistory
          .map(normalizeHistoryEntry)
          .filter(
            (entry): entry is DetectionHistoryEntry => entry !== null
          )
          .sort((left, right) => right.detectedAt - left.detectedAt)
          .slice(0, 50)
      : []
  };
}

export function normalizePersistedState(value: unknown): PersistedState {
  if (!value || typeof value !== "object") {
    return structuredClone(EMPTY_STATE);
  }
  const candidate = value as {
    version?: unknown;
    monitors?: unknown;
    notificationHistory?: unknown;
    quickTriggers?: unknown;
  };
  if (
    ![1, 2, 3, 4, 5].includes(Number(candidate.version)) ||
    !candidate.monitors ||
    typeof candidate.monitors !== "object" ||
    Array.isArray(candidate.monitors)
  ) {
    return structuredClone(EMPTY_STATE);
  }

  const monitors: Record<string, TabMonitor> = {};
  for (const [key, monitor] of Object.entries(candidate.monitors)) {
    const normalized = normalizeMonitor(monitor);
    if (normalized) monitors[key] = normalized;
  }
  const notificationHistory = Array.isArray(candidate.notificationHistory)
    ? candidate.notificationHistory
        .map(normalizeNotificationHistoryEntry)
        .filter(
          (entry): entry is NotificationHistoryEntry => entry !== null
        )
        .sort((left, right) => right.timestamp - left.timestamp)
        .slice(0, NOTIFICATION_HISTORY_LIMIT)
    : [];
  return {
    version: 5,
    monitors,
    notificationHistory,
    quickTriggers: normalizeQuickTriggers(candidate.quickTriggers)
  };
}

export async function readState(): Promise<PersistedState> {
  let result: Record<string, unknown>;
  try {
    result = await chrome.storage.local.get(STORAGE_KEY);
  } catch (error) {
    console.error("[storage:error] Failed to read local monitor state.", error);
    throw error;
  }
  return normalizePersistedState(result[STORAGE_KEY]);
}

export async function writeState(state: PersistedState): Promise<void> {
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: state });
  } catch (error) {
    console.error("[storage:error] Failed to write local monitor state.", error);
    throw error;
  }
}

export function monitorKey(tabId: number): string {
  return String(tabId);
}

export function getMonitor(
  state: PersistedState,
  tabId: number
): TabMonitor | undefined {
  return state.monitors[monitorKey(tabId)];
}
