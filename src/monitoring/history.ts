import { DETECTION_HISTORY_LIMIT } from "../shared/constants";
import type { DetectionHistoryEntry } from "../types/monitor";

export function addDetectionHistory(
  history: readonly DetectionHistoryEntry[],
  entry: DetectionHistoryEntry,
  limit = DETECTION_HISTORY_LIMIT
): DetectionHistoryEntry[] {
  if (history.some((candidate) => candidate.id === entry.id)) {
    return [...history];
  }
  return [entry, ...history]
    .sort((left, right) => right.detectedAt - left.detectedAt)
    .slice(0, Math.max(0, limit));
}

export function clearDetectionHistory(): DetectionHistoryEntry[] {
  return [];
}
