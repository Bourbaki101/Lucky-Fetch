import type {
  ExtensionRequest,
  ExtensionResponse,
  PagePingRequest,
  PopupRequest
} from "../messaging/contracts";
import {
  isContentRequest,
  isExtensionRequest,
  isPagePingResponse
} from "../messaging/contracts";
import {
  addDetectionHistory,
  addNotificationHistory,
  clearNotificationHistory
} from "../monitoring/history";
import {
  aggregateFrameScans,
  type FrameScanOutcome,
  type TabFrameAggregation
} from "../monitoring/frameAggregation";
import {
  keywordConditionEquals,
  normalizeKeywordRules,
  validateKeywordConfig
} from "../monitoring/matching";
import { applyDetectionAction } from "../monitoring/runtime";
import {
  autoOpenNeedsClick,
  autoOpenNeedsFocus,
  buildResultSignature,
  focusCooldownActive,
  focusModeIncludesTransition,
  selectUnambiguousResult,
  transitionKind,
  type TriggerTransitionKind
} from "../monitoring/triggerActions";
import {
  evaluateKeywordTransition,
  resetKeywordBaseline
} from "../monitoring/transitions";
import {
  alarmName,
  clearReload,
  clearScan,
  clearScansForTab,
  ensureBadgeAlarm,
  scheduleReload,
  scheduleScan,
  scanAlarmName,
  scanIdentityFromAlarm,
  tabIdFromAlarm
} from "../scheduling/alarms";
import { errorMessage, withTimeout } from "../shared/async";
import { getActiveLuckyFetchTabs } from "../shared/activity";
import {
  badgeForReloadDeadline,
  type BadgePresentation
} from "../shared/badge";
import {
  ALARM_PREFIX,
  ALL_WEBSITE_PERMISSION_PATTERNS,
  BADGE_ALARM_NAME,
  CHROME_API_TIMEOUT_MS,
  CONTENT_READY_TIMEOUT_MS,
  CONTENT_SCRIPT_FILE,
  DETECTION_NOTIFICATION_PREFIX,
  INCOMPLETE_SCAN_RETRY_DELAYS_MS,
  MAX_HIGHLIGHTS_PER_FRAME,
  MAX_HIGHLIGHT_TEXT_NODES,
  MAX_NOTIFICATION_KEYWORDS,
  MAX_INTERVAL_MS,
  MIN_INTERVAL_MS,
  NOTIFICATION_TARGET_PREFIX,
  RECOVERY_RELOAD_DELAY_MS,
  SESSION_TOKEN_PREFIX
} from "../shared/constants";
import {
  addQuickTrigger,
  removeQuickTrigger
} from "../shared/quickTriggers";
import { validateMonitorDelayForReload } from "../shared/time";
import {
  clearResolvedMatchTokens,
  resolveMatchedElement as resolveFrameMatchedElements,
  scrollAndHighlightMatch as performFrameTriggerAction,
  type FrameResolvedMatch
} from "../content/triggerActions";
import {
  applyInteraction,
  createRunningMonitor,
  errorMonitor,
  maximumReached,
  pauseMonitor,
  recordAcceptedReload,
  recordManualReload,
  resumeMonitor,
  stopMonitor
} from "../shared/stateMachine";
import { inspectUrl } from "../shared/url";
import {
  getMonitor,
  monitorKey,
  readState,
  writeState
} from "../storage/storage";
import type {
  AlarmDiagnostic,
  DiagnosticSnapshot
} from "../types/diagnostics";
import type {
  DetectionHistoryEntry,
  ActivityEntry,
  FrameHighlightResult,
  KeywordMatch,
  KeywordMonitorMode,
  KeywordRule,
  KeywordTestResult,
  KeywordMonitoringConfig,
  MatchedKeyword,
  MonitorSettings,
  NotificationHistoryEntry,
  PersistedState,
  ScanResult,
  TabMonitor,
  TabSummary,
  TypedHighlightError,
  TypedMonitorError
} from "../types/monitor";
import { isPlausibleMonitor, planRecovery } from "./recovery";

type InitializationStatus = "starting" | "ready" | "error";

let state: PersistedState = {
  version: 5,
  monitors: {},
  notificationHistory: [],
  quickTriggers: []
};
let operationQueue: Promise<unknown> = Promise.resolve();
let initializationStatus: InitializationStatus = "starting";
let initializationError: string | null = null;
let badgeCountdownTimer: ReturnType<typeof setInterval> | null = null;
let badgeCountdownUpdate: Promise<boolean> | null = null;
const scanEpochs = new Map<number, number>();

function invalidateTabScans(tabId: number, reason: string): void {
  const epoch = (scanEpochs.get(tabId) ?? 0) + 1;
  scanEpochs.set(tabId, epoch);
  console.info("[scan:cancel]", { tabId, epoch, reason });
}

function currentScanEpoch(tabId: number): number {
  return scanEpochs.get(tabId) ?? 0;
}

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = operationQueue.then(operation, operation);
  operationQueue = result.catch((error: unknown) => {
    console.error("[background:queue] Operation failed.", error);
  });
  return result;
}

function toTabSummary(tab: chrome.tabs.Tab): TabSummary | null {
  if (tab.id === undefined) return null;
  return {
    id: tab.id,
    title: tab.title ?? "Untitled tab",
    url: tab.url ?? "",
    ...(tab.favIconUrl ? { favIconUrl: tab.favIconUrl } : {})
  };
}

function validateSettings(settings: MonitorSettings): string | null {
  if (!Number.isFinite(settings.intervalMs)) return "Enter a valid reload interval.";
  if (settings.intervalMs < MIN_INTERVAL_MS) {
    return "Minimum reload interval is 10 seconds.";
  }
  if (settings.intervalMs > MAX_INTERVAL_MS) {
    return "Choose a reload interval of 30 days or less.";
  }
  if (
    settings.maximumReloads !== null &&
    (!Number.isInteger(settings.maximumReloads) ||
      settings.maximumReloads < 1 ||
      settings.maximumReloads > 1_000_000)
  ) {
    return "The maximum reload count must be between 1 and 1,000,000.";
  }
  if (
    !["ignore", "delay", "pause", "stop"].includes(
      settings.interactionBehavior
    )
  ) {
    return "Unknown interaction behavior.";
  }
  return null;
}

interface NotificationTarget {
  tabId: number;
  tabInstanceId: string;
  createdAt: number;
}

function monitorError(
  code: TypedMonitorError["code"],
  message: string,
  recoverable = true,
  occurredAt = Date.now(),
  technicalMessage?: string
): TypedMonitorError {
  return {
    code,
    message,
    recoverable,
    occurredAt,
    ...(technicalMessage ? { technicalMessage } : {})
  };
}

function scanErrorFrom(error: unknown): TypedMonitorError {
  const technicalMessage = errorMessage(error);
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return monitorError(
      "SCAN_TIMEOUT",
      "The page scanner did not respond in time. The extension will try again after the next load.",
      true,
      Date.now(),
      technicalMessage
    );
  }
  if (/time|respond within/iu.test(technicalMessage)) {
    return monitorError(
      "SCAN_TIMEOUT",
      "The page scanner did not respond in time. The extension will try again after the next load.",
      true,
      Date.now(),
      technicalMessage
    );
  }
  if (/receiving end|message port|port closed/iu.test(technicalMessage)) {
    return monitorError(
      "CONTENT_SCRIPT_UNAVAILABLE",
      "Scanner was not available on this page. The extension will try to reconnect.",
      true,
      Date.now(),
      technicalMessage
    );
  }
  if (
    /cannot access|missing host permission|not allowed|permission/iu.test(
      technicalMessage
    )
  ) {
    return monitorError(
      "NO_CONTENT_ACCESS",
      "Page access is required to scan this site.",
      true,
      Date.now(),
      technicalMessage
    );
  }
  return monitorError(
    "CONTENT_SCRIPT_UNAVAILABLE",
    "The page scanner could not be started. Reload the page or retry.",
    true,
    Date.now(),
    technicalMessage
  );
}

async function api<T>(label: string, operation: Promise<T>): Promise<T> {
  return withTimeout(operation, label, CHROME_API_TIMEOUT_MS);
}

async function getTab(tabId: number): Promise<chrome.tabs.Tab> {
  const tab = await api(`Read tab ${tabId}`, chrome.tabs.get(tabId));
  if (tab.id === undefined) throw new Error("The selected tab is unavailable.");
  return tab;
}

async function getTabIfPresent(
  tabId: number
): Promise<chrome.tabs.Tab | null> {
  try {
    return await getTab(tabId);
  } catch {
    return null;
  }
}

async function setSessionToken(tabId: number, token: string): Promise<void> {
  await api(
    `Store tab identity ${tabId}`,
    chrome.storage.session.set({
      [`${SESSION_TOKEN_PREFIX}${tabId}`]: token
    })
  );
}

async function removeSessionToken(tabId: number): Promise<void> {
  await api(
    `Remove tab identity ${tabId}`,
    chrome.storage.session.remove(`${SESSION_TOKEN_PREFIX}${tabId}`)
  );
}

function notificationTargetKey(notificationId: string): string {
  return `${NOTIFICATION_TARGET_PREFIX}${notificationId}`;
}

async function saveNotificationTarget(
  notificationId: string,
  target: NotificationTarget
): Promise<void> {
  await api(
    "Save notification target",
    chrome.storage.session.set({
      [notificationTargetKey(notificationId)]: target
    })
  );
}

async function readNotificationTarget(
  notificationId: string
): Promise<NotificationTarget | null> {
  const key = notificationTargetKey(notificationId);
  const values = await api(
    "Read notification target",
    chrome.storage.session.get(key)
  );
  const value = values[key];
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<NotificationTarget>;
  return Number.isInteger(candidate.tabId) &&
    typeof candidate.tabInstanceId === "string" &&
    typeof candidate.createdAt === "number"
    ? (candidate as NotificationTarget)
    : null;
}

async function removeNotificationTarget(
  notificationId: string
): Promise<void> {
  await api(
    "Remove notification target",
    chrome.storage.session.remove(notificationTargetKey(notificationId))
  );
}

async function permissionGranted(url: string): Promise<boolean> {
  const support = inspectUrl(url);
  if (!support.supported || !support.permissionPattern) return false;
  if (
    !url.startsWith("file:") &&
    await api(
      "Check access to all websites",
      chrome.permissions.contains({
        origins: [...ALL_WEBSITE_PERMISSION_PATTERNS]
      })
    )
  ) {
    return true;
  }
  return api(
    `Check site access for ${support.permissionPattern}`,
    chrome.permissions.contains({ origins: [support.permissionPattern] })
  );
}

type ContentReadiness =
  | { ok: true; tab: chrome.tabs.Tab }
  | { ok: false; error: TypedMonitorError };

async function pingContentScript(tabId: number): Promise<boolean> {
  const request: PagePingRequest = { type: "content:ping" };
  const response = await withTimeout(
    chrome.tabs.sendMessage(tabId, request),
    `Wait for page scanner in tab ${tabId}`,
    CONTENT_READY_TIMEOUT_MS
  );
  return isPagePingResponse(response);
}

async function injectContentScript(tabId: number): Promise<void> {
  console.info("[scan:inject]", { tabId, stage: "start" });
  // A development extension reload can leave an isolated-world marker behind
  // after the old runtime listener has been invalidated. A failed ping proves
  // that no current listener is reachable, so clearing only our markers is safe.
  await api(
    `Clear stale scanner marker in tab ${tabId}`,
    chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const target = window as Window & {
          __luckyFetchContentScript?: unknown;
          __luckyFetchInteractionDetector?: unknown;
        };
        delete target.__luckyFetchContentScript;
        delete target.__luckyFetchInteractionDetector;
      }
    })
  );
  await api(
    `Inject page scanner into tab ${tabId}`,
    chrome.scripting.executeScript({
      target: { tabId },
      files: [CONTENT_SCRIPT_FILE]
    })
  );
  console.info("[scan:inject]", { tabId, stage: "complete" });
}

async function ensureContentScriptReady(
  tabId: number,
  forceInjection = false
): Promise<ContentReadiness> {
  const tab = await getTabIfPresent(tabId);
  if (!tab) {
    return {
      ok: false,
      error: monitorError(
        "TAB_CLOSED",
        "This tab was closed before it could be scanned.",
        false
      )
    };
  }

  const support = inspectUrl(tab.url ?? "");
  if (!support.supported) {
    console.info("[scan:unsupported]", {
      tabId,
      url: tab.url,
      reason: support.reason
    });
    return {
      ok: false,
      error: monitorError(
        "RESTRICTED_PAGE",
        "This browser page cannot be scanned by extensions.",
        false,
        Date.now(),
        support.reason ?? undefined
      )
    };
  }

  let hasPermission: boolean;
  try {
    hasPermission = await permissionGranted(tab.url ?? "");
  } catch (error) {
    return { ok: false, error: scanErrorFrom(error) };
  }
  console.info("[scan:permission]", {
    tabId,
    pattern: support.permissionPattern,
    granted: hasPermission
  });
  if (!hasPermission) {
    return {
      ok: false,
      error: monitorError(
        "NO_CONTENT_ACCESS",
        "Page access is required to scan this site."
      )
    };
  }

  if (!forceInjection) {
    try {
      if (await pingContentScript(tabId)) return { ok: true, tab };
    } catch (error) {
      console.info("[scan:inject]", {
        tabId,
        stage: "ping-missed",
        error: errorMessage(error)
      });
    }
  }

  try {
    await injectContentScript(tabId);
    if (!(await pingContentScript(tabId))) {
      throw new Error("The injected page scanner returned an invalid ping.");
    }
    return { ok: true, tab };
  } catch (error) {
    console.error("[scan:inject]", {
      tabId,
      stage: "failed",
      error: errorMessage(error)
    });
    return { ok: false, error: scanErrorFrom(error) };
  }
}

async function prepareContentForMonitor(
  monitor: TabMonitor,
  context: "start" | "resume" | "restore"
): Promise<TabMonitor> {
  const readiness = await ensureContentScriptReady(monitor.tabId);
  if (readiness.ok) return monitor;
  if (monitor.keywordMonitoring.enabled) {
    return persistScanError(monitor, readiness.error);
  }
  return persistMonitor(
    errorMonitor(
      monitor,
      `Interaction protection could not ${context}: ${
        readiness.error.technicalMessage ?? readiness.error.message
      }`,
      Date.now()
    )
  );
}

interface DiscoveredFrame {
  frameId: number;
  parentFrameId: number;
  url: string;
  documentId?: string;
  documentLifecycle?: string;
  errorOccurred?: boolean;
}

type InjectedFrameScanResponse =
  | {
      ok: true;
      scanRequestId: string;
      generation: number;
      matched: boolean;
      scannedAt: number;
      pageUrl: string;
      pageTitle: string;
      textLength: number;
      matches: KeywordMatch[];
    }
  | {
      ok: false;
      scanRequestId: string;
      generation: number;
      code: "EMPTY_DOCUMENT" | "INVALID_CONFIGURATION" | "UNKNOWN";
      message: string;
    };

function isInjectedFrameScanResponse(
  value: unknown
): value is InjectedFrameScanResponse {
  if (!value || typeof value !== "object") return false;
  const response = value as {
    ok?: unknown;
    scanRequestId?: unknown;
    generation?: unknown;
    matched?: unknown;
    scannedAt?: unknown;
    pageUrl?: unknown;
    pageTitle?: unknown;
    textLength?: unknown;
    matches?: unknown;
    code?: unknown;
    message?: unknown;
  };
  if (
    typeof response.ok !== "boolean" ||
    typeof response.scanRequestId !== "string" ||
    !Number.isInteger(response.generation)
  ) {
    return false;
  }
  if (!response.ok) {
    return typeof response.code === "string" &&
      typeof response.message === "string";
  }
  return (
    typeof response.matched === "boolean" &&
    typeof response.scannedAt === "number" &&
    typeof response.pageUrl === "string" &&
    typeof response.pageTitle === "string" &&
    typeof response.textLength === "number" &&
    Array.isArray(response.matches) &&
    response.matches.every(
      (match) =>
        match &&
        typeof match === "object" &&
        typeof (match as KeywordMatch).keywordId === "string" &&
        typeof (match as KeywordMatch).keyword === "string" &&
        typeof (match as KeywordMatch).matched === "boolean"
    )
  );
}

function scanFrameVisibleText(
  keywords: KeywordRule[],
  caseSensitive: boolean,
  scanRequestId: string,
  generation: number
): InjectedFrameScanResponse {
  if (!document.body) {
    return {
      ok: false,
      scanRequestId,
      generation,
      code: "EMPTY_DOCUMENT",
      message: "The frame does not have a readable document body."
    };
  }
  try {
    if (
      !Array.isArray(keywords) ||
      keywords.length === 0 ||
      keywords.some(
        (keyword) =>
          !keyword ||
          typeof keyword.id !== "string" ||
          typeof keyword.value !== "string" ||
          keyword.value.trim().length === 0
      )
    ) {
      return {
        ok: false,
        scanRequestId,
        generation,
        code: "INVALID_CONFIGURATION",
        message: "Enter a keyword or phrase."
      };
    }
    const normalizedText = document.body.innerText
      .replace(/\r\n?/gu, "\n")
      .replace(/\s+/gu, " ")
      .trim();
    const haystack = caseSensitive
      ? normalizedText
      : normalizedText.toLowerCase();
    const matches = keywords.map((keyword): KeywordMatch => {
      const normalizedKeyword = keyword.value
        .replace(/\r\n?/gu, "\n")
        .replace(/\s+/gu, " ")
        .trim();
      const needle = caseSensitive
        ? normalizedKeyword
        : normalizedKeyword.toLowerCase();
      let occurrenceCount = 0;
      let from = 0;
      while (needle.length > 0) {
        const found = haystack.indexOf(needle, from);
        if (found < 0) break;
        occurrenceCount += 1;
        from = found + needle.length;
      }
      return {
        keywordId: keyword.id,
        keyword: keyword.value.trim(),
        matched: occurrenceCount > 0,
        occurrenceCount
      };
    });
    return {
      ok: true,
      scanRequestId,
      generation,
      matched: matches.some((match) => match.matched),
      matches,
      scannedAt: Date.now(),
      pageUrl: window.location.href,
      pageTitle: document.title,
      textLength: normalizedText.length
    };
  } catch (error) {
    return {
      ok: false,
      scanRequestId,
      generation,
      code: "UNKNOWN",
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

async function discoverCurrentFrames(
  tabId: number
): Promise<DiscoveredFrame[]> {
  const frames = await api(
    `Discover frames in tab ${tabId}`,
    chrome.webNavigation.getAllFrames({ tabId })
  );
  if (!frames || frames.length === 0) {
    throw new Error("Chromium returned no current frames for this tab.");
  }
  return frames.map((frame) => ({
    frameId: frame.frameId,
    parentFrameId: frame.parentFrameId,
    url: frame.url,
    ...(frame.documentId ? { documentId: frame.documentId } : {}),
    ...(frame.documentLifecycle
      ? { documentLifecycle: frame.documentLifecycle }
      : {}),
    ...(frame.errorOccurred !== undefined
      ? { errorOccurred: frame.errorOccurred }
      : {})
  }));
}

async function scanCurrentFrames(
  tabId: number,
  generation: number,
  keywords: KeywordRule[],
  caseSensitive: boolean,
  retryNumber = 0,
  navigationStartedAt: number | null = null
): Promise<TabFrameAggregation> {
  const scanStartedAt = Date.now();
  const scanRequestId = globalThis.crypto.randomUUID();
  const frames = await discoverCurrentFrames(tabId);
  console.info("[scan:frames]", {
    tabId,
    generation,
    retryNumber,
    navigationStartedAt,
    scanRequestId,
    frames: frames.map((frame) => ({
      frameId: frame.frameId,
      parentFrameId: frame.parentFrameId,
      documentId: frame.documentId,
      url: frame.url
    }))
  });

  const permissionChecks = new Map<string, Promise<boolean>>();
  const outcomes = await Promise.all(
    frames.map(async (frame): Promise<FrameScanOutcome> => {
      if (
        frame.errorOccurred ||
        (frame.documentLifecycle !== undefined &&
          frame.documentLifecycle !== "active")
      ) {
        return {
          status: "pending",
          frameId: frame.frameId,
          ...(frame.documentId ? { documentId: frame.documentId } : {}),
          reason: "stale-document"
        };
      }
      const support = inspectUrl(frame.url);
      if (!support.supported || !support.permissionPattern) {
        return {
          status: "restricted",
          frameId: frame.frameId,
          ...(frame.documentId ? { documentId: frame.documentId } : {}),
          reason: "unsupported"
        };
      }
      let access = permissionChecks.get(support.permissionPattern);
      if (!access) {
        access = permissionGranted(frame.url);
        permissionChecks.set(support.permissionPattern, access);
      }
      if (!(await access)) {
        return {
          status: "restricted",
          frameId: frame.frameId,
          ...(frame.documentId ? { documentId: frame.documentId } : {}),
          reason: "missing-permission"
        };
      }

      try {
        const injections = await api(
          `Scan frame ${frame.frameId} in tab ${tabId}`,
          chrome.scripting.executeScript({
            target: {
              tabId,
              frameIds: [frame.frameId]
            },
            func: scanFrameVisibleText,
            args: [keywords, caseSensitive, scanRequestId, generation]
          })
        );
        const injection = injections.find(
          (candidate) => candidate.frameId === frame.frameId
        );
        if (
          !injection ||
          !isInjectedFrameScanResponse(injection.result) ||
          injection.result.scanRequestId !== scanRequestId ||
          injection.result.generation !== generation
        ) {
          return {
            status: "pending",
            frameId: frame.frameId,
            ...(frame.documentId ? { documentId: frame.documentId } : {}),
            reason: "invalid-response"
          };
        }
        if (
          !injection.result.ok
        ) {
          return {
            status: "pending",
            frameId: frame.frameId,
            ...(frame.documentId ? { documentId: frame.documentId } : {}),
            reason:
              injection.result.code === "EMPTY_DOCUMENT"
                ? "empty-document"
                : "invalid-response"
          };
        }
        if (
          (frame.documentId &&
            injection.documentId &&
            frame.documentId !== injection.documentId) ||
          injection.result.pageUrl !== frame.url
        ) {
          return {
            status: "pending",
            frameId: frame.frameId,
            ...(frame.documentId ? { documentId: frame.documentId } : {}),
            reason: "stale-document"
          };
        }
        return {
          status: "success",
          frameId: frame.frameId,
          ...(injection.documentId
            ? { documentId: injection.documentId }
            : {}),
          matched: injection.result.matched,
          matches: injection.result.matches,
          scannedAt: injection.result.scannedAt,
          textLength: injection.result.textLength
        };
      } catch (error) {
        console.warn("[scan:frame-unavailable]", {
          tabId,
          generation,
          scanRequestId,
          frameId: frame.frameId,
          documentId: frame.documentId,
          url: frame.url,
          error: errorMessage(error)
        });
        return {
          status: "pending",
          frameId: frame.frameId,
          ...(frame.documentId ? { documentId: frame.documentId } : {}),
          reason: "injection-failed"
        };
      }
    })
  );
  const aggregation = aggregateFrameScans(outcomes, scanStartedAt);
  console.info("[scan:aggregate]", {
    tabId,
    generation,
    retryNumber,
    navigationStartedAt,
    scanRequestId,
    status: aggregation.status,
    matched: aggregation.matched,
    scannedFrameCount: aggregation.scannedFrameCount,
    unavailableFrameCount: aggregation.unavailableFrameCount,
    totalDiscoveredFrames: aggregation.totalDiscoveredFrameCount,
    successfullyScannedFrames: aggregation.scannedFrameCount,
    pendingFrames: aggregation.pendingFrameCount,
    restrictedFrames: aggregation.restrictedFrameCount,
    matchedFrameIds: aggregation.matchedFrameIds,
    conclusive: aggregation.conclusive,
    outcomes: outcomes.map((outcome) => ({
      frameId: outcome.frameId,
      documentId: outcome.documentId,
      status: outcome.status,
      ...(outcome.status === "success"
        ? { matched: outcome.matched }
        : { reason: outcome.reason })
    }))
  });
  return aggregation;
}

interface HighlightSummary {
  highlightedOccurrenceCount: number;
  truncated: boolean;
  errors: TypedHighlightError[];
  frameResults: FrameHighlightResult[];
}

function clearFrameHighlights(): number {
  const marks = Array.from(
    document.querySelectorAll<HTMLElement>(
      'mark[data-tab-monitor-highlight="true"]'
    )
  );
  const parents = new Set<Node>();
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    parents.add(parent);
    mark.replaceWith(document.createTextNode(mark.textContent ?? ""));
  }
  for (const parent of parents) parent.normalize();
  return marks.length;
}

function highlightFrameVisibleText(
  keywords: KeywordRule[],
  caseSensitive: boolean,
  expectedUrl: string,
  frameId: number,
  maxHighlights: number,
  maxTextNodes: number
): {
  ok: boolean;
  pageUrl: string;
  highlightedOccurrenceCount: number;
  truncated: boolean;
  code?: TypedHighlightError["code"];
  message?: string;
} {
  const pageUrl = window.location.href;
  if (pageUrl !== expectedUrl) {
    return {
      ok: false,
      pageUrl,
      highlightedOccurrenceCount: 0,
      truncated: false,
      code: "DOCUMENT_CHANGED",
      message: "The frame navigated before highlighting was applied."
    };
  }
  const oldMarks = Array.from(
    document.querySelectorAll<HTMLElement>(
      'mark[data-tab-monitor-highlight="true"]'
    )
  );
  const oldParents = new Set<Node>();
  for (const mark of oldMarks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    oldParents.add(parent);
    mark.replaceWith(document.createTextNode(mark.textContent ?? ""));
  }
  for (const parent of oldParents) parent.normalize();

  if (
    !["text/html", "application/xhtml+xml"].includes(document.contentType)
  ) {
    return {
      ok: false,
      pageUrl,
      highlightedOccurrenceCount: 0,
      truncated: false,
      code: "UNSUPPORTED_DOCUMENT",
      message: "This document type does not support safe highlighting."
    };
  }
  if (!document.body) {
    return {
      ok: false,
      pageUrl,
      highlightedOccurrenceCount: 0,
      truncated: false,
      code: "DOM_UNAVAILABLE",
      message: "The frame DOM is unavailable."
    };
  }
  const sorted = [...keywords].sort(
    (left, right) => right.value.length - left.value.length
  );
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT
  );
  const nodes: Text[] = [];
  let current: Node | null = null;
  while (nodes.length < maxTextNodes && (current = walker.nextNode())) {
    if (!(current instanceof Text) || !current.data) continue;
    const parent = current.parentElement;
    if (
      !parent ||
      parent.closest(
        [
          "script",
          "style",
          "noscript",
          "textarea",
          "input",
          "select",
          "option",
          "[contenteditable]",
          'mark[data-tab-monitor-highlight="true"]',
          "[data-luckyfetch-ui]"
        ].join(",")
      )
    ) {
      continue;
    }
    const selection = document.getSelection();
    let selected = false;
    if (selection && !selection.isCollapsed) {
      for (let index = 0; index < selection.rangeCount; index += 1) {
        try {
          if (selection.getRangeAt(index).intersectsNode(current)) {
            selected = true;
            break;
          }
        } catch {
          // Ignore a stale selection range.
        }
      }
    }
    if (selected) continue;
    const style = getComputedStyle(parent);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse"
    ) {
      continue;
    }
    nodes.push(current);
  }

  const preparedKeywords = sorted.map((keyword) => ({
    keyword,
    needle: caseSensitive ? keyword.value : keyword.value.toLowerCase()
  }));

  let highlightedOccurrenceCount = 0;
  let truncated = current !== null;
  for (const node of nodes) {
    const text = node.data;
    const occupied = new Uint8Array(text.length);
    const haystack = caseSensitive ? text : text.toLowerCase();
    const matches: Array<{
      start: number;
      end: number;
      keyword: KeywordRule;
    }> = [];
    for (const { keyword, needle } of preparedKeywords) {
      let from = 0;
      while (needle.length > 0) {
        const start = haystack.indexOf(needle, from);
        if (start < 0) break;
        const end = start + needle.length;
        let overlaps = false;
        for (let index = start; index < end; index += 1) {
          if (occupied[index]) {
            overlaps = true;
            break;
          }
        }
        if (!overlaps) {
          occupied.fill(1, start, end);
          matches.push({ start, end, keyword });
        }
        from = start + Math.max(1, needle.length);
      }
    }
    matches.sort((left, right) => left.start - right.start);
    const remaining = maxHighlights - highlightedOccurrenceCount;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const accepted = matches.slice(0, remaining);
    if (matches.length > accepted.length) truncated = true;
    if (accepted.length === 0 || !node.parentNode) continue;
    const fragment = document.createDocumentFragment();
    let offset = 0;
    for (const match of accepted) {
      if (match.start > offset) {
        fragment.append(text.slice(offset, match.start));
      }
      const mark = document.createElement("mark");
      mark.setAttribute("data-tab-monitor-highlight", "true");
      mark.setAttribute("data-keyword-id", match.keyword.id);
      mark.className = "luckyfetch-keyword-highlight";
      mark.style.background = "#ffe58f";
      mark.style.color = "#1f2937";
      mark.style.outline = "1px solid #d6a600";
      mark.style.borderRadius = "2px";
      mark.style.padding = "0";
      mark.textContent = text.slice(match.start, match.end);
      fragment.append(mark);
      offset = match.end;
    }
    if (offset < text.length) fragment.append(text.slice(offset));
    node.replaceWith(fragment);
    highlightedOccurrenceCount += accepted.length;
  }
  return {
    ok: true,
    pageUrl,
    highlightedOccurrenceCount,
    truncated,
    ...(truncated
      ? {
          code: "HIGHLIGHT_LIMIT_REACHED" as const,
          message: `Highlighting reached its per-frame safety limit in frame ${frameId}.`
        }
      : {})
  };
}

function typedHighlightError(
  code: TypedHighlightError["code"],
  message: string,
  frameId?: number,
  technicalMessage?: string
): TypedHighlightError {
  return {
    code,
    message,
    occurredAt: Date.now(),
    recoverable: true,
    ...(frameId === undefined ? {} : { frameId }),
    ...(technicalMessage ? { technicalMessage } : {})
  };
}

function highlightErrorFrom(
  error: unknown,
  frameId: number
): TypedHighlightError {
  const technical = errorMessage(error);
  if (/time|respond within/iu.test(technical)) {
    return typedHighlightError(
      "HIGHLIGHT_REQUEST_TIMED_OUT",
      "A frame did not finish highlighting in time.",
      frameId,
      technical
    );
  }
  if (/context invalidated|extension context/iu.test(technical)) {
    return typedHighlightError(
      "CONTENT_SCRIPT_CONTEXT_INVALIDATED",
      "The page context changed before highlighting completed.",
      frameId,
      technical
    );
  }
  if (/no frame|frame.*removed|frame.*exist/iu.test(technical)) {
    return typedHighlightError(
      "FRAME_NO_LONGER_EXISTS",
      "A matching frame no longer exists.",
      frameId,
      technical
    );
  }
  return typedHighlightError(
    "CANNOT_ACCESS_FRAME",
    "A matching frame could not be highlighted.",
    frameId,
    technical
  );
}

async function applyHighlights(
  tabId: number,
  matchedFrames: ReadonlyArray<{ frameId: number; documentId?: string }>,
  keywords: readonly KeywordRule[],
  caseSensitive: boolean
): Promise<HighlightSummary> {
  const frames = await discoverCurrentFrames(tabId);
  const targets = frames.filter((frame) =>
    matchedFrames.some(
      (matched) =>
        matched.frameId === frame.frameId &&
        (!matched.documentId || matched.documentId === frame.documentId)
    )
  );
  const errors = matchedFrames
    .filter(
      (matched) =>
        !targets.some((target) => target.frameId === matched.frameId)
    )
    .map((matched) => {
      const frameStillExists = frames.some(
        (frame) => frame.frameId === matched.frameId
      );
      return typedHighlightError(
        frameStillExists ? "DOCUMENT_CHANGED" : "FRAME_NO_LONGER_EXISTS",
        frameStillExists
          ? "A matching frame navigated before highlighting was applied."
          : "A matching frame no longer exists.",
        matched.frameId
      );
    });
  const frameResults = await Promise.all(
    targets.map(async (frame): Promise<FrameHighlightResult> => {
      try {
        const injections = await api(
          `Highlight frame ${frame.frameId} in tab ${tabId}`,
          chrome.scripting.executeScript({
            target: { tabId, frameIds: [frame.frameId] },
            func: highlightFrameVisibleText,
            args: [
              [...keywords],
              caseSensitive,
              frame.url,
              frame.frameId,
              MAX_HIGHLIGHTS_PER_FRAME,
              MAX_HIGHLIGHT_TEXT_NODES
            ]
          })
        );
        const injection = injections.find(
          (candidate) => candidate.frameId === frame.frameId
        );
        const result = injection?.result;
        if (
          !result ||
          typeof result !== "object" ||
          typeof result.ok !== "boolean" ||
          typeof result.highlightedOccurrenceCount !== "number" ||
          typeof result.truncated !== "boolean"
        ) {
          return {
            frameId: frame.frameId,
            highlightedOccurrenceCount: 0,
            truncated: false,
            error: typedHighlightError(
              "CONTENT_SCRIPT_CONTEXT_INVALIDATED",
              "The highlight response was invalid.",
              frame.frameId
            )
          };
        }
        const nonfatal =
          result.code === "HIGHLIGHT_LIMIT_REACHED"
            ? typedHighlightError(
                "HIGHLIGHT_LIMIT_REACHED",
                result.message ?? "The frame highlight limit was reached.",
                frame.frameId
              )
            : undefined;
        const failure =
          !result.ok
            ? typedHighlightError(
                result.code ?? "UNKNOWN",
                result.message ?? "Highlighting failed.",
                frame.frameId
              )
            : undefined;
        return {
          frameId: frame.frameId,
          highlightedOccurrenceCount: result.highlightedOccurrenceCount,
          truncated: result.truncated,
          ...((failure ?? nonfatal) ? { error: failure ?? nonfatal } : {})
        };
      } catch (error) {
        return {
          frameId: frame.frameId,
          highlightedOccurrenceCount: 0,
          truncated: false,
          error: highlightErrorFrom(error, frame.frameId)
        };
      }
    })
  );
  errors.push(
    ...frameResults.flatMap((result) => (result.error ? [result.error] : []))
  );
  return {
    highlightedOccurrenceCount: frameResults.reduce(
      (total, result) => total + result.highlightedOccurrenceCount,
      0
    ),
    truncated: frameResults.some((result) => result.truncated),
    errors,
    frameResults
  };
}

async function clearHighlights(tabId: number): Promise<number> {
  let frames: DiscoveredFrame[];
  try {
    frames = await discoverCurrentFrames(tabId);
  } catch {
    return 0;
  }
  const results = await Promise.allSettled(
    frames.map((frame) =>
      api(
        `Clear highlights in frame ${frame.frameId} of tab ${tabId}`,
        chrome.scripting.executeScript({
          target: { tabId, frameIds: [frame.frameId] },
          func: clearFrameHighlights
        })
      )
    )
  );
  return results.reduce((total, result) => {
    if (result.status !== "fulfilled") return total;
    return (
      total +
      result.value.reduce(
        (frameTotal, injection) =>
          frameTotal +
          (typeof injection.result === "number" ? injection.result : 0),
        0
      )
    );
  }, 0);
}

function bestEffortClearHighlights(tabId: number): void {
  void clearHighlights(tabId).catch((error) => {
    console.info("[highlight:clear-skipped]", {
      tabId,
      error: errorMessage(error)
    });
  });
}

async function setGlobalBadge(badge: BadgePresentation): Promise<void> {
  try {
    await Promise.all([
      api(
        "Set global badge text",
        chrome.action.setBadgeText({ text: badge.text })
      ),
      api(
        "Set global badge color",
        chrome.action.setBadgeBackgroundColor({
          color: badge.color
        })
      ),
      api(
        "Set global action title",
        chrome.action.setTitle({ title: badge.title })
      )
    ]);
  } catch (error) {
    console.error("[badge:update]", { error });
    throw error;
  }
}

async function setTabBadge(
  tabId: number,
  badge: BadgePresentation
): Promise<void> {
  try {
    await Promise.all([
      api(
        `Set badge text for tab ${tabId}`,
        chrome.action.setBadgeText({ tabId, text: badge.text })
      ),
      api(
        `Set badge color for tab ${tabId}`,
        chrome.action.setBadgeBackgroundColor({
          tabId,
          color: badge.color
        })
      ),
      api(
        `Set action title for tab ${tabId}`,
        chrome.action.setTitle({ tabId, title: badge.title })
      )
    ]);
  } catch (error) {
    console.error("[badge:update]", { tabId, error });
    throw error;
  }
}

function countdownBadgeForMonitor(
  monitor: TabMonitor | undefined,
  now = Date.now()
): BadgePresentation {
  if (
    monitor?.status !== "running" ||
    monitor.nextReloadAt === null ||
    !Number.isFinite(monitor.nextReloadAt)
  ) {
    return { text: "", color: "#59636e", title: "Lucky Fetch" };
  }
  return badgeForReloadDeadline(monitor.nextReloadAt, now);
}

function stopBadgeCountdownTimer(): void {
  if (badgeCountdownTimer === null) return;
  clearInterval(badgeCountdownTimer);
  badgeCountdownTimer = null;
}

async function updateBadgeCountdown(): Promise<boolean> {
  const latest = await api("Read monitor state for badge", readState());
  const monitors = Object.values(latest.monitors);
  const now = Date.now();
  await Promise.all(
    monitors.map((monitor) =>
      setTabBadge(
        monitor.tabId,
        countdownBadgeForMonitor(monitor, now)
      )
    )
  );
  const hasRunningCountdown = monitors.some(
    (monitor) =>
      monitor.status === "running" &&
      monitor.nextReloadAt !== null &&
      Number.isFinite(monitor.nextReloadAt)
  );
  if (!hasRunningCountdown) stopBadgeCountdownTimer();
  return hasRunningCountdown;
}

function trackBadgeCountdownUpdate(
  update: Promise<boolean>
): Promise<boolean> {
  badgeCountdownUpdate = update;
  void update.then(
    () => {
      if (badgeCountdownUpdate === update) badgeCountdownUpdate = null;
    },
    () => {
      if (badgeCountdownUpdate === update) badgeCountdownUpdate = null;
    }
  );
  return update;
}

function syncBadgeCountdown(forceFresh = false): Promise<boolean> {
  if (badgeCountdownUpdate) {
    if (!forceFresh) return badgeCountdownUpdate;
    return trackBadgeCountdownUpdate(
      badgeCountdownUpdate.then(updateBadgeCountdown, updateBadgeCountdown)
    );
  }
  return trackBadgeCountdownUpdate(updateBadgeCountdown());
}

function startBadgeCountdownTimer(): void {
  if (badgeCountdownTimer === null) {
    // The interval is visual only. Persisted deadlines and alarms repair drift
    // whenever Manifest V3 wakes this worker again.
    badgeCountdownTimer = setInterval(() => {
      void syncBadgeCountdown().catch((error: unknown) => {
        console.error("[badge:update] Countdown tick failed.", error);
      });
    }, 1_000);
    (
      badgeCountdownTimer as unknown as { unref?: () => void }
    ).unref?.();
  }
}

export function startBadgeCountdown(): void {
  startBadgeCountdownTimer();
  void syncBadgeCountdown(true).catch((error: unknown) => {
    console.error("[badge:update] Countdown restore failed.", error);
  });
}

export async function stopBadgeCountdown(clearBadge = true): Promise<void> {
  stopBadgeCountdownTimer();
  if (clearBadge) {
    await setGlobalBadge({
      text: "",
      color: "#59636e",
      title: "Lucky Fetch"
    });
  }
}

async function restoreBadgeCountdown(): Promise<void> {
  if (await syncBadgeCountdown(true)) startBadgeCountdownTimer();
}

async function applyBadge(tabId: number, monitor?: TabMonitor): Promise<void> {
  await setTabBadge(tabId, countdownBadgeForMonitor(monitor));
  if (monitor?.status === "running") startBadgeCountdownTimer();
}

async function updateActiveBadge(): Promise<void> {
  await restoreBadgeCountdown();
}

async function clearGlobalBadgeDefault(): Promise<void> {
  try {
    await stopBadgeCountdown();
  } catch (error) {
    console.error("[badge:update] Could not clear the global badge default.", error);
  }
}

async function bestEffortClearReload(tabId: number): Promise<void> {
  try {
    await clearReload(tabId);
  } catch (error) {
    console.error("[alarm:clear]", { tabId, error });
  }
}

async function bestEffortClearScans(tabId: number): Promise<void> {
  try {
    await clearScansForTab(tabId);
  } catch (error) {
    console.error("[scan-alarm:clear]", { tabId, error });
  }
}

async function bestEffortBadge(
  tabId: number,
  monitor?: TabMonitor
): Promise<void> {
  try {
    await applyBadge(tabId, monitor);
  } catch {
    // applyBadge retains the useful structured error log.
  }
}

async function persistState(): Promise<void> {
  await api("Persist monitor state", writeState(state));
}

async function persistNotificationHistoryEntry(
  entry: NotificationHistoryEntry
): Promise<void> {
  const latest = await api(
    "Read state before notification history write",
    readState()
  );
  latest.notificationHistory = addNotificationHistory(
    latest.notificationHistory,
    entry
  );
  state = latest;
  await api("Persist notification history", writeState(state));
}

async function saveMonitorRecord(
  monitor: TabMonitor,
  allowCreate: boolean
): Promise<void> {
  const latest = await api("Read state before monitor write", readState());
  const existing = getMonitor(latest, monitor.tabId);
  if (
    !allowCreate &&
    (!existing || existing.tabInstanceId !== monitor.tabInstanceId)
  ) {
    state = latest;
    throw new Error(
      "The monitor changed or was reset while this operation was in progress."
    );
  }
  state = latest;
  state.monitors[monitorKey(monitor.tabId)] = monitor;
  await persistState();
}

async function repairSupersededMonitor(
  expected: TabMonitor
): Promise<boolean> {
  const latest = await api(
    "Verify monitor identity after alarm operation",
    readState()
  );
  const current = getMonitor(latest, expected.tabId);
  if (current?.tabInstanceId === expected.tabInstanceId) return false;

  state = latest;
  if (
    current?.status === "running" &&
    current.nextReloadAt !== null &&
    Number.isFinite(current.nextReloadAt)
  ) {
    await scheduleReload(current.tabId, current.nextReloadAt);
    await bestEffortBadge(current.tabId, current);
  } else {
    await bestEffortClearReload(expected.tabId);
    await bestEffortBadge(expected.tabId, current);
  }
  return true;
}

async function persistMonitor(
  monitor: TabMonitor,
  allowCreate = false
): Promise<TabMonitor> {
  await saveMonitorRecord(monitor, allowCreate);

  if (monitor.status === "running" && monitor.nextReloadAt !== null) {
    try {
      await scheduleReload(monitor.tabId, monitor.nextReloadAt);
      if (await repairSupersededMonitor(monitor)) {
        throw new Error(
          "The monitor changed or was reset while its alarm was being scheduled."
        );
      }
      await bestEffortBadge(monitor.tabId, monitor);
      return monitor;
    } catch (error) {
      console.error("[alarm:create]", {
        tabId: monitor.tabId,
        nextReloadAt: monitor.nextReloadAt,
        error
      });
      const failed = errorMonitor(
        monitor,
        `Reload scheduling failed: ${errorMessage(error)}`,
        Date.now()
      );
      await saveMonitorRecord(failed, false);
      await bestEffortClearReload(failed.tabId);
      await bestEffortBadge(failed.tabId, failed);
      return failed;
    }
  }

  try {
    await clearReload(monitor.tabId);
    if (await repairSupersededMonitor(monitor)) {
      throw new Error(
        "The monitor changed while its old alarm was being canceled."
      );
    }
  } catch (error) {
    console.error("[alarm:clear]", { tabId: monitor.tabId, error });
    const failed = errorMonitor(
      monitor,
      `The old reload alarm could not be canceled: ${errorMessage(error)}`,
      Date.now()
    );
    await saveMonitorRecord(failed, false);
    await bestEffortBadge(failed.tabId, failed);
    return failed;
  }

  await bestEffortBadge(monitor.tabId, monitor);
  return monitor;
}

async function persistMonitorStateOnly(
  monitor: TabMonitor
): Promise<TabMonitor> {
  await saveMonitorRecord(monitor, false);
  return monitor;
}

async function resetMonitor(tabId: number): Promise<void> {
  const latest = await api("Read state before monitor reset", readState());
  delete latest.monitors[monitorKey(tabId)];
  state = latest;
  await api("Persist monitor reset", writeState(state));

  const results = await Promise.allSettled([
    clearReload(tabId),
    clearScansForTab(tabId),
    clearHighlights(tabId),
    removeSessionToken(tabId),
    applyBadge(tabId)
  ]);
  const failure = results.find(
    (result): result is PromiseRejectedResult =>
      result.status === "rejected"
  );
  if (failure) {
    console.error("[monitor:reset]", { tabId, error: failure.reason });
    throw new Error(
      `The monitor was removed, but cleanup was incomplete: ${errorMessage(failure.reason)}`
    );
  }
  console.info("[monitor:reset]", { tabId, result: "cleared" });
}

async function resetAllMonitors(): Promise<void> {
  const [latest, alarms] = await Promise.all([
    api("Read state before full reset", readState()),
    api("Read alarms before full reset", chrome.alarms.getAll())
  ]);
  const monitorTabIds = Object.values(latest.monitors)
    .filter(isPlausibleMonitor)
    .map((monitor) => monitor.tabId);
  const alarmTabIds = alarms
    .map(
      (alarm) =>
        tabIdFromAlarm(alarm.name) ??
        scanIdentityFromAlarm(alarm.name)?.tabId ??
        null
    )
    .filter((tabId): tabId is number => tabId !== null);
  const tabIds = [...new Set([...monitorTabIds, ...alarmTabIds])];

  state = {
    version: 5,
    monitors: {},
    notificationHistory: latest.notificationHistory,
    quickTriggers: latest.quickTriggers
  };
  await api("Persist full monitor reset", writeState(state));

  const cleanup = await Promise.allSettled(
    tabIds.flatMap((tabId) => [
      clearReload(tabId),
      clearScansForTab(tabId),
      clearHighlights(tabId),
      removeSessionToken(tabId),
      applyBadge(tabId)
    ])
  );
  const failures = cleanup.filter(
    (result): result is PromiseRejectedResult =>
      result.status === "rejected"
  );
  if (failures.length > 0) {
    console.error("[monitor:reset-all]", {
      failureCount: failures.length,
      errors: failures.map((failure) => errorMessage(failure.reason))
    });
    throw new Error(
      `Saved monitors were removed, but ${failures.length} cleanup operation(s) failed.`
    );
  }
  console.info("[monitor:reset-all]", {
    result: "cleared",
    tabCount: tabIds.length
  });
}

function alarmDiagnostic(
  alarm: chrome.alarms.Alarm | undefined
): AlarmDiagnostic | null {
  if (!alarm) return null;
  return {
    name: alarm.name,
    scheduledTime: alarm.scheduledTime,
    periodInMinutes: alarm.periodInMinutes ?? null
  };
}

async function buildDiagnostics(
  tabId: number | null
): Promise<DiagnosticSnapshot> {
  const [stateResult, alarmsResult, tabResult] = await Promise.allSettled([
    api("Read diagnostic monitor state", readState()),
    api("Read diagnostic alarms", chrome.alarms.getAll()),
    tabId === null
      ? Promise.resolve(null)
      : api(`Read diagnostic tab ${tabId}`, chrome.tabs.get(tabId))
  ]);

  const storedState =
    stateResult.status === "fulfilled"
      ? stateResult.value
      : {
          version: 5 as const,
          monitors: {},
          notificationHistory: [],
          quickTriggers: []
        };
  const alarms =
    alarmsResult.status === "fulfilled" ? alarmsResult.value : [];
  const storedMonitor =
    tabId === null ? undefined : getMonitor(storedState, tabId);
  const memoryMonitor =
    tabId === null ? undefined : getMonitor(state, tabId);
  const matchingAlarm =
    tabId === null
      ? undefined
      : alarms.find((alarm) => alarm.name === alarmName(tabId));
  const matchingScanAlarms =
    tabId === null
      ? []
      : alarms.filter(
          (alarm) => scanIdentityFromAlarm(alarm.name)?.tabId === tabId
        );
  const notes: string[] = [];

  if (stateResult.status === "rejected") {
    notes.push(`Storage read failed: ${errorMessage(stateResult.reason)}`);
  }
  if (alarmsResult.status === "rejected") {
    notes.push(`Alarm query failed: ${errorMessage(alarmsResult.reason)}`);
  }
  if (tabResult.status === "rejected") {
    notes.push(`Tab lookup failed: ${errorMessage(tabResult.reason)}`);
  }
  if (storedMonitor?.status === "running" && !matchingAlarm) {
    notes.push("Running monitor has no matching Chromium alarm.");
  }
  if (
    storedMonitor?.status === "running" &&
    storedMonitor.nextReloadAt !== null &&
    matchingAlarm &&
    Math.abs(matchingAlarm.scheduledTime - storedMonitor.nextReloadAt) > 1_500
  ) {
    notes.push("Running monitor alarm does not match nextReloadAt.");
  }
  if (
    storedMonitor?.status === "running" &&
    (storedMonitor.nextReloadAt === null ||
      !Number.isFinite(storedMonitor.nextReloadAt))
  ) {
    notes.push("Running monitor has an invalid nextReloadAt timestamp.");
  }
  if (
    storedMonitor?.status === "running" &&
    storedMonitor.nextReloadAt !== null &&
    storedMonitor.nextReloadAt <= Date.now()
  ) {
    notes.push("Running monitor deadline is overdue.");
  }

  return {
    generatedAt: Date.now(),
    initializationStatus,
    initializationError,
    requestedTabId: tabId,
    requestedTabExists:
      tabId === null
        ? null
        : tabResult.status === "fulfilled" && tabResult.value !== null,
    storedMonitor: storedMonitor ?? null,
    memoryMonitor: memoryMonitor ?? null,
    matchingAlarm: alarmDiagnostic(matchingAlarm),
    matchingScanAlarms: matchingScanAlarms
      .map(alarmDiagnostic)
      .filter((alarm): alarm is AlarmDiagnostic => alarm !== null),
    monitorTabIds: Object.values(storedState.monitors)
      .filter(isPlausibleMonitor)
      .map((monitor) => monitor.tabId),
    alarmNames: alarms.map((alarm) => alarm.name),
    notes
  };
}

async function recoverState(): Promise<void> {
  console.info("[background:startup]", { phase: "begin" });
  initializationStatus = "starting";
  initializationError = null;

  const saved = await api("Read saved monitor state", readState());
  await clearGlobalBadgeDefault();
  const [tabs, alarms] = await Promise.all([
    api("Query tabs for monitor recovery", chrome.tabs.query({})),
    api("Query alarms for monitor recovery", chrome.alarms.getAll())
  ]);

  let sessionValues: Record<string, unknown> = {};
  try {
    sessionValues = await api(
      "Read tab identity session state",
      chrome.storage.session.get(null)
    );
  } catch (error) {
    console.warn("[monitor:restore] Session identity state unavailable.", error);
  }

  const alarmTabIds = alarms
    .map((alarm) => tabIdFromAlarm(alarm.name))
    .filter((tabId): tabId is number => tabId !== null);
  const staleScanAlarms = alarms
    .map((alarm) => ({
      alarm,
      identity: scanIdentityFromAlarm(alarm.name)
    }))
    .filter(
      (
        item
      ): item is {
        alarm: chrome.alarms.Alarm;
        identity: { tabId: number; generation: number };
      } => item.identity !== null
    );
  const recovery = planRecovery(
    Object.values(saved.monitors),
    tabs
      .filter(
        (tab): tab is chrome.tabs.Tab & { id: number } =>
          tab.id !== undefined
      )
      .map((tab) => ({ id: tab.id, url: tab.url ?? "" })),
    alarmTabIds
  );

  const now = Date.now();
  const recovered: Record<string, TabMonitor> = {};
  const removedTabIds = new Set(recovery.removeTabIds);

  for (const candidate of recovery.keep) {
    const tab = await getTabIfPresent(candidate.tabId);
    if (!tab) {
      removedTabIds.add(candidate.tabId);
      continue;
    }

    const sessionToken = sessionValues[
      `${SESSION_TOKEN_PREFIX}${candidate.tabId}`
    ] as string | undefined;
    const tokenMismatch =
      sessionToken !== undefined &&
      sessionToken !== candidate.tabInstanceId;
    const restartUrlMismatch =
      sessionToken === undefined &&
      tab.url !== undefined &&
      tab.url !== candidate.pageUrl;
    if (tokenMismatch || restartUrlMismatch) {
      console.warn("[monitor:restore]", {
        tabId: candidate.tabId,
        action: "remove-stale-identity",
        tokenMismatch,
        restartUrlMismatch
      });
      removedTabIds.add(candidate.tabId);
      continue;
    }

    let monitor: TabMonitor = {
      ...candidate,
      pageTitle: tab.title ?? candidate.pageTitle,
      pageUrl: tab.url ?? candidate.pageUrl,
      keywordRuntime: {
        ...candidate.keywordRuntime,
        pendingScan: null,
        lastScanStatus:
          candidate.status === "running" &&
          candidate.keywordMonitoring.enabled &&
          ["waiting-for-delay", "scanning", "retrying"].includes(
            candidate.keywordRuntime.lastScanStatus
          )
            ? "waiting-for-load"
            : candidate.keywordRuntime.lastScanStatus
      },
      updatedAt: now
    };
    const support = inspectUrl(monitor.pageUrl);
    if (!support.supported) {
      monitor = errorMonitor(
        monitor,
        support.reason ?? "This page cannot be monitored.",
        now
      );
    } else if (
      monitor.status === "running" &&
      (monitor.nextReloadAt === null ||
        !Number.isFinite(monitor.nextReloadAt))
    ) {
      monitor = errorMonitor(
        monitor,
        "The saved reload deadline was invalid and could not be restored.",
        now
      );
    } else if (
      monitor.status === "running" &&
      monitor.nextReloadAt !== null &&
      monitor.nextReloadAt <= now
    ) {
      monitor = {
        ...monitor,
        nextReloadAt: now + RECOVERY_RELOAD_DELAY_MS,
        updatedAt: now
      };
      console.info("[monitor:restore]", {
        tabId: monitor.tabId,
        action: "schedule-overdue-near-immediate",
        nextReloadAt: monitor.nextReloadAt
      });
    }

    recovered[monitorKey(monitor.tabId)] = monitor;
    if (!sessionToken) {
      try {
        await setSessionToken(monitor.tabId, monitor.tabInstanceId);
      } catch (error) {
        console.warn("[monitor:restore] Could not restore tab identity token.", {
          tabId: monitor.tabId,
          error
        });
      }
    }
  }

  state = {
    version: 5,
    monitors: recovered,
    notificationHistory: saved.notificationHistory,
    quickTriggers: saved.quickTriggers
  };
  await persistState();

  const alarmsByName = new Map(alarms.map((alarm) => [alarm.name, alarm]));
  for (const monitor of Object.values(recovered)) {
    if (monitor.status === "running" && monitor.nextReloadAt !== null) {
      const existing = alarmsByName.get(alarmName(monitor.tabId));
      const alarmMatches =
        existing !== undefined &&
        Math.abs(existing.scheduledTime - monitor.nextReloadAt) <= 1_500;
      if (!alarmMatches) {
        try {
          await scheduleReload(monitor.tabId, monitor.nextReloadAt);
          console.info("[alarm:create]", {
            tabId: monitor.tabId,
            reason: existing ? "replace-mismatched" : "restore-missing",
            nextReloadAt: monitor.nextReloadAt
          });
        } catch (error) {
          const failed = errorMonitor(
            monitor,
            `Reload scheduling failed during recovery: ${errorMessage(error)}`,
            Date.now()
          );
          recovered[monitorKey(failed.tabId)] = failed;
          console.error("[alarm:create]", {
            tabId: monitor.tabId,
            phase: "recovery",
            error
          });
          await bestEffortClearReload(failed.tabId);
        }
      }
    } else {
      await bestEffortClearReload(monitor.tabId);
    }
  }

  state = {
    version: 5,
    monitors: recovered,
    notificationHistory: saved.notificationHistory,
    quickTriggers: saved.quickTriggers
  };
  await persistState();

  const activeRunningIds = new Set(
    Object.values(recovered)
      .filter(
        (monitor) =>
          monitor.status === "running" && monitor.nextReloadAt !== null
      )
      .map((monitor) => monitor.tabId)
  );
  for (const tabId of alarmTabIds) {
    if (!activeRunningIds.has(tabId)) await bestEffortClearReload(tabId);
  }
  for (const { identity } of staleScanAlarms) {
    try {
      await clearScan(identity.tabId, identity.generation);
    } catch (error) {
      console.warn("[monitor:restore] Could not remove stale scan alarm.", {
        ...identity,
        error
      });
    }
  }
  for (const tabId of removedTabIds) {
    await bestEffortClearReload(tabId);
    await bestEffortBadge(tabId);
    try {
      await removeSessionToken(tabId);
    } catch (error) {
      console.warn("[monitor:restore] Could not remove stale tab token.", {
        tabId,
        error
      });
    }
  }
  for (const monitor of Object.values(recovered)) {
    await bestEffortBadge(monitor.tabId, monitor);
  }
  for (const tab of tabs) {
    if (
      tab.id !== undefined &&
      recovered[monitorKey(tab.id)] === undefined
    ) {
      await bestEffortBadge(tab.id);
    }
  }

  try {
    await ensureBadgeAlarm();
  } catch (error) {
    console.error("[badge:update] Badge refresh alarm unavailable.", error);
  }
  await updateActiveBadge();

  initializationStatus = "ready";
  console.info("[background:startup]", {
    phase: "ready",
    restoredMonitors: Object.keys(recovered).length,
    removedMonitors: removedTabIds.size
  });
}

const initialized = recoverState().catch((error: unknown) => {
  initializationStatus = "error";
  initializationError = errorMessage(error);
  console.error("[background:startup]", {
    phase: "error",
    error
  });
});

async function ensureInitialized(): Promise<void> {
  await withTimeout(
    initialized,
    "Background service-worker startup",
    CHROME_API_TIMEOUT_MS
  );
}

async function ensureRunningSchedule(
  monitor: TabMonitor
): Promise<TabMonitor> {
  if (monitor.status !== "running") return monitor;
  const now = Date.now();
  if (
    monitor.nextReloadAt === null ||
    !Number.isFinite(monitor.nextReloadAt)
  ) {
    return persistMonitor(
      errorMonitor(
        monitor,
        "The reload deadline is invalid. Start a new run to continue.",
        now
      )
    );
  }

  let current = monitor as TabMonitor & { nextReloadAt: number };
  if (current.nextReloadAt <= now) {
    current = {
      ...current,
      nextReloadAt: now + RECOVERY_RELOAD_DELAY_MS,
      updatedAt: now
    };
  }

  const existing = await api(
    `Read reload alarm for tab ${current.tabId}`,
    chrome.alarms.get(alarmName(current.tabId))
  );
  if (
    !existing ||
    Math.abs(existing.scheduledTime - current.nextReloadAt) > 1_500
  ) {
    console.info("[alarm:create]", {
      tabId: current.tabId,
      reason: existing ? "repair-mismatched" : "repair-missing",
      nextReloadAt: current.nextReloadAt
    });
    return persistMonitor(current);
  }
  await bestEffortBadge(current.tabId, current);
  return current;
}

async function startMonitor(
  tabId: number,
  settings: MonitorSettings,
  keywordMonitoring: KeywordMonitoringConfig
): Promise<TabMonitor> {
  const settingsError = validateSettings(settings);
  if (settingsError) throw new Error(settingsError);
  const normalizedKeywordMonitoring: KeywordMonitoringConfig = {
    ...keywordMonitoring,
    keywords: normalizeKeywordRules(keywordMonitoring.keywords)
  };
  const keywordError = validateKeywordConfig(normalizedKeywordMonitoring);
  if (keywordError) throw new Error(keywordError);
  const monitorDelayError = validateMonitorDelayForReload(
    settings.intervalMs,
    normalizedKeywordMonitoring.scanDelayMs,
    normalizedKeywordMonitoring.enabled
  );
  if (monitorDelayError) throw new Error(monitorDelayError);

  const tab = await getTab(tabId);
  const summary = toTabSummary(tab);
  if (!summary) throw new Error("The selected tab is unavailable.");
  const support = inspectUrl(summary.url);
  if (!support.supported) {
    throw new Error(support.reason ?? "This page cannot be monitored.");
  }
  if (!(await permissionGranted(summary.url))) {
    throw new Error("Site access was not granted for this page.");
  }

  const now = Date.now();
  const token = globalThis.crypto.randomUUID();
  let monitor = createRunningMonitor(
    summary,
    settings,
    now,
    token,
    normalizedKeywordMonitoring
  );
  await bestEffortClearScans(tabId);
  bestEffortClearHighlights(tabId);
  await setSessionToken(tabId, token);
  monitor = await persistMonitor(monitor, true);
  if (monitor.status !== "running") return monitor;

  monitor = await prepareContentForMonitor(monitor, "start");
  if (
    monitor.status === "running" &&
    monitor.keywordMonitoring.enabled &&
    tab.status === "complete"
  ) {
    monitor = await scheduleKeywordScanAfterLoad(
      monitor,
      summary.url,
      Date.now()
    );
  }
  return monitor;
}

async function persistScanError(
  monitor: TabMonitor,
  error: TypedMonitorError
): Promise<TabMonitor> {
  console.error("[keyword:scan]", {
    tabId: monitor.tabId,
    code: error.code,
    error: error.message
  });
  return persistMonitorStateOnly({
    ...monitor,
    keywordRuntime: {
      ...monitor.keywordRuntime,
      pendingScan: null,
      lastScanStatus: "error",
      lastError: error
    },
    updatedAt: error.occurredAt
  });
}

async function scheduleKeywordScanAfterLoad(
  monitor: TabMonitor,
  pageUrl: string,
  now = Date.now()
): Promise<TabMonitor> {
  if (
    monitor.status !== "running" ||
    !monitor.keywordMonitoring.enabled
  ) {
    return monitor;
  }
  const configError = validateKeywordConfig(monitor.keywordMonitoring);
  if (configError) {
    return persistScanError(
      monitor,
      monitorError("INVALID_CONFIGURATION", configError)
    );
  }
  const generation = monitor.keywordRuntime.navigationGeneration;
  if (
    monitor.keywordRuntime.lastCompletedGeneration === generation ||
    monitor.keywordRuntime.pendingScan?.generation === generation
  ) {
    return monitor;
  }

  const name = scanAlarmName(monitor.tabId, generation);
  const scheduledFor = now + monitor.keywordMonitoring.scanDelayMs;
  let waiting: TabMonitor = {
    ...monitor,
    keywordRuntime: {
      ...monitor.keywordRuntime,
      lastCompletedGeneration: generation,
      lastScanStatus: "waiting-for-delay",
      lastError: null,
      pendingScan: {
        generation,
        pageUrl,
        scheduledFor,
        alarmName: name,
        retryNumber: 0,
        reason: "initial-delay"
      }
    },
    updatedAt: now
  };
  waiting = await persistMonitorStateOnly(waiting);

  try {
    const alarm = await scheduleScan(
      waiting.tabId,
      generation,
      scheduledFor,
      now
    );
    waiting = await persistMonitorStateOnly({
      ...waiting,
      keywordRuntime: {
        ...waiting.keywordRuntime,
        pendingScan: {
          generation,
          pageUrl,
          scheduledFor: alarm.scheduledTime,
          alarmName: name,
          retryNumber: 0,
          reason: "initial-delay"
        }
      },
      updatedAt: Date.now()
    });
    console.info("[scan-alarm:create]", {
      tabId: waiting.tabId,
      generation,
      scheduledFor: alarm.scheduledTime
    });
    return waiting;
  } catch (error) {
    return persistScanError(
      waiting,
      monitorError(
        "UNKNOWN",
        `Scan scheduling failed: ${errorMessage(error)}`
      )
    );
  }
}

type DetectionStateLabel = "unknown" | "missing" | "present";

interface DetectionNotificationContent {
  title: string;
  message: string;
}

interface NotificationFlowDetails extends DetectionNotificationContent {
  tabId: number;
  tabInstanceId: string;
  previousState: DetectionStateLabel;
  currentState: DetectionStateLabel;
  detectionMode: KeywordMonitorMode;
  notificationEnabled: boolean;
}

function detectionStateLabel(state: boolean | null): DetectionStateLabel {
  if (state === null) return "unknown";
  return state ? "present" : "missing";
}

function buildDetectionNotificationContent(
  monitor: TabMonitor,
  mode: KeywordMonitorMode,
  pageTitle: string,
  matchedKeywords: MatchedKeyword[]
): DetectionNotificationContent {
  const monitorName = monitor.keywordMonitoring.notificationMessage.trim();
  const title =
    monitorName || (mode === "found" ? "Keyword found" : "Keyword lost");
  const displayPageTitle = pageTitle.trim() || "the monitored page";
  let message: string;
  if (mode === "lost") {
    message = `All monitored phrases disappeared from ${displayPageTitle}`;
  } else if (matchedKeywords.length === 1) {
    message = `“${matchedKeywords[0]!.value}” appeared on ${displayPageTitle}`;
  } else if (matchedKeywords.length > 1) {
    const displayed = matchedKeywords
      .slice(0, MAX_NOTIFICATION_KEYWORDS)
      .map((keyword) => keyword.value);
    const remainder = matchedKeywords.length - displayed.length;
    message = `${matchedKeywords.length} monitored phrases are present on ${displayPageTitle}. Matched: ${displayed.join(", ")}${
      remainder > 0 ? `, +${remainder} more` : ""
    }`;
  } else {
    message = `A monitored phrase appeared on ${displayPageTitle}`;
  }

  return { title, message };
}

async function createDetectionNotification(
  monitor: TabMonitor,
  entry: DetectionHistoryEntry,
  flow: NotificationFlowDetails
): Promise<void> {
  const notificationId =
    `${DETECTION_NOTIFICATION_PREFIX}${entry.tabId}:${entry.id}`;
  console.info("[LuckyFetch] Notification function invoked:", {
    ...flow,
    notificationId
  });

  const title = flow.title.trim();
  const message = flow.message.trim();
  if (!title || !message) {
    const error = new Error(
      "Notification title and message must both be non-empty strings."
    );
    console.error("[LuckyFetch] Notification failed:", {
      ...flow,
      notificationId,
      error: error.message
    });
    throw error;
  }

  const timestamp = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit"
  }).format(entry.detectedAt);
  const options: chrome.notifications.NotificationCreateOptions = {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
    title,
    message,
    contextMessage: `Lucky Fetch • ${timestamp}`
  };
  console.info("[LuckyFetch] Notification options constructed:", {
    ...flow,
    title,
    message,
    notificationId,
    iconUrl: options.iconUrl,
    contextMessage: options.contextMessage
  });

  let targetSaved = false;
  try {
    await saveNotificationTarget(notificationId, {
      tabId: entry.tabId,
      tabInstanceId: monitor.tabInstanceId,
      createdAt: entry.detectedAt
    });
    targetSaved = true;
  } catch (error) {
    // Click-target metadata is secondary; a storage failure must not suppress
    // delivery of the detection notification itself.
    console.warn("[LuckyFetch] Notification target metadata was not saved:", {
      ...flow,
      notificationId,
      error: errorMessage(error)
    });
  }

  try {
    console.info("[LuckyFetch] chrome.notifications.create called:", {
      ...flow,
      title,
      message,
      notificationId
    });
    const createdNotificationId = await new Promise<string>(
      (resolve, reject) => {
        chrome.notifications.create(
          notificationId,
          options,
          (createdId) => {
            const lastError = chrome.runtime.lastError;
            if (lastError) {
              reject(new Error(lastError.message));
              return;
            }
            resolve(createdId);
          }
        );
      }
    );
    console.info("[LuckyFetch] Notification successfully created:", {
      ...flow,
      title,
      message,
      notificationId: createdNotificationId
    });
  } catch (error) {
    console.error("[LuckyFetch] Notification failed:", {
      ...flow,
      title,
      message,
      notificationId,
      error: errorMessage(error)
    });
    try {
      if (targetSaved) await removeNotificationTarget(notificationId);
    } catch {
      // The original notification failure is more useful to the user.
    }
    throw error;
  }
}

interface ResolvedTriggerCandidate extends FrameResolvedMatch {
  frameId: number;
  documentId?: string;
  signature: string;
}

interface ResolvedTriggerMatches {
  candidates: ResolvedTriggerCandidate[];
  truncated: boolean;
  targetFrames: Array<{ frameId: number; documentId?: string; url: string }>;
}

async function bringMonitoredTabToFront(tabId: number): Promise<boolean> {
  console.info("[trigger-action:tab-activation]", {
    tabId,
    stage: "attempted"
  });
  try {
    const tab = await api(
      `Activate monitored tab ${tabId}`,
      chrome.tabs.update(tabId, { active: true })
    );
    if (!tab || tab.windowId === undefined) {
      throw new Error("Chromium did not return the activated tab or window.");
    }
    console.info("[trigger-action:tab-activation]", {
      tabId,
      windowId: tab.windowId,
      stage: "completed"
    });
    console.info("[trigger-action:window-focus]", {
      tabId,
      windowId: tab.windowId,
      stage: "attempted"
    });
    await api(
      `Focus monitored window ${tab.windowId}`,
      chrome.windows.update(tab.windowId, { focused: true })
    );
    console.info("[trigger-action:window-focus]", {
      tabId,
      windowId: tab.windowId,
      stage: "completed"
    });
    return true;
  } catch (error) {
    console.warn("[trigger-action:target-unavailable]", {
      tabId,
      message: "The monitored tab or browser window is no longer available.",
      error: errorMessage(error)
    });
    return false;
  }
}

async function resolveMatchedElements(
  monitor: TabMonitor,
  aggregation: TabFrameAggregation
): Promise<ResolvedTriggerMatches> {
  const frames = await discoverCurrentFrames(monitor.tabId);
  const targets = frames.filter((frame) =>
    aggregation.matchedFrames.some(
      (matched) =>
        matched.frameId === frame.frameId &&
        (!matched.documentId || matched.documentId === frame.documentId)
    )
  );
  const eventToken = globalThis.crypto.randomUUID();
  const candidateGroups = await Promise.all(
    targets.map(async (frame): Promise<{
      frame: (typeof targets)[number];
      matches: FrameResolvedMatch[];
      truncated: boolean;
    }> => {
      try {
        const injections = await api(
          `Resolve detected result in frame ${frame.frameId} of tab ${monitor.tabId}`,
          chrome.scripting.executeScript({
            target: { tabId: monitor.tabId, frameIds: [frame.frameId] },
            func: resolveFrameMatchedElements,
            args: [
              monitor.keywordMonitoring.keywords,
              monitor.keywordMonitoring.caseSensitive,
              frame.url,
              eventToken
            ]
          })
        );
        const result = injections.find(
          (candidate) => candidate.frameId === frame.frameId
        )?.result;
        if (
          !result ||
          !result.ok ||
          result.pageUrl !== frame.url ||
          !Array.isArray(result.matches)
        ) {
          console.warn("[trigger-action:frame-unavailable]", {
            tabId: monitor.tabId,
            frameId: frame.frameId,
            reason: result?.error ?? "invalid-result-resolution-response"
          });
          return { frame, matches: [], truncated: false };
        }
        console.info("[trigger-action:matched-element]", {
          tabId: monitor.tabId,
          frameId: frame.frameId,
          matchCount: result.matches.length
        });
        return {
          frame,
          matches: result.matches,
          truncated: result.truncated
        };
      } catch (error) {
        console.warn("[trigger-action:frame-unavailable]", {
          tabId: monitor.tabId,
          frameId: frame.frameId,
          error: errorMessage(error)
        });
        return { frame, matches: [], truncated: false };
      }
    })
  );
  const candidates = candidateGroups.flatMap(({ frame, matches }) =>
    matches.map((match): ResolvedTriggerCandidate => ({
      ...match,
      frameId: frame.frameId,
      ...(frame.documentId ? { documentId: frame.documentId } : {}),
      signature: buildResultSignature({
        keywordId: match.keywordId,
        tabId: monitor.tabId,
        pageUrl: monitor.pageUrl,
        frameId: frame.frameId,
        frameUrl: match.frameUrl,
        matchedText: match.matchedText,
        resultIdentifierHash: match.resultIdentifierHash,
        rowTextHash: match.rowTextHash,
        linkUrl: match.linkUrl
      })
    }))
  );
  return {
    candidates,
    truncated: candidateGroups.some((group) => group.truncated),
    targetFrames: targets
  };
}

async function cleanupResolvedMatches(
  tabId: number,
  frames: ReadonlyArray<{ frameId: number }>
): Promise<void> {
  await Promise.allSettled(
    frames.map((frame) =>
      chrome.scripting.executeScript({
        target: { tabId, frameIds: [frame.frameId] },
        func: clearResolvedMatchTokens
      })
    )
  );
}

interface TriggerActionRuntimeUpdate {
  lastActionResultSignature: string | null;
  lastFocusAt: number | null;
  lastClickAt: number | null;
}

async function performMonitorTriggerActions(
  monitor: TabMonitor,
  kind: TriggerTransitionKind,
  aggregation: TabFrameAggregation,
  occurredAt: number
): Promise<TriggerActionRuntimeUpdate> {
  const runtime: TriggerActionRuntimeUpdate = {
    lastActionResultSignature:
      monitor.keywordRuntime.lastActionResultSignature,
    lastFocusAt: monitor.keywordRuntime.lastFocusAt,
    lastClickAt: monitor.keywordRuntime.lastClickAt
  };
  const autoMode = monitor.keywordMonitoring.autoOpenResult;
  const autoEnabled = kind === "found" && autoMode !== "off";
  const focusRequested =
    focusModeIncludesTransition(monitor.keywordMonitoring.bringToFront, kind) ||
    (autoEnabled && autoOpenNeedsFocus(autoMode));
  let resolved: ResolvedTriggerMatches | null = null;
  let selected: ResolvedTriggerCandidate | null = null;

  console.info("[trigger-action:transition]", {
    tabId: monitor.tabId,
    transition: kind,
    focusRequested,
    autoOpenMode: autoMode
  });

  try {
    if (autoEnabled) {
      resolved = await resolveMatchedElements(monitor, aggregation);
      const selection = resolved.truncated
        ? { selected: null, reason: "ambiguous" as const }
        : selectUnambiguousResult(
            resolved.candidates,
            runtime.lastActionResultSignature
          );
      selected = selection.selected;
      if (!selected) {
        const reason = selection.reason;
        console.info("[trigger-action:click-skipped]", {
          tabId: monitor.tabId,
          reason:
            reason === "ambiguous"
              ? "ambiguous-results"
              : reason === "duplicate"
                ? "duplicate-result-signature"
                : "no-matched-dom-element",
          candidateCount: resolved.candidates.length
        });
      } else {
        console.info("[trigger-action:clickable-resolution]", {
          tabId: monitor.tabId,
          frameId: selected.frameId,
          resolved: selected.clickable,
          skipReason: selected.clickSkipReason
        });
      }
    }

    if (focusRequested) {
      if (focusCooldownActive(runtime.lastFocusAt, occurredAt)) {
        console.info("[trigger-action:duplicate-prevented]", {
          tabId: monitor.tabId,
          action: "focus",
          reason: "cooldown",
          lastFocusAt: runtime.lastFocusAt
        });
      } else if (await bringMonitoredTabToFront(monitor.tabId)) {
        runtime.lastFocusAt = occurredAt;
        await new Promise<void>((resolve) => setTimeout(resolve, 75));
      }
    }

    if (autoEnabled && selected) {
      const clickRequested = autoOpenNeedsClick(autoMode);
      if (clickRequested && !selected.clickable) {
        console.info("[trigger-action:click-skipped]", {
          tabId: monitor.tabId,
          frameId: selected.frameId,
          reason:
            selected.clickSkipReason === "unsafe-target"
              ? "unsafe-clickable-target"
              : "no-safe-clickable-target"
        });
      }
      try {
        const injections = await api(
          `Scroll to detected result in frame ${selected.frameId}`,
          chrome.scripting.executeScript({
            target: {
              tabId: monitor.tabId,
              frameIds: [selected.frameId]
            },
            func: performFrameTriggerAction,
            args: [
              selected.frameUrl,
              selected.matchToken,
              selected.clickableToken,
              clickRequested && selected.clickable
            ]
          })
        );
        const result = injections.find(
          (candidate) => candidate.frameId === selected!.frameId
        )?.result;
        if (result?.scrolled && result.highlighted) {
          runtime.lastActionResultSignature = selected.signature;
          console.info("[trigger-action:scroll-highlight]", {
            tabId: monitor.tabId,
            frameId: selected.frameId,
            completed: true
          });
        }
        if (result?.clicked) {
          runtime.lastClickAt = occurredAt;
          console.info("[trigger-action:click]", {
            tabId: monitor.tabId,
            frameId: selected.frameId,
            completed: true
          });
        } else if (clickRequested && selected.clickable) {
          console.info("[trigger-action:click-skipped]", {
            tabId: monitor.tabId,
            frameId: selected.frameId,
            reason: result?.reason ?? "action-target-unavailable"
          });
        }
      } catch (error) {
        console.warn("[trigger-action:frame-unavailable]", {
          tabId: monitor.tabId,
          frameId: selected.frameId,
          message: "The matched frame is no longer available.",
          error: errorMessage(error)
        });
      }
    }
  } finally {
    if (resolved) {
      await cleanupResolvedMatches(monitor.tabId, resolved.targetFrames);
    }
  }
  return runtime;
}

async function scanLoadedPage(
  tabId: number,
  generation: number
): Promise<TabMonitor | null> {
  const scanEpoch = currentScanEpoch(tabId);
  state = await api("Read latest state before keyword scan", readState());
  const monitor = getMonitor(state, tabId);
  if (!monitor) {
    await bestEffortClearScans(tabId);
    return null;
  }
  const pending = monitor.keywordRuntime.pendingScan;
  if (
    monitor.status !== "running" ||
    !monitor.keywordMonitoring.enabled ||
    monitor.keywordRuntime.navigationGeneration !== generation ||
    !pending ||
    pending.generation !== generation ||
    pending.alarmName !== scanAlarmName(tabId, generation)
  ) {
    return monitor;
  }
  const retryNumber = pending.retryNumber;

  const tab = await getTabIfPresent(tabId);
  if (!tab) {
    await resetMonitor(tabId);
    return null;
  }
  if ((tab.url ?? "") !== pending.pageUrl) {
    console.info("[keyword:scan]", {
      tabId,
      generation,
      result: "discard-stale-url"
    });
    return persistMonitorStateOnly({
      ...monitor,
      pageTitle: tab.title ?? monitor.pageTitle,
      pageUrl: tab.url ?? monitor.pageUrl,
      keywordRuntime: {
        ...monitor.keywordRuntime,
        pendingScan: null,
        lastScanStatus: "waiting-for-load"
      },
      updatedAt: Date.now()
    });
  }

  if (tab.status && tab.status !== "complete") {
    console.info("[scan:deferred]", {
      tabId,
      generation,
      retryNumber,
      reason: "tab-not-complete",
      tabStatus: tab.status,
      navigationStartedAt: monitor.keywordRuntime.navigationStartedAt
    });
    return persistMonitorStateOnly({
      ...monitor,
      keywordRuntime: {
        ...monitor.keywordRuntime,
        pendingScan: null,
        lastScanStatus: "waiting-for-load"
      },
      updatedAt: Date.now()
    });
  }

  const readiness = await ensureContentScriptReady(tabId);
  if (!readiness.ok) {
    return persistScanError(monitor, readiness.error);
  }

  const scanning = await persistMonitorStateOnly({
    ...monitor,
    keywordRuntime: {
      ...monitor.keywordRuntime,
      pendingScan: null,
      lastScanStatus: "scanning",
      lastError: null
    },
    updatedAt: Date.now()
  });
  let aggregation: TabFrameAggregation;
  try {
    aggregation = await scanCurrentFrames(
      tabId,
      generation,
      scanning.keywordMonitoring.keywords,
      scanning.keywordMonitoring.caseSensitive,
      retryNumber,
      scanning.keywordRuntime.navigationStartedAt
    );
  } catch (error) {
    return persistScanError(scanning, scanErrorFrom(error));
  }

  const tabAfterScan = await getTabIfPresent(tabId);
  if (!tabAfterScan) {
    await resetMonitor(tabId);
    return null;
  }
  if ((tabAfterScan.url ?? "") !== pending.pageUrl) {
    return persistMonitorStateOnly({
      ...scanning,
      pageTitle: tabAfterScan.title ?? scanning.pageTitle,
      pageUrl: tabAfterScan.url ?? scanning.pageUrl,
      keywordRuntime: {
        ...scanning.keywordRuntime,
        lastScanStatus: "waiting-for-load"
      },
      updatedAt: Date.now()
    });
  }

  state = await api("Recheck state after keyword scan", readState());
  const current = getMonitor(state, tabId);
  if (
    !current ||
    current.tabInstanceId !== scanning.tabInstanceId ||
    current.status !== "running" ||
    !current.keywordMonitoring.enabled ||
    current.keywordRuntime.navigationGeneration !== generation ||
    currentScanEpoch(tabId) !== scanEpoch
  ) {
    console.info("[scan:discard-stale]", {
      tabId,
      generation,
      retryNumber,
      scanEpoch,
      currentEpoch: currentScanEpoch(tabId),
      reason: "newer-scan-cycle"
    });
    return current ?? null;
  }

  const scanProgress = {
    generation,
    retryNumber,
    totalDiscoveredFrameCount: aggregation.totalDiscoveredFrameCount,
    scannedFrameCount: aggregation.scannedFrameCount,
    pendingFrameCount: aggregation.pendingFrameCount,
    restrictedFrameCount: aggregation.restrictedFrameCount,
    matchedFrameIds: aggregation.matchedFrameIds,
    conclusive: aggregation.conclusive
  };

  if (!aggregation.conclusive) {
    const retryDelay = INCOMPLETE_SCAN_RETRY_DELAYS_MS[retryNumber];
    const willRetry =
      aggregation.pendingFrameCount > 0 && retryDelay !== undefined;
    const finalReason = aggregation.pendingFrameCount === 0
      ? "no-scannable-frames"
      : "retry-budget-exhausted";
    const partialError = monitorError(
      "FRAME_SCAN_PARTIAL",
      `Scan incomplete — ${aggregation.scannedFrameCount} frame${
        aggregation.scannedFrameCount === 1 ? "" : "s"
      } checked, ${aggregation.pendingFrameCount} still loading${
        aggregation.restrictedFrameCount > 0
          ? `, ${aggregation.restrictedFrameCount} restricted`
          : ""
      }.${willRetry
        ? " Retrying…"
        : aggregation.pendingFrameCount === 0
          ? " No scannable frames were available."
          : " Retry limit reached."}`,
      true,
      aggregation.scannedAt,
      `Frame aggregation was incomplete for tab ${tabId}, generation ${generation}, retry ${retryNumber}.`
    );
    let partial = await persistMonitorStateOnly({
      ...current,
      pageTitle: tabAfterScan.title ?? current.pageTitle,
      pageUrl: tabAfterScan.url ?? current.pageUrl,
      keywordRuntime: {
        ...current.keywordRuntime,
        lastScanAt: aggregation.scannedAt,
        lastScanStatus: willRetry ? "retrying" : "incomplete",
        lastError: partialError,
        lastScannedGeneration: generation,
        scanProgress,
        pendingScan: willRetry
          ? {
              generation,
              pageUrl: pending.pageUrl,
              scheduledFor: Date.now() + retryDelay,
              alarmName: scanAlarmName(tabId, generation),
              retryNumber: retryNumber + 1,
              reason: "partial-scan-retry"
            }
          : null
      },
      updatedAt: aggregation.scannedAt
    });
    const scanLog = {
      tabId,
      generation,
      navigationStartedAt: current.keywordRuntime.navigationStartedAt,
      retryNumber,
      reason: willRetry ? "pending-frames" : finalReason,
      totalDiscoveredFrames: aggregation.totalDiscoveredFrameCount,
      successfullyScannedFrames: aggregation.scannedFrameCount,
      pendingFrames: aggregation.pendingFrameCount,
      restrictedFrames: aggregation.restrictedFrameCount,
      matchedFrameIds: aggregation.matchedFrameIds,
      conclusive: false,
      willRetry,
      retryDelayMs: retryDelay ?? null,
      notification: "suppressed-inconclusive"
    };
    if (willRetry) {
      console.info("[scan:retry]", scanLog);
    } else {
      console.info("[scan:finalize]", scanLog);
    }
    if (!willRetry) return partial;
    try {
      const alarm = await scheduleScan(
        tabId,
        generation,
        partial.keywordRuntime.pendingScan!.scheduledFor,
        Date.now()
      );
      partial = await persistMonitorStateOnly({
        ...partial,
        keywordRuntime: {
          ...partial.keywordRuntime,
          pendingScan: {
            ...partial.keywordRuntime.pendingScan!,
            scheduledFor: alarm.scheduledTime
          }
        },
        updatedAt: Date.now()
      });
      return partial;
    } catch (error) {
      return persistScanError(partial, scanErrorFrom(error));
    }
  }

  // A positive match is conclusive immediately. A negative is conclusive once
  // every scannable frame finished; terminal restricted frames are excluded
  // from that scope. Clearing also removes stale alarms from earlier cycles.
  await bestEffortClearScans(tabId);
  console.info("[scan:finalize]", {
    tabId,
    generation,
    navigationStartedAt: current.keywordRuntime.navigationStartedAt,
    retryNumber,
    pendingFrames: aggregation.pendingFrameCount,
    restrictedFrames: aggregation.restrictedFrameCount,
    successfullyScannedFrames: aggregation.scannedFrameCount,
    totalDiscoveredFrames: aggregation.totalDiscoveredFrameCount,
    matchedFrameIds: aggregation.matchedFrameIds,
    matched: aggregation.matched,
    conclusive: true,
    reason: aggregation.matched
      ? "positive-match-confirmed"
      : aggregation.restrictedFrameCount > 0
        ? "all-scannable-frames-complete-restricted-skipped"
        : "all-frames-complete"
  });

  const result: ScanResult = {
    matched: aggregation.matched!,
    scannedAt: aggregation.scannedAt,
    pageTitle: tabAfterScan.title ?? current.pageTitle,
    pageUrl: tabAfterScan.url ?? current.pageUrl,
    textLength: aggregation.textLength,
    matchedKeywords: aggregation.matchedKeywords,
    matchingFrameCount: aggregation.matchingFrameCount
  };
  const transition = evaluateKeywordTransition(
    current.keywordMonitoring.mode,
    current.keywordRuntime.lastMatchState,
    result.matched
  );
  let triggerActionRuntime: TriggerActionRuntimeUpdate = {
    lastActionResultSignature:
      current.keywordRuntime.lastActionResultSignature,
    lastFocusAt: current.keywordRuntime.lastFocusAt,
    lastClickAt: current.keywordRuntime.lastClickAt
  };
  const actualTransition = transitionKind(
    transition.previousState,
    transition.currentState
  );
  if (actualTransition) {
    try {
      triggerActionRuntime = await performMonitorTriggerActions(
        { ...current, pageUrl: result.pageUrl },
        actualTransition,
        aggregation,
        result.scannedAt
      );
    } catch (error) {
      console.warn("[trigger-action:failed]", {
        tabId,
        transition: actualTransition,
        error: errorMessage(error)
      });
    }
  }
  const autoResultHandled =
    triggerActionRuntime.lastActionResultSignature !==
    current.keywordRuntime.lastActionResultSignature;

  let highlightSummary: HighlightSummary = {
    highlightedOccurrenceCount: 0,
    truncated: false,
    errors: [],
    frameResults: []
  };
  if (
    aggregation.matched &&
    current.keywordMonitoring.highlightMatches &&
    !autoResultHandled
  ) {
    try {
      highlightSummary = await applyHighlights(
        tabId,
        aggregation.matchedFrames,
        aggregation.matchedKeywords.map((matched) => {
          const configured = current.keywordMonitoring.keywords.find(
            (keyword) => keyword.id === matched.id
          );
          return configured ?? matched;
        }),
        current.keywordMonitoring.caseSensitive
      );
    } catch (error) {
      highlightSummary.errors.push(highlightErrorFrom(error, 0));
    }
  } else if (!autoResultHandled) {
    bestEffortClearHighlights(tabId);
  }

  if (currentScanEpoch(tabId) !== scanEpoch) {
    console.info("[scan:discard-stale]", {
      tabId,
      generation,
      retryNumber,
      reason: "scan-invalidated-during-post-processing",
      notification: "suppressed-stale"
    });
    return current;
  }

  const stateChanged =
    transition.previousState !== null &&
    transition.previousState !== transition.currentState;
  const firstScan = transition.previousState === null;
  const notificationContent = buildDetectionNotificationContent(
    current,
    current.keywordMonitoring.mode,
    result.pageTitle,
    current.keywordMonitoring.mode === "lost"
      ? current.keywordRuntime.lastMatchedKeywords
      : result.matchedKeywords
  );
  const notificationFlow: NotificationFlowDetails = {
    tabId,
    tabInstanceId: current.tabInstanceId,
    previousState: detectionStateLabel(transition.previousState),
    currentState: detectionStateLabel(transition.currentState),
    detectionMode: current.keywordMonitoring.mode,
    notificationEnabled: current.keywordMonitoring.enabled,
    ...notificationContent
  };
  if (stateChanged) {
    console.info("[LuckyFetch] Detection state changed:", {
      ...notificationFlow,
      generation,
      scanTrigger: "completed-load-alarm"
    });
  }
  console.info("[LuckyFetch] Notification conditions evaluated:", {
    ...notificationFlow,
    generation,
    retryNumber,
    navigationStartedAt: current.keywordRuntime.navigationStartedAt,
    totalDiscoveredFrames: aggregation.totalDiscoveredFrameCount,
    successfullyScannedFrames: aggregation.scannedFrameCount,
    pendingFrames: aggregation.pendingFrameCount,
    restrictedFrames: aggregation.restrictedFrameCount,
    matchedFrameIds: aggregation.matchedFrameIds,
    conclusive: aggregation.conclusive,
    scanTrigger: "completed-load-alarm",
    firstScan,
    stateChanged,
    transitionDetected: transition.detected,
    duplicateSuppressed: !firstScan && !stateChanged,
    cooldownActive: false,
    acknowledgedTriggerState: false,
    tabInstanceValid: true,
    generationValid: true,
    scheduledAndManualReloadsSharePipeline: true,
    staleDetectionTimestamp:
      current.keywordRuntime.lastScanAt !== null &&
      result.scannedAt < current.keywordRuntime.lastScanAt,
    suppressionReason: transition.detected
      ? null
      : stateChanged
        ? "transition-does-not-match-detection-mode"
        : firstScan
          ? "initial-state-does-not-match-detection-mode"
          : "unchanged-state"
  });
  const scanned: TabMonitor = {
    ...current,
    pageTitle: result.pageTitle,
    pageUrl: result.pageUrl,
    keywordRuntime: {
      ...current.keywordRuntime,
      lastMatchState: result.matched,
      lastScanAt: result.scannedAt,
      lastConfirmedAt: result.scannedAt,
      lastScanStatus:
        aggregation.status === "partial" ? "partial" : "complete",
      lastError: null,
      lastMatchedKeywords: result.matched ? result.matchedKeywords : [],
      matchingFrameCount: result.matchingFrameCount,
      highlightedOccurrenceCount:
        highlightSummary.highlightedOccurrenceCount,
      highlightTruncated: highlightSummary.truncated,
      lastHighlightError: highlightSummary.errors[0] ?? null,
      ...triggerActionRuntime,
      lastScannedGeneration: generation,
      scanProgress,
      pendingScan: null
    },
    updatedAt: result.scannedAt
  };

  if (!transition.detected) {
    console.info("[scan:notification]", {
      tabId,
      generation,
      retryNumber,
      emitted: false,
      reason: firstScan ? "baseline" : "state-transition-not-detected"
    });
    return persistMonitorStateOnly(scanned);
  }

  const entry: DetectionHistoryEntry = {
    id: globalThis.crypto.randomUUID(),
    tabId,
    mode: current.keywordMonitoring.mode,
    keyword:
      (current.keywordMonitoring.mode === "lost"
        ? current.keywordRuntime.lastMatchedKeywords
        : result.matchedKeywords
      ).map((keyword) => keyword.value).join(", "),
    matchedKeywords:
      current.keywordMonitoring.mode === "lost"
        ? current.keywordRuntime.lastMatchedKeywords
        : result.matchedKeywords,
    detectedAt: result.scannedAt,
    pageTitle: result.pageTitle,
    pageUrl: result.pageUrl,
    actionApplied: current.keywordMonitoring.actionOnDetection
  };
  let detected = applyDetectionAction(
    {
      ...scanned,
      detectionHistory: addDetectionHistory(
        scanned.detectionHistory,
        entry
      ),
      keywordRuntime: {
        ...scanned.keywordRuntime,
        lastDetectionAt: result.scannedAt
      }
    },
    current.keywordMonitoring.actionOnDetection,
    result.scannedAt
  );

  detected =
    entry.actionApplied === "continue"
      ? await persistMonitorStateOnly(detected)
      : await persistMonitor(detected);
  if (entry.actionApplied !== "continue") {
    await bestEffortClearScans(tabId);
  }
  if (entry.actionApplied === "stop") {
    bestEffortClearHighlights(tabId);
  }

  if (currentScanEpoch(tabId) !== scanEpoch) {
    console.info("[scan:notification]", {
      tabId,
      generation,
      retryNumber,
      emitted: false,
      reason: "scan-invalidated-before-notification"
    });
    return detected;
  }

  try {
    await createDetectionNotification(detected, entry, notificationFlow);
    try {
      await persistNotificationHistoryEntry({
        id: entry.id,
        state: entry.mode,
        keyword: entry.keyword,
        timestamp: entry.detectedAt,
        ...(current.keywordMonitoring.notificationMessage.trim()
          ? {
              triggerLabel:
                current.keywordMonitoring.notificationMessage.trim()
            }
          : {})
      });
    } catch (historyError) {
      console.error("[notification:history]", {
        tabId,
        notificationId: entry.id,
        error: errorMessage(historyError)
      });
    }
    console.info("[scan:notification]", {
      tabId,
      generation,
      retryNumber,
      emitted: true,
      transition: actualTransition
    });
  } catch (error) {
    const notificationError = monitorError(
      "NOTIFICATION_FAILED",
      `Detection was recorded, but the browser notification failed: ${errorMessage(error)}`
    );
    detected = await persistMonitorStateOnly({
      ...detected,
      keywordRuntime: {
        ...detected.keywordRuntime,
        lastError: notificationError
      },
      updatedAt: notificationError.occurredAt
    });
  }
  return detected;
}

async function performReload(
  tabId: number,
  source: "alarm" | "manual"
): Promise<TabMonitor | null> {
  state = await api("Read latest state before reload", readState());
  const monitor = getMonitor(state, tabId);
  if (!monitor) {
    if (source === "manual") {
      await getTab(tabId);
      await api(`Reload tab ${tabId}`, chrome.tabs.reload(tabId));
      return null;
    }
    await bestEffortClearReload(tabId);
    return null;
  }

  const tab = await getTabIfPresent(tabId);
  if (!tab) {
    await resetMonitor(tabId);
    return null;
  }
  const currentUrl = tab.url ?? monitor.pageUrl;
  const support = inspectUrl(currentUrl);
  if (!support.supported) {
    return persistMonitor(
      errorMonitor(
        { ...monitor, pageUrl: currentUrl },
        support.reason ?? "This page cannot be monitored.",
        Date.now()
      )
    );
  }
  if (!(await permissionGranted(currentUrl))) {
    return persistMonitor(
      errorMonitor(
        { ...monitor, pageUrl: currentUrl },
        "Site access is not available for the current destination.",
        Date.now()
      )
    );
  }

  const now = Date.now();
  if (source === "alarm") {
    if (monitor.status !== "running" || monitor.nextReloadAt === null) {
      await bestEffortClearReload(tabId);
      return monitor;
    }
    if (monitor.nextReloadAt > now + 500) {
      await scheduleReload(tabId, monitor.nextReloadAt);
      return monitor;
    }
    if (
      monitor.protectActiveTyping &&
      monitor.typingProtectionUntil !== null &&
      monitor.typingProtectionUntil > now
    ) {
      return persistMonitor({
        ...monitor,
        nextReloadAt: monitor.typingProtectionUntil,
        updatedAt: now
      });
    }
  }

  if (maximumReached(monitor)) {
    return persistMonitor({
      ...monitor,
      status: "completed",
      nextReloadAt: null,
      updatedAt: now
    });
  }

  let reloadMonitor = monitor;
  if (monitor.keywordRuntime.pendingScan) {
    await bestEffortClearScans(tabId);
    reloadMonitor = await persistMonitorStateOnly({
      ...monitor,
      keywordRuntime: {
        ...monitor.keywordRuntime,
        pendingScan: null,
        lastScanStatus: monitor.keywordMonitoring.enabled
          ? "waiting-for-load"
          : monitor.keywordRuntime.lastScanStatus
      },
      updatedAt: now
    });
  }

  try {
    await api(
      `Reload tab ${tabId}`,
      chrome.tabs.reload(tabId, { bypassCache: reloadMonitor.bypassCache })
    );
  } catch (error) {
    console.error("[reload:execute]", { tabId, source, error });
    return persistMonitor(
      errorMonitor(
        reloadMonitor,
        `Reload failed: ${errorMessage(error)}`,
        Date.now()
      )
    );
  }

  const updated =
    source === "manual"
      ? recordManualReload(reloadMonitor, now)
      : recordAcceptedReload(reloadMonitor, now);
  return persistMonitor(updated);
}

async function getCurrentMonitor(
  tabId: number
): Promise<{ tab: TabSummary; monitor: TabMonitor | null }> {
  const tab = await getTab(tabId);
  const summary = toTabSummary(tab);
  if (!summary) throw new Error("The selected tab is unavailable.");

  const latest = await api("Read current monitor state", readState());
  state = latest;
  const saved = getMonitor(latest, tabId);
  if (!saved) {
    await bestEffortBadge(tabId);
    return { tab: summary, monitor: null };
  }
  const monitor = await ensureRunningSchedule(saved);
  return { tab: summary, monitor };
}

async function stopTabActivity(tabId: number): Promise<TabMonitor | null> {
  const latest = await api("Read state before stopping tab activity", readState());
  state = latest;
  const current = getMonitor(state, tabId);
  if (!current) return null;
  const monitor = await persistMonitor({
    ...stopMonitor(current, Date.now()),
    keywordRuntime: {
      ...current.keywordRuntime,
      pendingScan: null,
      lastScanStatus: current.keywordRuntime.pendingScan
        ? "idle"
        : current.keywordRuntime.lastScanStatus
    }
  });
  await bestEffortClearScans(tabId);
  bestEffortClearHighlights(tabId);
  return monitor;
}

async function getActivitySnapshot(): Promise<ActivityEntry[]> {
  const [latest, tabs] = await Promise.all([
    api("Read state for Activity", readState()),
    api("Query tabs for Activity", chrome.tabs.query({}))
  ]);
  state = latest;
  const openTabs = new Map(
    tabs
      .filter(
        (tab): tab is chrome.tabs.Tab & { id: number } =>
          tab.id !== undefined
      )
      .map((tab) => [tab.id, tab])
  );
  const staleTabIds = Object.values(latest.monitors)
    .map((monitor) => monitor.tabId)
    .filter((tabId) => !openTabs.has(tabId));
  for (const tabId of staleTabIds) {
    try {
      await resetMonitor(tabId);
    } catch (error) {
      console.warn("[activity:cleanup] Stale tab cleanup was incomplete.", {
        tabId,
        error
      });
    }
  }
  state = await api("Refresh state after Activity cleanup", readState());
  const monitors = Object.values(state.monitors).map((monitor) => {
    const tab = openTabs.get(monitor.tabId);
    return tab
      ? {
          ...monitor,
          pageTitle: tab.title ?? monitor.pageTitle,
          pageUrl: tab.url ?? monitor.pageUrl
        }
      : monitor;
  });
  return getActiveLuckyFetchTabs(monitors);
}

async function handlePopupRequest(
  request: PopupRequest
): Promise<ExtensionResponse> {
  if (request.type === "activity:get") {
    return {
      ok: true,
      tab: null,
      monitor: null,
      activity: await getActivitySnapshot(),
      quickTriggers: state.quickTriggers
    };
  }
  if (request.type === "activity:open") {
    const tab = await getTabIfPresent(request.tabId);
    if (!tab) {
      try {
        await resetMonitor(request.tabId);
      } catch {
        // The durable record is removed before best-effort browser cleanup.
      }
      return {
        ok: true,
        tab: null,
        monitor: null,
        activity: await getActivitySnapshot(),
        message: "That tab is no longer open; its stale activity was removed."
      };
    }
    await bringMonitoredTabToFront(request.tabId);
    return {
      ok: true,
      tab: toTabSummary(tab),
      monitor: getMonitor(state, request.tabId) ?? null,
      activity: await getActivitySnapshot()
    };
  }
  if (request.type === "activity:stop") {
    await stopTabActivity(request.tabId);
    const tab = await getTabIfPresent(request.tabId);
    return {
      ok: true,
      tab: tab ? toTabSummary(tab) : null,
      monitor: getMonitor(state, request.tabId) ?? null,
      activity: await getActivitySnapshot(),
      message: "Lucky Fetch activity stopped for this tab."
    };
  }
  if (
    request.type === "quick-trigger:save" ||
    request.type === "quick-trigger:remove"
  ) {
    const latest = await api("Read state before Quick Trigger update", readState());
    latest.quickTriggers =
      request.type === "quick-trigger:save"
        ? addQuickTrigger(latest.quickTriggers, request.value)
        : removeQuickTrigger(latest.quickTriggers, request.value);
    state = latest;
    await persistState();
    const tab = await getTabIfPresent(request.tabId);
    return {
      ok: true,
      tab: tab ? toTabSummary(tab) : null,
      monitor: getMonitor(state, request.tabId) ?? null,
      quickTriggers: state.quickTriggers
    };
  }
  if (request.type === "notifications:clear") {
    const latest = await api(
      "Read state before clearing notification history",
      readState()
    );
    latest.notificationHistory = clearNotificationHistory();
    state = latest;
    await persistState();
    const tab = await getTabIfPresent(request.tabId);
    return {
      ok: true,
      tab: tab ? toTabSummary(tab) : null,
      monitor: getMonitor(state, request.tabId) ?? null,
      notificationHistory: state.notificationHistory,
      message: "Notification history cleared."
    };
  }
  if (request.type === "monitor:reset") {
    await resetMonitor(request.tabId);
    const tab = await getTabIfPresent(request.tabId);
    return {
      ok: true,
      tab: tab ? toTabSummary(tab) : null,
      monitor: null,
      message: "Monitor reset."
    };
  }
  if (request.type === "monitor:reset-all") {
    await resetAllMonitors();
    const tab =
      request.tabId === null ? null : await getTabIfPresent(request.tabId);
    return {
      ok: true,
      tab: tab ? toTabSummary(tab) : null,
      monitor: null,
      message: "All saved monitors were reset."
    };
  }
  if (request.type === "monitor:diagnostics") {
    const diagnostics = await buildDiagnostics(request.tabId);
    const tab =
      request.tabId === null ? null : await getTabIfPresent(request.tabId);
    return {
      ok: true,
      tab: tab ? toTabSummary(tab) : null,
      monitor: diagnostics.storedMonitor,
      diagnostics
    };
  }
  if (request.type === "monitor:reconcile") {
    await recoverState();
    const tab =
      request.tabId === null ? null : await getTabIfPresent(request.tabId);
    const diagnostics = await buildDiagnostics(request.tabId);
    return {
      ok: true,
      tab: tab ? toTabSummary(tab) : null,
      monitor: diagnostics.storedMonitor,
      diagnostics,
      message: "Extension state reconciled."
    };
  }

  const tab = await getTab(request.tabId);
  const summary = toTabSummary(tab);

  switch (request.type) {
    case "monitor:get-current": {
      const current = await getCurrentMonitor(request.tabId);
      return {
        ok: true,
        tab: current.tab,
        monitor: current.monitor,
        notificationHistory: state.notificationHistory,
        quickTriggers: state.quickTriggers
      };
    }
    case "monitor:start": {
      const monitor = await startMonitor(
        request.tabId,
        request.settings,
        request.keywordMonitoring
      );
      return { ok: true, tab: summary, monitor };
    }
    case "monitor:pause": {
      const current = getMonitor(state, request.tabId);
      if (!current || current.status !== "running") {
        throw new Error("Only a running monitor can be paused.");
      }
      const monitor = await persistMonitor({
        ...pauseMonitor(current, Date.now()),
        keywordRuntime: {
          ...current.keywordRuntime,
          pendingScan: null,
          lastScanStatus: current.keywordRuntime.pendingScan
            ? "idle"
            : current.keywordRuntime.lastScanStatus
        }
      });
      await bestEffortClearScans(request.tabId);
      return { ok: true, tab: summary, monitor };
    }
    case "monitor:resume": {
      const current = getMonitor(state, request.tabId);
      if (!current || current.status !== "paused") {
        throw new Error("Only a paused monitor can be resumed.");
      }
      if (!(await permissionGranted(current.pageUrl))) {
        throw new Error("Site access is no longer available for this page.");
      }
      const monitorDelayError = validateMonitorDelayForReload(
        current.intervalMs,
        current.keywordMonitoring.scanDelayMs,
        current.keywordMonitoring.enabled
      );
      if (monitorDelayError) throw new Error(monitorDelayError);
      let monitor = await persistMonitor({
        ...resumeMonitor(current, Date.now()),
        keywordRuntime: {
          ...current.keywordRuntime,
          pendingScan: null,
          lastScanStatus: current.keywordMonitoring.enabled
            ? "waiting-for-load"
            : current.keywordRuntime.lastScanStatus
        }
      });
      if (monitor.status === "running") {
        monitor = await prepareContentForMonitor(monitor, "resume");
      }
      return { ok: true, tab: summary, monitor };
    }
    case "monitor:stop": {
      const monitor = await stopTabActivity(request.tabId);
      if (!monitor) throw new Error("This tab has no saved monitor.");
      return { ok: true, tab: summary, monitor };
    }
    case "monitor:reload-now": {
      const monitor = await performReload(request.tabId, "manual");
      return { ok: true, tab: summary, monitor };
    }
    case "monitor:retry-scan": {
      const current = getMonitor(state, request.tabId);
      if (
        !current ||
        current.status !== "running" ||
        !current.keywordMonitoring.enabled
      ) {
        throw new Error("A running keyword monitor is required to retry.");
      }
      await bestEffortClearScans(request.tabId);
      const retryable = await persistMonitorStateOnly({
        ...current,
        pageTitle: summary?.title ?? current.pageTitle,
        pageUrl: summary?.url ?? current.pageUrl,
        keywordRuntime: {
          ...current.keywordRuntime,
          navigationGeneration:
            current.keywordRuntime.navigationGeneration + 1,
          navigationStartedAt: Date.now(),
          lastCompletedGeneration: null,
          pendingScan: null,
          scanProgress: null,
          lastScanStatus: "waiting-for-load"
        },
        updatedAt: Date.now()
      });
      const monitor = await scheduleKeywordScanAfterLoad(
        retryable,
        summary?.url ?? retryable.pageUrl,
        Date.now()
      );
      return { ok: true, tab: summary, monitor };
    }
    case "monitor:test-keywords": {
      const normalizedConfig: KeywordMonitoringConfig = {
        ...request.keywordMonitoring,
        keywords: normalizeKeywordRules(request.keywordMonitoring.keywords)
      };
      const configError = validateKeywordConfig({
        ...normalizedConfig,
        enabled: true
      });
      if (configError) throw new Error(configError);
      const readiness = await ensureContentScriptReady(request.tabId);
      if (!readiness.ok) throw new Error(readiness.error.message);
      const current = getMonitor(state, request.tabId) ?? null;
      const generation =
        current?.keywordRuntime.navigationGeneration ?? 0;
      const aggregation = await scanCurrentFrames(
        request.tabId,
        generation,
        normalizedConfig.keywords,
        normalizedConfig.caseSensitive
      );
      let highlights: HighlightSummary = {
        highlightedOccurrenceCount: 0,
        truncated: false,
        errors: [],
        frameResults: []
      };
      if (
        aggregation.status === "complete" &&
        aggregation.matched &&
        normalizedConfig.highlightMatches
      ) {
        highlights = await applyHighlights(
          request.tabId,
          aggregation.matchedFrames,
          normalizedConfig.keywords,
          normalizedConfig.caseSensitive
        );
      } else if (
        normalizedConfig.highlightMatches &&
        (aggregation.status === "partial" || !aggregation.matched)
      ) {
        await clearHighlights(request.tabId);
      }
      const testResult: KeywordTestResult = {
        status:
          aggregation.status === "partial"
            ? "partial"
            : aggregation.matched
              ? "match"
              : "no-match",
        keywordsTested: normalizedConfig.keywords.length,
        matchedKeywords:
          aggregation.status === "complete"
            ? aggregation.matchedKeywords
            : [],
        matchingFrameCount:
          aggregation.status === "complete"
            ? aggregation.matchingFrameCount
            : 0,
        highlightedOccurrenceCount:
          highlights.highlightedOccurrenceCount,
        highlightTruncated: highlights.truncated,
        highlightErrors: highlights.errors
      };
      return {
        ok: true,
        tab: summary,
        monitor: current,
        testResult,
        message: "Keyword test completed without changing the baseline."
      };
    }
    case "monitor:clear-highlights": {
      const cleared = await clearHighlights(request.tabId);
      const current = getMonitor(state, request.tabId);
      const monitor = current
        ? await persistMonitorStateOnly({
            ...current,
            keywordRuntime: {
              ...current.keywordRuntime,
              highlightedOccurrenceCount: 0,
              highlightTruncated: false,
              lastHighlightError: null
            },
            updatedAt: Date.now()
          })
        : null;
      return {
        ok: true,
        tab: summary,
        monitor,
        message: `${cleared} highlight${cleared === 1 ? "" : "s"} cleared.`
      };
    }
    case "monitor:update-keyword": {
      const current = getMonitor(state, request.tabId);
      if (!current) throw new Error("Start a monitor before saving settings.");
      if (current.status === "running") {
        throw new Error("Pause or stop before changing keyword monitoring.");
      }
      const normalizedConfig: KeywordMonitoringConfig = {
        ...request.keywordMonitoring,
        keywords: normalizeKeywordRules(request.keywordMonitoring.keywords)
      };
      const configError = validateKeywordConfig(normalizedConfig);
      if (configError) throw new Error(configError);
      const monitorDelayError = validateMonitorDelayForReload(
        current.intervalMs,
        normalizedConfig.scanDelayMs,
        normalizedConfig.enabled
      );
      if (monitorDelayError) throw new Error(monitorDelayError);
      const baselineChanged =
        !keywordConditionEquals(
          current.keywordMonitoring,
          normalizedConfig
        ) ||
        current.keywordMonitoring.mode !== normalizedConfig.mode;
      const keywordRuntime = baselineChanged
        ? resetKeywordBaseline(current.keywordRuntime)
        : {
            ...current.keywordRuntime,
            pendingScan: null,
            lastScanStatus: normalizedConfig.enabled
              ? current.keywordRuntime.lastScanStatus
              : "idle",
            ...(!normalizedConfig.highlightMatches
              ? {
                  highlightedOccurrenceCount: 0,
                  highlightTruncated: false,
                  lastHighlightError: null
                }
              : {})
          };
      const monitor = await persistMonitorStateOnly({
        ...current,
        keywordMonitoring: normalizedConfig,
        keywordRuntime,
        updatedAt: Date.now()
      });
      await bestEffortClearScans(request.tabId);
      if (
        baselineChanged ||
        !normalizedConfig.enabled ||
        !normalizedConfig.highlightMatches
      ) {
        bestEffortClearHighlights(request.tabId);
      }
      return {
        ok: true,
        tab: summary,
        monitor,
        message: "Keyword monitoring settings saved."
      };
    }
    case "monitor:clear-history": {
      const current = getMonitor(state, request.tabId);
      if (!current) throw new Error("This tab has no saved monitor.");
      const monitor = await persistMonitorStateOnly({
        ...current,
        detectionHistory: [],
        updatedAt: Date.now()
      });
      return {
        ok: true,
        tab: summary,
        monitor,
        message: "Detection history cleared."
      };
    }
    case "monitor:reset-baseline": {
      const current = getMonitor(state, request.tabId);
      if (!current) throw new Error("This tab has no saved monitor.");
      if (current.status === "running") {
        throw new Error("Pause or stop before resetting the baseline.");
      }
      const monitor = await persistMonitorStateOnly({
        ...current,
        keywordRuntime: resetKeywordBaseline(current.keywordRuntime),
        updatedAt: Date.now()
      });
      await bestEffortClearScans(request.tabId);
      bestEffortClearHighlights(request.tabId);
      return {
        ok: true,
        tab: summary,
        monitor,
        message: "Keyword baseline reset."
      };
    }
  }
}

async function handleContentRequest(
  request: ExtensionRequest,
  sender: chrome.runtime.MessageSender
): Promise<ExtensionResponse> {
  if (!isContentRequest(request) || sender.tab?.id === undefined) {
    return { ok: false, error: "Invalid content message.", code: "BAD_MESSAGE" };
  }

  const tabId = sender.tab.id;
  const current = getMonitor(state, tabId);
  const summary = toTabSummary(sender.tab);
  if (!current) return { ok: true, tab: summary, monitor: null };

  if (request.type === "content:ready") {
    const monitor = await persistMonitorStateOnly({
      ...current,
      pageTitle: request.pageTitle,
      pageUrl: request.pageUrl,
      updatedAt: Date.now()
    });
    return { ok: true, tab: summary, monitor };
  }

  const interacted = applyInteraction(current, request.event);
  const scheduleChanged =
    interacted.status !== current.status ||
    interacted.nextReloadAt !== current.nextReloadAt;
  const monitor = scheduleChanged
    ? await persistMonitor(interacted)
    : await persistMonitorStateOnly(interacted);
  if (monitor.status === "stopped" && current.status !== "stopped") {
    bestEffortClearHighlights(monitor.tabId);
  }
  return { ok: true, tab: summary, monitor };
}

function sendErrorResponse(
  sendResponse: (response: ExtensionResponse) => void,
  error: unknown
): void {
  const message = errorMessage(error);
  console.error("[background:message]", { error });
  sendResponse({
    ok: false,
    error: message,
    code: error instanceof Error ? error.name : "UNKNOWN_ERROR"
  });
}

chrome.runtime.onMessage.addListener(
  (
    request: unknown,
    sender,
    sendResponse: (response: ExtensionResponse) => void
  ) => {
    if (!isExtensionRequest(request)) {
      sendResponse({
        ok: false,
        error: "Invalid extension message.",
        code: "BAD_MESSAGE"
      });
      return false;
    }
    if (
      !isContentRequest(request) &&
      request.tabId !== null &&
      [
        "monitor:start",
        "monitor:pause",
        "monitor:stop",
        "monitor:reload-now",
        "monitor:retry-scan",
        "monitor:update-keyword",
        "monitor:reset-baseline",
        "monitor:reset",
        "activity:stop"
      ].includes(request.type)
    ) {
      invalidateTabScans(request.tabId, request.type);
    }
    if (
      isContentRequest(request) &&
      request.type === "content:interaction" &&
      sender.tab?.id !== undefined
    ) {
      const liveMonitor = getMonitor(state, sender.tab.id);
      if (
        liveMonitor?.status === "running" &&
        ["pause", "stop"].includes(liveMonitor.interactionBehavior)
      ) {
        invalidateTabScans(
          sender.tab.id,
          `interaction-${liveMonitor.interactionBehavior}`
        );
      }
    }
    const immediate =
      !isContentRequest(request) &&
      ["monitor:reset", "monitor:reset-all", "monitor:diagnostics"].includes(
        request.type
      );

    const operation = immediate
      ? isContentRequest(request)
        ? Promise.resolve<ExtensionResponse>({
            ok: false,
            error: "Invalid message.",
            code: "BAD_MESSAGE"
          })
        : handlePopupRequest(request)
      : ensureInitialized().then(() =>
          enqueue(() =>
            isContentRequest(request)
              ? handleContentRequest(request, sender)
              : handlePopupRequest(request)
          )
        );

    void operation.then(sendResponse).catch((error: unknown) => {
      sendErrorResponse(sendResponse, error);
    });
    return true;
  }
);

function runEvent(
  prefix: string,
  operation: () => Promise<void>
): void {
  void ensureInitialized()
    .then(operation)
    .catch((error: unknown) => console.error(prefix, error));
}

chrome.alarms.onAlarm.addListener((alarm) => {
  runEvent("[alarm:fire]", async () => {
    if (alarm.name === BADGE_ALARM_NAME) {
      await updateActiveBadge();
      return;
    }
    const scanIdentity = scanIdentityFromAlarm(alarm.name);
    if (scanIdentity) {
      await enqueue(async () => {
        await scanLoadedPage(
          scanIdentity.tabId,
          scanIdentity.generation
        );
      });
      return;
    }
    const tabId = tabIdFromAlarm(alarm.name);
    if (tabId !== null) {
      await enqueue(async () => {
        await performReload(tabId, "alarm");
      });
    }
  });
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  runEvent("[tab:active]", async () => {
    const latest = await api("Read state after tab activation", readState());
    const saved = getMonitor(latest, tabId);
    const monitor = saved ? await ensureRunningSchedule(saved) : undefined;
    await applyBadge(tabId, monitor);
  });
});

chrome.windows.onFocusChanged.addListener(() => {
  runEvent("[tab:active]", updateActiveBadge);
});

chrome.notifications.onClicked.addListener((notificationId) => {
  if (!notificationId.startsWith(DETECTION_NOTIFICATION_PREFIX)) return;
  runEvent("[notification:click]", async () => {
    try {
      const target = await readNotificationTarget(notificationId);
      if (!target) return;
      const tokenKey = `${SESSION_TOKEN_PREFIX}${target.tabId}`;
      const tokens = await api(
        "Verify notification tab identity",
        chrome.storage.session.get(tokenKey)
      );
      if (tokens[tokenKey] !== target.tabInstanceId) return;
      const tab = await getTabIfPresent(target.tabId);
      if (!tab) return;
      await api(
        `Activate notification tab ${target.tabId}`,
        chrome.tabs.update(target.tabId, { active: true })
      );
      if (tab.windowId !== undefined) {
        await api(
          `Focus notification window ${tab.windowId}`,
          chrome.windows.update(tab.windowId, { focused: true })
        );
      }
    } finally {
      try {
        await removeNotificationTarget(notificationId);
      } catch (error) {
        console.warn("[notification:cleanup]", { notificationId, error });
      }
    }
  });
});

chrome.notifications.onClosed.addListener((notificationId) => {
  if (!notificationId.startsWith(DETECTION_NOTIFICATION_PREFIX)) return;
  runEvent("[notification:closed]", async () => {
    try {
      await removeNotificationTarget(notificationId);
    } catch (error) {
      console.warn("[notification:cleanup]", { notificationId, error });
    }
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  invalidateTabScans(tabId, "tab-removed");
  runEvent("[tab:removed]", async () => {
    await enqueue(async () => {
      const latest = await api("Read state after tab removal", readState());
      if (!getMonitor(latest, tabId)) {
        await bestEffortClearScans(tabId);
        return;
      }
      delete latest.monitors[monitorKey(tabId)];
      state = latest;
      await persistState();
      await bestEffortClearReload(tabId);
      await bestEffortClearScans(tabId);
      await bestEffortBadge(tabId);
      try {
        await removeSessionToken(tabId);
      } catch (error) {
        console.warn("[tab:removed] Could not remove session token.", {
          tabId,
          error
        });
      }
    });
  });
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  invalidateTabScans(removedTabId, "tab-replaced");
  invalidateTabScans(addedTabId, "tab-replacement-created");
  runEvent("[tab:replaced]", async () => {
    await enqueue(async () => {
      const latest = await api("Read state after tab replacement", readState());
      const current = getMonitor(latest, removedTabId);
      if (!current) return;
      const tab = await getTab(addedTabId);
      const summary = toTabSummary(tab);
      if (!summary) return;

      delete latest.monitors[monitorKey(removedTabId)];
      const monitor: TabMonitor = {
        ...current,
        tabId: addedTabId,
        pageTitle: summary.title,
        pageUrl: summary.url,
        keywordRuntime: {
          ...current.keywordRuntime,
          navigationGeneration:
            current.keywordRuntime.navigationGeneration + 1,
          navigationStartedAt: Date.now(),
          lastCompletedGeneration: null,
          pendingScan: null,
          scanProgress: null,
          lastScanStatus: current.keywordMonitoring.enabled
            ? "waiting-for-load"
            : current.keywordRuntime.lastScanStatus
        },
        updatedAt: Date.now()
      };
      state = latest;
      state.monitors[monitorKey(addedTabId)] = monitor;
      await persistState();
      await bestEffortClearReload(removedTabId);
      await bestEffortClearScans(removedTabId);
      await bestEffortClearScans(addedTabId);
      await bestEffortBadge(removedTabId);
      try {
        await removeSessionToken(removedTabId);
        await setSessionToken(addedTabId, monitor.tabInstanceId);
      } catch (error) {
        console.warn("[tab:replaced] Could not update session token.", error);
      }
      await persistMonitor(monitor);
    });
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (
    !changeInfo.url &&
    !changeInfo.title &&
    !["loading", "complete"].includes(changeInfo.status ?? "")
  ) {
    return;
  }
  const navigationStarted =
    changeInfo.status === "loading" ||
    (typeof changeInfo.url === "string" &&
      changeInfo.status !== "complete");
  if (navigationStarted) invalidateTabScans(tabId, "tab-navigation");
  runEvent("[tab:updated]", async () => {
    await enqueue(async () => {
      const latest = await api("Read state after tab update", readState());
      state = latest;
      const current = getMonitor(state, tabId);
      if (!current) {
        if (tab.active) await bestEffortBadge(tabId);
        return;
      }

      const pageUrl = tab.url ?? current.pageUrl;
      const pageTitle = tab.title ?? current.pageTitle;
      const support = inspectUrl(pageUrl);
      let monitor: TabMonitor = {
        ...current,
        pageUrl,
        pageTitle,
        keywordRuntime: navigationStarted
          ? {
              ...current.keywordRuntime,
              navigationGeneration:
                current.keywordRuntime.navigationGeneration + 1,
              navigationStartedAt: Date.now(),
              lastCompletedGeneration: null,
              pendingScan: null,
              scanProgress: null,
              lastScanStatus:
                current.status === "running" &&
                current.keywordMonitoring.enabled
                  ? "waiting-for-load"
                  : current.keywordRuntime.lastScanStatus
            }
          : current.keywordRuntime,
        updatedAt: Date.now()
      };
      if (navigationStarted) await bestEffortClearScans(tabId);
      if (!support.supported) {
        monitor = errorMonitor(
          monitor,
          support.reason ?? "This page cannot be monitored.",
          Date.now()
        );
      } else if (!(await permissionGranted(pageUrl))) {
        if (monitor.keywordMonitoring.enabled) {
          monitor = {
            ...monitor,
            keywordRuntime: {
              ...monitor.keywordRuntime,
              pendingScan: null,
              lastScanStatus: "error",
              lastError: monitorError(
                "NO_CONTENT_ACCESS",
                "Page access is required to scan this site."
              )
            },
            updatedAt: Date.now()
          };
        } else {
          monitor = errorMonitor(
            monitor,
            "Monitoring paused because site access is not granted for this destination.",
            Date.now()
          );
        }
      }

      monitor = await persistMonitor(monitor);
      if (changeInfo.status === "complete" && monitor.status === "running") {
        monitor = await prepareContentForMonitor(monitor, "restore");
        if (monitor.status === "running") {
          await scheduleKeywordScanAfterLoad(
            monitor,
            pageUrl,
            Date.now()
          );
        }
      }
    });
  });
});

chrome.runtime.onStartup.addListener(() => {
  runEvent("[background:startup]", () => enqueue(recoverState));
});

chrome.runtime.onInstalled.addListener(() => {
  runEvent("[background:startup]", () => enqueue(recoverState));
});

export { ALARM_PREFIX, alarmName };
