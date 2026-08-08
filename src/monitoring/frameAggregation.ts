import { MAX_MATCHED_KEYWORD_METADATA } from "../shared/constants";
import type { KeywordMatch, MatchedKeyword } from "../types/monitor";

export type FrameScanOutcome =
  | {
      status: "success";
      frameId: number;
      documentId?: string;
      matched: boolean;
      matches: KeywordMatch[];
      scannedAt: number;
      textLength: number;
    }
  | {
      status: "pending";
      frameId: number;
      documentId?: string;
      reason:
        | "injection-failed"
        | "stale-document"
        | "empty-document"
        | "invalid-response";
    }
  | {
      status: "restricted";
      frameId: number;
      documentId?: string;
      reason: "missing-permission" | "unsupported";
    };

export type TabFrameAggregation =
  | {
      status: "complete";
      matched: boolean;
      scannedAt: number;
      scannedFrameCount: number;
      unavailableFrameCount: number;
      textLength: number;
      matchedKeywords: MatchedKeyword[];
      matchingFrameCount: number;
      matchedFrameIds: number[];
      matchedFrames: Array<{ frameId: number; documentId?: string }>;
      totalDiscoveredFrameCount: number;
      pendingFrameCount: number;
      restrictedFrameCount: number;
      conclusive: true;
    }
  | {
      status: "partial";
      matched: boolean | null;
      scannedAt: number;
      scannedFrameCount: number;
      unavailableFrameCount: number;
      textLength: number;
      matchedKeywords: MatchedKeyword[];
      matchingFrameCount: number;
      matchedFrameIds: number[];
      matchedFrames: Array<{ frameId: number; documentId?: string }>;
      totalDiscoveredFrameCount: number;
      pendingFrameCount: number;
      restrictedFrameCount: number;
      conclusive: boolean;
    };

export function aggregateFrameScans(
  outcomes: FrameScanOutcome[],
  fallbackTime: number
): TabFrameAggregation {
  const successful = outcomes.filter(
    (outcome): outcome is Extract<
      FrameScanOutcome,
      { status: "success" }
    > => outcome.status === "success"
  );
  const unavailableFrameCount = outcomes.length - successful.length;
  const restrictedFrameCount = outcomes.filter(
    (outcome) => outcome.status === "restricted"
  ).length;
  const pendingFrameCount = outcomes.filter(
    (outcome) => outcome.status === "pending"
  ).length;
  const scannedAt = successful.reduce(
    (latest, outcome) => Math.max(latest, outcome.scannedAt),
    fallbackTime
  );
  const textLength = successful.reduce(
    (total, outcome) => total + outcome.textLength,
    0
  );
  const matchingFrames = successful.filter((outcome) => outcome.matched);
  const matchedKeywordIds = new Set<string>();
  for (const outcome of matchingFrames) {
    for (const match of outcome.matches) {
      if (match.matched) matchedKeywordIds.add(match.keywordId);
    }
  }
  const catalog = successful[0]?.matches ?? [];
  const matchedKeywords: MatchedKeyword[] = catalog
    .filter((match) => matchedKeywordIds.has(match.keywordId))
    .slice(0, MAX_MATCHED_KEYWORD_METADATA)
    .map((match) => ({ id: match.keywordId, value: match.keyword }));

  if (matchingFrames.length > 0) {
    return {
      status: pendingFrameCount > 0 ? "partial" : "complete",
      matched: true,
      scannedAt,
      scannedFrameCount: successful.length,
      unavailableFrameCount,
      textLength,
      matchedKeywords,
      matchingFrameCount: matchingFrames.length,
      matchedFrameIds: matchingFrames.map((frame) => frame.frameId),
      matchedFrames: matchingFrames.map((frame) => ({
        frameId: frame.frameId,
        ...(frame.documentId ? { documentId: frame.documentId } : {})
      })),
      totalDiscoveredFrameCount: outcomes.length,
      pendingFrameCount,
      restrictedFrameCount,
      conclusive: true
    };
  }
  if (pendingFrameCount > 0 || successful.length === 0) {
    return {
      status: "partial",
      matched: null,
      scannedAt,
      scannedFrameCount: successful.length,
      unavailableFrameCount,
      textLength,
      matchedKeywords: [],
      matchingFrameCount: 0,
      matchedFrameIds: [],
      matchedFrames: [],
      totalDiscoveredFrameCount: outcomes.length,
      pendingFrameCount,
      restrictedFrameCount,
      conclusive: false
    };
  }
  return {
    status: "complete",
    matched: false,
    scannedAt,
    scannedFrameCount: successful.length,
    unavailableFrameCount,
    textLength,
    matchedKeywords: [],
    matchingFrameCount: 0,
    matchedFrameIds: [],
    matchedFrames: [],
    totalDiscoveredFrameCount: outcomes.length,
    pendingFrameCount: 0,
    restrictedFrameCount,
    conclusive: true
  };
}
