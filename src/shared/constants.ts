export const MIN_INTERVAL_MS = 10_000;
export const MAX_INTERVAL_MS = 30 * 24 * 60 * 60 * 1_000;
export const MONITOR_DELAY_RELOAD_RATIO = 0.5;
export const ACTIVE_TYPING_IDLE_MS = 5_000;
export const STORAGE_KEY = "luckyfetchState";
export const MONITOR_DRAFTS_STORAGE_KEY = "luckyfetchPendingMonitorDrafts";
export const POPUP_PREFERENCES_STORAGE_KEY = "luckyfetchPopupPreferences";
export const ALARM_PREFIX = "luckyfetch:reload:";
export const SCAN_ALARM_PREFIX = "luckyfetch:scan:";
export const BADGE_ALARM_NAME = "luckyfetch:badge-refresh";
export const BADGE_REFRESH_MINUTES = 0.5;
export const CONTENT_SCRIPT_FILE = "content.js";
export const SESSION_TOKEN_PREFIX = "luckyfetch:tab-instance:";
export const NOTIFICATION_TARGET_PREFIX = "luckyfetch:notification-target:";
export const DETECTION_NOTIFICATION_PREFIX = "luckyfetch:detection:";
export const CHROME_API_TIMEOUT_MS = 4_000;
export const SCAN_TIMEOUT_MS = 4_000;
export const CONTENT_READY_TIMEOUT_MS = 2_500;
export const POPUP_INIT_TIMEOUT_MS = 4_000;
export const RECOVERY_RELOAD_DELAY_MS = 1_000;
export const MIN_SCAN_DELAY_MS = 0;
export const MAX_SCAN_DELAY_MS = 60_000;
export const DEFAULT_SCAN_DELAY_MS = 2_000;
export const INCOMPLETE_SCAN_RETRY_DELAYS_MS = [500, 1_500, 3_000] as const;
export const DETECTION_HISTORY_LIMIT = 50;
export const POPUP_HISTORY_LIMIT = 5;
export const NOTIFICATION_HISTORY_LIMIT = 15;
export const MAX_KEYWORDS_PER_MONITOR = 20;
export const MAX_KEYWORD_LENGTH = 200;
export const MAX_QUICK_TRIGGERS = 5;
export const MAX_MATCHED_KEYWORD_METADATA = 20;
export const MAX_NOTIFICATION_KEYWORDS = 3;
export const MAX_HIGHLIGHTS_PER_FRAME = 500;
export const MAX_HIGHLIGHT_TEXT_NODES = 20_000;
export const TRIGGER_FOCUS_COOLDOWN_MS = 5 * 60 * 1_000;
export const ALL_WEBSITE_PERMISSION_PATTERNS = [
  "http://*/*",
  "https://*/*"
] as const;

export const DEFAULT_SETTINGS = {
  intervalMs: 60_000,
  bypassCache: false,
  maximumReloads: null,
  interactionBehavior: "ignore",
  protectActiveTyping: true
} as const;

export const DEFAULT_KEYWORD_MONITORING = {
  enabled: false,
  keywords: [] as Array<{ id: string; value: string }>,
  mode: "found",
  caseSensitive: false,
  scanDelayMs: DEFAULT_SCAN_DELAY_MS,
  actionOnDetection: "continue",
  highlightMatches: false,
  notificationMessage: "",
  bringToFront: "never",
  autoOpenResult: "off"
} as const;
