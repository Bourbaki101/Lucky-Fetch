import {
  MAX_KEYWORD_LENGTH,
  MAX_KEYWORDS_PER_MONITOR,
  MAX_SCAN_DELAY_MS,
  MIN_SCAN_DELAY_MS
} from "../shared/constants";
import type {
  KeywordMatch,
  KeywordMonitoringConfig,
  KeywordRule
} from "../types/monitor";

export interface KeywordMatchResult {
  matched: boolean;
  normalizedTextLength: number;
}

export function normalizeVisibleText(value: string): string {
  return value.replace(/\r\n?/gu, "\n").replace(/\s+/gu, " ").trim();
}

export function validateKeyword(keyword: string): string | null {
  const trimmed = keyword.trim();
  if (trimmed.length === 0) return "Enter a keyword or phrase.";
  if (trimmed.length > MAX_KEYWORD_LENGTH) {
    return `Each keyword must be ${MAX_KEYWORD_LENGTH} characters or fewer.`;
  }
  return null;
}

export function keywordComparisonKey(
  value: string,
  caseSensitive: boolean
): string {
  const trimmed = value.trim();
  return caseSensitive ? trimmed : trimmed.toLowerCase();
}

export function normalizeKeywordRules(
  keywords: readonly KeywordRule[]
): KeywordRule[] {
  return keywords.map((keyword) => ({
    id: keyword.id,
    value: keyword.value.trim()
  }));
}

export function keywordConditionEquals(
  left: KeywordMonitoringConfig,
  right: KeywordMonitoringConfig
): boolean {
  return (
    left.caseSensitive === right.caseSensitive &&
    left.keywords.length === right.keywords.length &&
    left.keywords.every(
      (keyword, index) =>
        keyword.id === right.keywords[index]?.id &&
        keyword.value === right.keywords[index]?.value
    )
  );
}

export function validateKeywordConfig(
  config: KeywordMonitoringConfig
): string | null {
  if (typeof config.enabled !== "boolean") {
    return "Keyword monitoring enabled state is invalid.";
  }
  if (config.enabled) {
    if (!Array.isArray(config.keywords) || config.keywords.length === 0) {
      return "Add at least one keyword or phrase.";
    }
  }
  if (!Array.isArray(config.keywords)) {
    return "The keyword list is invalid.";
  }
  if (config.keywords.length > MAX_KEYWORDS_PER_MONITOR) {
    return `Use no more than ${MAX_KEYWORDS_PER_MONITOR} keywords.`;
  }
  const ids = new Set<string>();
  const values = new Set<string>();
  for (const keyword of config.keywords) {
    if (
      !keyword ||
      typeof keyword.id !== "string" ||
      keyword.id.trim().length === 0
    ) {
      return "Each keyword must have a stable ID.";
    }
    if (ids.has(keyword.id)) return "Keyword IDs must be unique.";
    ids.add(keyword.id);
    if (typeof keyword.value !== "string") return "A keyword value is invalid.";
    const keywordError = validateKeyword(keyword.value);
    if (keywordError) return keywordError;
    const comparison = keywordComparisonKey(
      keyword.value,
      config.caseSensitive
    );
    if (values.has(comparison)) {
      return config.caseSensitive
        ? "Duplicate keywords are not allowed."
        : "Duplicate keywords are not allowed when case is ignored.";
    }
    values.add(comparison);
  }
  if (!["found", "lost"].includes(config.mode)) {
    return "Unknown keyword detection mode.";
  }
  if (typeof config.caseSensitive !== "boolean") {
    return "Case-sensitive matching state is invalid.";
  }
  if (
    !Number.isFinite(config.scanDelayMs) ||
    config.scanDelayMs < MIN_SCAN_DELAY_MS ||
    config.scanDelayMs > MAX_SCAN_DELAY_MS
  ) {
    return "The scan delay must be between 0 and 60 seconds.";
  }
  if (!["continue", "pause", "stop"].includes(config.actionOnDetection)) {
    return "Unknown after-detection action.";
  }
  if (typeof config.notificationMessage !== "string") {
    return "The notification message is invalid.";
  }
  if (typeof config.highlightMatches !== "boolean") {
    return "The highlight setting is invalid.";
  }
  if (!["never", "found", "missing", "all"].includes(config.bringToFront)) {
    return "Unknown bring-to-front setting.";
  }
  if (
    !["off", "scroll-highlight", "click", "click-and-focus"].includes(
      config.autoOpenResult
    )
  ) {
    return "Unknown auto-open result setting.";
  }
  return null;
}

export interface MultiKeywordMatchResult {
  matched: boolean;
  matches: KeywordMatch[];
  normalizedTextLength: number;
}

export function matchAnyKeyword(
  visibleText: string,
  keywords: readonly KeywordRule[],
  caseSensitive: boolean
): MultiKeywordMatchResult {
  const normalizedText = normalizeVisibleText(visibleText);
  const haystack = caseSensitive
    ? normalizedText
    : normalizedText.toLowerCase();
  const matches = keywords.map((rule): KeywordMatch => {
    const error = validateKeyword(rule.value);
    if (error) throw new Error(error);
    const normalizedKeyword = normalizeVisibleText(rule.value);
    const needle = caseSensitive
      ? normalizedKeyword
      : normalizedKeyword.toLowerCase();
    let occurrenceCount = 0;
    let fromIndex = 0;
    while (needle.length > 0) {
      const index = haystack.indexOf(needle, fromIndex);
      if (index < 0) break;
      occurrenceCount += 1;
      fromIndex = index + needle.length;
    }
    return {
      keywordId: rule.id,
      keyword: rule.value.trim(),
      matched: occurrenceCount > 0,
      occurrenceCount
    };
  });
  return {
    matched: matches.some((match) => match.matched),
    matches,
    normalizedTextLength: normalizedText.length
  };
}

export function matchVisibleText(
  visibleText: string,
  keyword: string,
  caseSensitive: boolean
): KeywordMatchResult {
  const result = matchAnyKeyword(
    visibleText,
    [{ id: "legacy", value: keyword }],
    caseSensitive
  );
  return {
    matched: result.matched,
    normalizedTextLength: result.normalizedTextLength
  };
}
