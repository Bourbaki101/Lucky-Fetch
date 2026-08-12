export const MONITOR_STATUSES = [
  "running",
  "paused",
  "stopped",
  "completed",
  "error"
] as const;

export type MonitorStatus = (typeof MONITOR_STATUSES)[number];

export const INTERACTION_BEHAVIORS = [
  "ignore",
  "delay",
  "pause",
  "stop"
] as const;

export type InteractionBehavior = (typeof INTERACTION_BEHAVIORS)[number];
export type IntervalUnit = "seconds" | "minutes" | "hours";

export const KEYWORD_MONITOR_MODES = ["found", "lost"] as const;
export type KeywordMonitorMode = (typeof KEYWORD_MONITOR_MODES)[number];

export const DETECTION_ACTIONS = ["continue", "pause", "stop"] as const;
export type DetectionAction = (typeof DETECTION_ACTIONS)[number];

export const BRING_TO_FRONT_MODES = [
  "never",
  "found",
  "missing",
  "all"
] as const;
export type BringToFrontMode = (typeof BRING_TO_FRONT_MODES)[number];

export const AUTO_OPEN_RESULT_MODES = [
  "off",
  "scroll-highlight",
  "click",
  "click-and-focus"
] as const;
export type AutoOpenResultMode = (typeof AUTO_OPEN_RESULT_MODES)[number];

export const KEYWORD_SCAN_STATUSES = [
  "idle",
  "waiting-for-load",
  "waiting-for-delay",
  "scanning",
  "complete",
  "partial",
  "retrying",
  "incomplete",
  "error"
] as const;
export type KeywordScanStatus = (typeof KEYWORD_SCAN_STATUSES)[number];

export const MONITOR_ERROR_CODES = [
  "NO_CONTENT_ACCESS",
  "RESTRICTED_PAGE",
  "TAB_CLOSED",
  "STALE_NAVIGATION",
  "CONTENT_SCRIPT_UNAVAILABLE",
  "MESSAGE_PORT_CLOSED",
  "SCAN_TIMEOUT",
  "EMPTY_DOCUMENT",
  "FRAME_SCAN_PARTIAL",
  "CORRUPT_STATE",
  "NOTIFICATION_FAILED",
  "STORAGE_FAILED",
  "INVALID_CONFIGURATION",
  "UNKNOWN"
] as const;
export type MonitorErrorCode = (typeof MONITOR_ERROR_CODES)[number];

export interface TypedMonitorError {
  code: MonitorErrorCode;
  message: string;
  technicalMessage?: string;
  occurredAt: number;
  recoverable: boolean;
}

export interface KeywordRule {
  id: string;
  value: string;
}

export interface MatchedKeyword {
  id: string;
  value: string;
}

export interface KeywordMonitoringConfig {
  enabled: boolean;
  keywords: KeywordRule[];
  mode: KeywordMonitorMode;
  caseSensitive: boolean;
  scanDelayMs: number;
  actionOnDetection: DetectionAction;
  highlightMatches: boolean;
  notificationMessage: string;
  bringToFront: BringToFrontMode;
  autoOpenResult: AutoOpenResultMode;
}

export type SiteAccessPreference = "site" | "all";
export type DraftStartState =
  | "pending"
  | "requesting"
  | "denied"
  | "error";

export interface PendingMonitorDraft {
  version: 1;
  tabId: number;
  pageOrigin: string;
  savedAt: number;
  reloadConfig: MonitorSettings;
  keywordConfig: KeywordMonitoringConfig;
  siteAccessPreference: SiteAccessPreference;
  startState: DraftStartState;
  technicalError?: string;
}

export interface PendingKeywordScan {
  generation: number;
  pageUrl: string;
  scheduledFor: number;
  alarmName: string;
  retryNumber: number;
  reason: "initial-delay" | "partial-scan-retry";
}

export interface KeywordScanProgress {
  generation: number;
  retryNumber: number;
  totalDiscoveredFrameCount: number;
  scannedFrameCount: number;
  pendingFrameCount: number;
  restrictedFrameCount: number;
  matchedFrameIds: number[];
  conclusive: boolean;
}

export interface KeywordMonitoringRuntime {
  lastMatchState: boolean | null;
  lastScanAt: number | null;
  lastConfirmedAt: number | null;
  lastDetectionAt: number | null;
  lastScanStatus: KeywordScanStatus;
  lastError: TypedMonitorError | null;
  navigationGeneration: number;
  navigationStartedAt: number | null;
  lastCompletedGeneration: number | null;
  lastScannedGeneration: number | null;
  pendingScan: PendingKeywordScan | null;
  scanProgress: KeywordScanProgress | null;
  lastMatchedKeywords: MatchedKeyword[];
  matchingFrameCount: number;
  highlightedOccurrenceCount: number;
  highlightTruncated: boolean;
  lastHighlightError: TypedHighlightError | null;
  lastActionResultSignature: string | null;
  lastFocusAt: number | null;
  lastClickAt: number | null;
}

export const HIGHLIGHT_ERROR_CODES = [
  "FRAME_NO_LONGER_EXISTS",
  "DOCUMENT_CHANGED",
  "CANNOT_ACCESS_FRAME",
  "HIGHLIGHT_REQUEST_TIMED_OUT",
  "DOM_UNAVAILABLE",
  "HIGHLIGHT_LIMIT_REACHED",
  "UNSUPPORTED_DOCUMENT",
  "CONTENT_SCRIPT_CONTEXT_INVALIDATED",
  "UNKNOWN"
] as const;
export type HighlightErrorCode = (typeof HIGHLIGHT_ERROR_CODES)[number];

export interface TypedHighlightError {
  code: HighlightErrorCode;
  message: string;
  occurredAt: number;
  recoverable: boolean;
  frameId?: number;
  technicalMessage?: string;
}

export interface DetectionHistoryEntry {
  id: string;
  tabId: number;
  mode: KeywordMonitorMode;
  /** Kept for backward-compatible rendering of Phase 2A history. */
  keyword: string;
  matchedKeywords?: MatchedKeyword[];
  detectedAt: number;
  pageTitle: string;
  pageUrl: string;
  actionApplied: DetectionAction;
}

export interface NotificationHistoryEntry {
  id: string;
  state: KeywordMonitorMode;
  keyword: string;
  timestamp: number;
  triggerLabel?: string;
}

export interface MonitorSettings {
  intervalMs: number;
  bypassCache: boolean;
  maximumReloads: number | null;
  interactionBehavior: InteractionBehavior;
  protectActiveTyping: boolean;
}

export interface TabMonitor extends MonitorSettings {
  tabId: number;
  tabInstanceId: string;
  pageTitle: string;
  pageUrl: string;
  reloadCount: number;
  status: MonitorStatus;
  lastReloadAt: number | null;
  nextReloadAt: number | null;
  lastUserInteractionAt: number | null;
  typingProtectionUntil: number | null;
  errorMessage: string | null;
  keywordMonitoring: KeywordMonitoringConfig;
  keywordRuntime: KeywordMonitoringRuntime;
  detectionHistory: DetectionHistoryEntry[];
  createdAt: number;
  updatedAt: number;
}

export interface PersistedState {
  version: 5;
  monitors: Record<string, TabMonitor>;
  notificationHistory: NotificationHistoryEntry[];
  quickTriggers: string[];
}

export interface ActivityEntry {
  tabId: number;
  pageTitle: string;
  pageUrl: string;
  hostname: string;
  reloadActive: boolean;
  monitorActive: boolean;
  nextReloadAt: number | null;
  keywords: string[];
  monitorStatus: MonitorStatus;
  monitorState: boolean | null;
  needsAttention: boolean;
  attentionLabel: string | null;
}

export interface TabSummary {
  id: number;
  title: string;
  url: string;
  favIconUrl?: string;
}

export interface InteractionEvent {
  kind: "pointer" | "keyboard" | "scroll" | "input" | "editable-focus";
  occurredAt: number;
  activeTyping: boolean;
}

export interface ScanResult {
  matched: boolean;
  scannedAt: number;
  pageTitle: string;
  pageUrl: string;
  textLength: number;
  matchedKeywords: MatchedKeyword[];
  matchingFrameCount: number;
}

export interface KeywordMatch {
  keywordId: string;
  keyword: string;
  matched: boolean;
  occurrenceCount?: number;
}

export interface FrameKeywordScanResult {
  frameId: number;
  matched: boolean;
  matches: KeywordMatch[];
}

export interface FrameHighlightResult {
  frameId: number;
  highlightedOccurrenceCount: number;
  truncated: boolean;
  error?: TypedHighlightError;
}

export interface KeywordTestResult {
  status: "match" | "no-match" | "partial";
  keywordsTested: number;
  matchedKeywords: MatchedKeyword[];
  matchingFrameCount: number;
  highlightedOccurrenceCount: number;
  highlightTruncated: boolean;
  highlightErrors: TypedHighlightError[];
}
