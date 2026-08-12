import { validateKeywordConfig } from "../monitoring/matching";
import {
  MAX_INTERVAL_MS,
  MIN_INTERVAL_MS,
  MONITOR_DRAFTS_STORAGE_KEY
} from "../shared/constants";
import { validateMonitorDelayForReload } from "../shared/time";
import type {
  DraftStartState,
  MonitorSettings,
  PendingMonitorDraft,
  SiteAccessPreference
} from "../types/monitor";

type DraftRecord = Record<string, PendingMonitorDraft>;

function legacyDraftKeywordId(value: string): string {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return `legacy-${(hash >>> 0).toString(36)}`;
}

function normalizeDraftKeywordConfig(
  value: unknown
): PendingMonitorDraft["keywordConfig"] | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<PendingMonitorDraft["keywordConfig"]> & {
    keyword?: unknown;
  };
  const keywords = Array.isArray(candidate.keywords)
    ? candidate.keywords
        .filter(
          (keyword) =>
            keyword &&
            typeof keyword.id === "string" &&
            typeof keyword.value === "string"
        )
        .map((keyword) => ({
          id: keyword.id,
          value: keyword.value.trim()
        }))
    : typeof candidate.keyword === "string" &&
        candidate.keyword.trim().length > 0
      ? [
          {
            id: legacyDraftKeywordId(candidate.keyword.trim()),
            value: candidate.keyword.trim()
          }
        ]
      : [];
  const normalized = {
    enabled: candidate.enabled,
    keywords,
    mode: candidate.mode,
    caseSensitive: candidate.caseSensitive,
    scanDelayMs: candidate.scanDelayMs,
    actionOnDetection: candidate.actionOnDetection,
    highlightMatches:
      typeof candidate.highlightMatches === "boolean"
        ? candidate.highlightMatches
        : false,
    notificationMessage:
      typeof candidate.notificationMessage === "string"
        ? candidate.notificationMessage
        : "",
    bringToFront: ["found", "missing", "all"].includes(
      candidate.bringToFront ?? ""
    )
      ? candidate.bringToFront
      : "never",
    autoOpenResult: ["scroll-highlight", "click", "click-and-focus"].includes(
      candidate.autoOpenResult ?? ""
    )
      ? candidate.autoOpenResult
      : "off"
  } as PendingMonitorDraft["keywordConfig"];
  return validateKeywordConfig(normalized) === null ? normalized : null;
}

function isReloadConfig(value: unknown): value is MonitorSettings {
  if (!value || typeof value !== "object") return false;
  const config = value as Partial<MonitorSettings>;
  return (
    (config.reloadEnabled === undefined || typeof config.reloadEnabled === "boolean") &&
    Number.isFinite(config.intervalMs) &&
    (config.intervalMs ?? 0) >= MIN_INTERVAL_MS &&
    (config.intervalMs ?? 0) <= MAX_INTERVAL_MS &&
    typeof config.bypassCache === "boolean" &&
    (config.maximumReloads === null ||
      (Number.isInteger(config.maximumReloads) &&
        (config.maximumReloads ?? 0) >= 1 &&
        (config.maximumReloads ?? 0) <= 1_000_000)) &&
    ["ignore", "delay", "pause", "stop"].includes(
      config.interactionBehavior ?? ""
    ) &&
    typeof config.protectActiveTyping === "boolean"
  );
}

export function normalizeMonitorDraft(
  value: unknown
): PendingMonitorDraft | null {
  if (!value || typeof value !== "object") return null;
  const draft = value as Partial<PendingMonitorDraft>;
  const reloadConfig = draft.reloadConfig && isReloadConfig(draft.reloadConfig)
    ? { ...draft.reloadConfig, reloadEnabled: draft.reloadConfig.reloadEnabled ?? true }
    : null;
  const keywordConfig = normalizeDraftKeywordConfig(draft.keywordConfig);
  const preference: SiteAccessPreference | undefined =
    draft.siteAccessPreference;
  const startState: DraftStartState | undefined = draft.startState;
  if (
    draft.version !== 1 ||
    !Number.isInteger(draft.tabId) ||
    (draft.tabId ?? -1) < 0 ||
    typeof draft.pageOrigin !== "string" ||
    draft.pageOrigin.length === 0 ||
    typeof draft.savedAt !== "number" ||
    !Number.isFinite(draft.savedAt) ||
    !reloadConfig ||
    !keywordConfig ||
    validateMonitorDelayForReload(
      reloadConfig.intervalMs,
      keywordConfig.scanDelayMs,
      keywordConfig.enabled
    ) !== null ||
    !["site", "all"].includes(preference ?? "") ||
    !["pending", "requesting", "denied", "error"].includes(startState ?? "")
  ) {
    return null;
  }
  return {
    version: 1,
    tabId: draft.tabId!,
    pageOrigin: draft.pageOrigin,
    savedAt: draft.savedAt,
    reloadConfig,
    keywordConfig: {
      ...keywordConfig,
      keywords: keywordConfig.keywords.map((keyword) => ({ ...keyword }))
    },
    siteAccessPreference: preference!,
    startState: startState!,
    ...(typeof draft.technicalError === "string"
      ? { technicalError: draft.technicalError }
      : {})
  };
}

async function readDraftRecord(): Promise<DraftRecord> {
  const stored = await chrome.storage.local.get(MONITOR_DRAFTS_STORAGE_KEY);
  const raw = stored[MONITOR_DRAFTS_STORAGE_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result: DraftRecord = {};
  for (const [key, value] of Object.entries(raw)) {
    const draft = normalizeMonitorDraft(value);
    if (draft) result[key] = draft;
  }
  return result;
}

export async function readMonitorDraft(
  tabId: number
): Promise<PendingMonitorDraft | null> {
  const drafts = await readDraftRecord();
  return drafts[String(tabId)] ?? null;
}

export async function writeMonitorDraft(
  draft: PendingMonitorDraft
): Promise<void> {
  const normalized = normalizeMonitorDraft(draft);
  if (!normalized) throw new Error("The pending monitor draft is invalid.");
  const drafts = await readDraftRecord();
  drafts[String(draft.tabId)] = normalized;
  await chrome.storage.local.set({
    [MONITOR_DRAFTS_STORAGE_KEY]: drafts
  });
}

export async function removeMonitorDraft(tabId: number): Promise<void> {
  const drafts = await readDraftRecord();
  delete drafts[String(tabId)];
  await chrome.storage.local.set({
    [MONITOR_DRAFTS_STORAGE_KEY]: drafts
  });
}
