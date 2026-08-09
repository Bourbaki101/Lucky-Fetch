import type { TabMonitor } from "../types/monitor";

export interface RecoveryTab {
  id: number;
  url: string;
}

export interface RecoveryPlan {
  keep: TabMonitor[];
  removeTabIds: number[];
  scheduleTabIds: number[];
  clearAlarmTabIds: number[];
}

const VALID_STATUSES = new Set(["running", "paused", "stopped", "completed", "error"]);

export function isPlausibleMonitor(value: unknown): value is TabMonitor {
  if (!value || typeof value !== "object") return false;
  const monitor = value as Partial<TabMonitor>;
  return (
    Number.isInteger(monitor.tabId) &&
    (monitor.tabId ?? -1) >= 0 &&
    typeof monitor.pageUrl === "string" &&
    typeof monitor.pageTitle === "string" &&
    Number.isFinite(monitor.intervalMs) &&
    (monitor.intervalMs ?? 0) >= 30_000 &&
    (monitor.nextReloadAt === null ||
      (typeof monitor.nextReloadAt === "number" &&
        Number.isFinite(monitor.nextReloadAt))) &&
    VALID_STATUSES.has(monitor.status ?? "")
  );
}

export function planRecovery(
  monitors: unknown[],
  tabs: RecoveryTab[],
  alarmTabIds: number[]
): RecoveryPlan {
  const tabsById = new Map(tabs.map((tab) => [tab.id, tab]));
  const keep: TabMonitor[] = [];
  const removeTabIds: number[] = [];
  const scheduleTabIds: number[] = [];

  for (const monitor of monitors) {
    if (!isPlausibleMonitor(monitor)) {
      const invalidTabId =
        monitor && typeof monitor === "object"
          ? Number((monitor as Partial<TabMonitor>).tabId)
          : -1;
      if (Number.isInteger(invalidTabId) && invalidTabId >= 0) {
        removeTabIds.push(invalidTabId);
      }
      continue;
    }
    const tab = tabsById.get(monitor.tabId);
    if (!tab) {
      removeTabIds.push(monitor.tabId);
      continue;
    }
    keep.push(monitor);
    if (monitor.status === "running" && monitor.nextReloadAt !== null) {
      scheduleTabIds.push(monitor.tabId);
    }
  }

  const keptIds = new Set(keep.map((monitor) => monitor.tabId));
  const scheduleSet = new Set(scheduleTabIds);
  const clearAlarmTabIds = alarmTabIds.filter(
    (tabId) =>
      !keptIds.has(tabId) ||
      !scheduleSet.has(tabId)
  );

  return { keep, removeTabIds, scheduleTabIds, clearAlarmTabIds };
}
