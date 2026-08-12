import type { ActivityEntry, TabMonitor } from "../types/monitor";
import { remainingReloadMs } from "./time";

function hostnameFor(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

export function getRemainingReloadMs(
  entry: Pick<ActivityEntry, "reloadActive" | "intervalMs" | "nextReloadAt">,
  now = Date.now()
): number | null {
  return entry.reloadActive && entry.nextReloadAt !== null
    ? remainingReloadMs(entry.nextReloadAt, entry.intervalMs, now)
    : null;
}

export function getActiveLuckyFetchTabs(
  monitors: Iterable<TabMonitor>,
  now = Date.now()
): ActivityEntry[] {
  const entries: ActivityEntry[] = [];
  for (const monitor of monitors) {
    const reloadActive =
      monitor.status === "running" &&
      monitor.nextReloadAt !== null &&
      remainingReloadMs(
        monitor.nextReloadAt,
        monitor.intervalMs,
        now
      ) !== null;
    const monitorActive =
      monitor.status === "running" && monitor.keywordMonitoring.enabled;
    const latestDetection = monitor.detectionHistory[0] ?? null;
    const needsAttention =
      latestDetection !== null &&
      monitor.keywordRuntime.lastDetectionAt === latestDetection.detectedAt;
    if (!reloadActive && !monitorActive && !needsAttention) continue;

    const attentionKeyword = latestDetection?.matchedKeywords
      ?.map((keyword) => keyword.value)
      .join(", ") || latestDetection?.keyword || null;
    entries.push({
      tabId: monitor.tabId,
      pageTitle: monitor.pageTitle,
      pageUrl: monitor.pageUrl,
      hostname: hostnameFor(monitor.pageUrl),
      reloadActive,
      monitorActive,
      intervalMs: monitor.intervalMs,
      nextReloadAt: reloadActive ? monitor.nextReloadAt : null,
      keywords: monitor.keywordMonitoring.keywords.map((keyword) => keyword.value),
      monitorStatus: monitor.status,
      profileId: monitor.profileId,
      profileName: monitor.profileName,
      monitorState: monitor.keywordRuntime.lastMatchState,
      needsAttention,
      attentionLabel:
        needsAttention && latestDetection
          ? `${latestDetection.mode === "found" ? "Found" : "Lost"}: "${attentionKeyword ?? "configured keyword"}"`
          : null
    });
  }
  return entries.sort((left, right) => {
    if (left.needsAttention !== right.needsAttention) {
      return left.needsAttention ? -1 : 1;
    }
    return left.pageTitle.localeCompare(right.pageTitle);
  });
}
