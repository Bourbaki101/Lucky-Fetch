import type {
  PageContentRequest,
  PageScanRequest
} from "../messaging/contracts";
import type { KeywordMatch, KeywordRule } from "../types/monitor";

const CONTENT_MAX_KEYWORDS_PER_MONITOR = 20;
const CONTENT_MAX_KEYWORD_LENGTH = 200;

export interface ContentMatchResult {
  matched: boolean;
  matches: KeywordMatch[];
  normalizedTextLength: number;
}

export function isPageContentRequest(
  value: unknown
): value is PageContentRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<PageContentRequest>;
  if (request.type === "content:ping") return true;
  if (request.type === "content:clear-highlights") return true;
  const scan = request as Partial<PageScanRequest>;
  return (
    ["content:scan-page", "content:highlight-matches"].includes(
      scan.type ?? ""
    ) &&
    Array.isArray(scan.keywords) &&
    scan.keywords.length > 0 &&
    scan.keywords.length <= CONTENT_MAX_KEYWORDS_PER_MONITOR &&
    scan.keywords.every(
      (keyword) =>
        keyword &&
        typeof keyword.id === "string" &&
        typeof keyword.value === "string" &&
        keyword.value.trim().length > 0 &&
        keyword.value.trim().length <= CONTENT_MAX_KEYWORD_LENGTH
    ) &&
    typeof scan.caseSensitive === "boolean" &&
    Number.isInteger(scan.generation) &&
    (scan.generation ?? -1) >= 0
  );
}

export function matchContentText(
  visibleText: string,
  keywords: readonly KeywordRule[],
  caseSensitive: boolean
): ContentMatchResult {
  const normalizedText = visibleText.replace(/\r\n?/gu, "\n")
    .replace(/\s+/gu, " ")
    .trim();
  const haystack = caseSensitive
    ? normalizedText
    : normalizedText.toLowerCase();
  const matches = keywords.map((keyword): KeywordMatch => {
    const normalizedKeyword = keyword.value.replace(/\r\n?/gu, "\n")
      .replace(/\s+/gu, " ")
      .trim();
    if (normalizedKeyword.length === 0) {
      throw new Error("Enter a keyword or phrase.");
    }
    const needle = caseSensitive
      ? normalizedKeyword
      : normalizedKeyword.toLowerCase();
    let occurrenceCount = 0;
    let offset = 0;
    while (needle.length > 0) {
      const found = haystack.indexOf(needle, offset);
      if (found < 0) break;
      occurrenceCount += 1;
      offset = found + needle.length;
    }
    return {
      keywordId: keyword.id,
      keyword: keyword.value.trim(),
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
