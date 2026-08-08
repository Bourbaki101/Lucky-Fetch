import type {
  KeywordMonitorMode,
  KeywordMonitoringRuntime
} from "../types/monitor";

export interface TransitionEvaluation {
  detected: boolean;
  previousState: boolean | null;
  currentState: boolean;
}

export function evaluateKeywordTransition(
  mode: KeywordMonitorMode,
  previousState: boolean | null,
  currentState: boolean
): TransitionEvaluation {
  const detected =
    (mode === "found"
      ? previousState !== true && currentState === true
      : previousState === true && currentState === false);
  return { detected, previousState, currentState };
}

export function resetKeywordBaseline(
  runtime: KeywordMonitoringRuntime
): KeywordMonitoringRuntime {
  return {
    ...runtime,
    lastMatchState: null,
    lastScanAt: null,
    lastConfirmedAt: null,
    lastDetectionAt: null,
    lastScanStatus: "idle",
    lastError: null,
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
