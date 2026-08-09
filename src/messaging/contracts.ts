import type {
  InteractionEvent,
  FrameHighlightResult,
  KeywordRule,
  KeywordTestResult,
  KeywordMonitoringConfig,
  MonitorSettings,
  NotificationHistoryEntry,
  ScanResult,
  TabMonitor,
  TabSummary,
  TypedMonitorError
} from "../types/monitor";
import type { DiagnosticSnapshot } from "../types/diagnostics";
import { HIGHLIGHT_ERROR_CODES } from "../types/monitor";
import {
  MAX_KEYWORD_LENGTH,
  MAX_KEYWORDS_PER_MONITOR
} from "../shared/constants";

function isKeywordRuleList(value: unknown): value is KeywordRule[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_KEYWORDS_PER_MONITOR
  ) {
    return false;
  }
  const ids = new Set<string>();
  return value.every((keyword) => {
    if (
      !keyword ||
      typeof keyword.id !== "string" ||
      keyword.id.length === 0 ||
      ids.has(keyword.id) ||
      typeof keyword.value !== "string" ||
      keyword.value.trim().length === 0 ||
      keyword.value.trim().length > MAX_KEYWORD_LENGTH
    ) {
      return false;
    }
    ids.add(keyword.id);
    return true;
  });
}

export type PopupRequest =
  | { type: "monitor:get-current"; tabId: number }
  | {
      type: "monitor:start";
      tabId: number;
      settings: MonitorSettings;
      keywordMonitoring: KeywordMonitoringConfig;
    }
  | { type: "monitor:pause"; tabId: number }
  | { type: "monitor:resume"; tabId: number }
  | { type: "monitor:stop"; tabId: number }
  | { type: "monitor:reload-now"; tabId: number }
  | { type: "monitor:retry-scan"; tabId: number }
  | {
      type: "monitor:test-keywords";
      tabId: number;
      keywordMonitoring: KeywordMonitoringConfig;
    }
  | { type: "monitor:clear-highlights"; tabId: number }
  | {
      type: "monitor:update-keyword";
      tabId: number;
      keywordMonitoring: KeywordMonitoringConfig;
    }
  | { type: "monitor:clear-history"; tabId: number }
  | { type: "monitor:reset-baseline"; tabId: number }
  | { type: "monitor:reset"; tabId: number }
  | { type: "notifications:clear"; tabId: number }
  | { type: "monitor:diagnostics"; tabId: number | null }
  | { type: "monitor:reconcile"; tabId: number | null }
  | { type: "monitor:reset-all"; tabId: number | null };

export type ContentRequest =
  | {
      type: "content:interaction";
      event: InteractionEvent;
    }
  | { type: "content:ready"; pageTitle: string; pageUrl: string };

export type ExtensionRequest = PopupRequest | ContentRequest;

export interface PageScanRequest {
  type: "content:scan-page";
  keywords: KeywordRule[];
  caseSensitive: boolean;
  generation: number;
}

export interface PageHighlightRequest {
  type: "content:highlight-matches";
  keywords: KeywordRule[];
  caseSensitive: boolean;
  generation: number;
}

export interface PageClearHighlightRequest {
  type: "content:clear-highlights";
}

export interface PagePingRequest {
  type: "content:ping";
}

export interface PagePingResponse {
  ok: true;
  ready: true;
  pageUrl: string;
}

export type PageContentRequest =
  | PagePingRequest
  | PageScanRequest
  | PageHighlightRequest
  | PageClearHighlightRequest;
export type PageContentResponse =
  | PagePingResponse
  | PageScanResponse
  | PageHighlightResponse
  | PageClearHighlightResponse;

export type PageScanResponse =
  | { ok: true; result: ScanResult; generation: number }
  | { ok: false; error: TypedMonitorError; generation: number };

export type PageHighlightResponse =
  | { ok: true; result: FrameHighlightResult; generation: number }
  | {
      ok: false;
      error: FrameHighlightResult["error"];
      generation: number;
    };

export interface PageClearHighlightResponse {
  ok: true;
  cleared: number;
}

export type ExtensionResponse =
  | {
      ok: true;
      tab: TabSummary | null;
      monitor: TabMonitor | null;
      diagnostics?: DiagnosticSnapshot;
      notificationHistory?: NotificationHistoryEntry[];
      testResult?: KeywordTestResult;
      message?: string;
    }
  | { ok: false; error: string; code?: string };

export function isContentRequest(
  value: unknown
): value is ContentRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<ContentRequest>;
  if (request.type === "content:ready") {
    return (
      typeof request.pageTitle === "string" &&
      typeof request.pageUrl === "string"
    );
  }
  if (request.type !== "content:interaction" || !request.event) return false;
  return (
    ["pointer", "keyboard", "scroll", "input", "editable-focus"].includes(
      request.event.kind
    ) &&
    typeof request.event.occurredAt === "number" &&
    Number.isFinite(request.event.occurredAt) &&
    typeof request.event.activeTyping === "boolean"
  );
}

export function isPopupRequest(value: unknown): value is PopupRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<PopupRequest>;
  if (typeof request.type !== "string") return false;
  if (
    ["monitor:diagnostics", "monitor:reconcile", "monitor:reset-all"].includes(
      request.type
    )
  ) {
    return request.tabId === null || Number.isInteger(request.tabId);
  }
  if (!Number.isInteger(request.tabId)) return false;
  if (request.type === "monitor:start") {
    return Boolean(request.settings && request.keywordMonitoring);
  }
  if (request.type === "monitor:update-keyword") {
    return Boolean(request.keywordMonitoring);
  }
  if (request.type === "monitor:test-keywords") {
    return Boolean(request.keywordMonitoring);
  }
  return [
    "monitor:get-current",
    "monitor:pause",
    "monitor:resume",
    "monitor:stop",
    "monitor:reload-now",
    "monitor:retry-scan",
    "monitor:clear-highlights",
    "monitor:clear-history",
    "monitor:reset-baseline",
    "monitor:reset",
    "notifications:clear"
  ].includes(request.type);
}

export function isExtensionRequest(
  value: unknown
): value is ExtensionRequest {
  return isContentRequest(value) || isPopupRequest(value);
}

export function isPageScanRequest(value: unknown): value is PageScanRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<PageScanRequest>;
  return (
    request.type === "content:scan-page" &&
    isKeywordRuleList(request.keywords) &&
    typeof request.caseSensitive === "boolean" &&
    Number.isInteger(request.generation) &&
    (request.generation ?? -1) >= 0
  );
}

export function isPagePingResponse(value: unknown): value is PagePingResponse {
  if (!value || typeof value !== "object") return false;
  const response = value as Partial<PagePingResponse>;
  return (
    response.ok === true &&
    response.ready === true &&
    typeof response.pageUrl === "string"
  );
}

export function isPageScanResponse(value: unknown): value is PageScanResponse {
  if (!value || typeof value !== "object") return false;
  const response = value as {
    ok?: unknown;
    generation?: unknown;
    result?: Partial<ScanResult>;
    error?: Partial<TypedMonitorError>;
  };
  if (typeof response.ok !== "boolean" || !Number.isInteger(response.generation)) {
    return false;
  }
  if (response.ok) {
    const result = response.result;
    return Boolean(
      result &&
        typeof result.matched === "boolean" &&
        typeof result.scannedAt === "number" &&
        typeof result.pageTitle === "string" &&
        typeof result.pageUrl === "string" &&
        typeof result.textLength === "number" &&
        Array.isArray(result.matchedKeywords) &&
        result.matchedKeywords.every(
          (keyword) =>
            keyword &&
            typeof keyword.id === "string" &&
            typeof keyword.value === "string"
        ) &&
        Number.isInteger(result.matchingFrameCount)
    );
  }
  return Boolean(
    response.error &&
      typeof response.error.code === "string" &&
      typeof response.error.message === "string" &&
      typeof response.error.occurredAt === "number" &&
      typeof response.error.recoverable === "boolean"
  );
}

function isHighlightError(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const error = value as Record<string, unknown>;
  return (
    typeof error.code === "string" &&
    HIGHLIGHT_ERROR_CODES.includes(
      error.code as (typeof HIGHLIGHT_ERROR_CODES)[number]
    ) &&
    typeof error.message === "string" &&
    typeof error.occurredAt === "number" &&
    typeof error.recoverable === "boolean" &&
    (error.frameId === undefined || Number.isInteger(error.frameId))
  );
}

export function isPageHighlightResponse(
  value: unknown
): value is PageHighlightResponse {
  if (!value || typeof value !== "object") return false;
  const response = value as {
    ok?: unknown;
    generation?: unknown;
    result?: Partial<FrameHighlightResult>;
    error?: unknown;
  };
  if (
    typeof response.ok !== "boolean" ||
    !Number.isInteger(response.generation)
  ) {
    return false;
  }
  if (!response.ok) return isHighlightError(response.error);
  return Boolean(
    response.result &&
      Number.isInteger(response.result.frameId) &&
      Number.isInteger(response.result.highlightedOccurrenceCount) &&
      (response.result.highlightedOccurrenceCount ?? -1) >= 0 &&
      typeof response.result.truncated === "boolean" &&
      (response.result.error === undefined ||
        isHighlightError(response.result.error))
  );
}

export function isPageClearHighlightResponse(
  value: unknown
): value is PageClearHighlightResponse {
  if (!value || typeof value !== "object") return false;
  const response = value as Partial<PageClearHighlightResponse>;
  return (
    response.ok === true &&
    Number.isInteger(response.cleared) &&
    (response.cleared ?? -1) >= 0
  );
}
