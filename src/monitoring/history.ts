import {
  DETECTION_HISTORY_LIMIT,
  NOTIFICATION_HISTORY_LIMIT
} from "../shared/constants";
import type {
  DetectionHistoryEntry,
  NotificationHistoryEntry
} from "../types/monitor";

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

export function addNotificationHistory(
  history: readonly NotificationHistoryEntry[],
  entry: NotificationHistoryEntry,
  limit = NOTIFICATION_HISTORY_LIMIT
): NotificationHistoryEntry[] {
  if (history.some((candidate) => candidate.id === entry.id)) {
    return [...history];
  }
  return [entry, ...history]
    .sort((left, right) => right.timestamp - left.timestamp)
    .slice(0, Math.max(0, limit));
}

export function clearNotificationHistory(): NotificationHistoryEntry[] {
  return [];
}
