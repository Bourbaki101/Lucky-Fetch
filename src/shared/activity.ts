import type { ActivityEntry, TabMonitor } from "../types/monitor";

function hostnameFor(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

export function getRemainingReloadMs(
  entry: Pick<ActivityEntry, "reloadActive" | "nextReloadAt">,
  now = Date.now()
): number | null {
  return entry.reloadActive && entry.nextReloadAt !== null
    ? Math.max(0, entry.nextReloadAt - now)
    : null;
}

export function getActiveLuckyFetchTabs(
  monitors: Iterable<TabMonitor>
): ActivityEntry[] {
  const entries: ActivityEntry[] = [];
  for (const monitor of monitors) {
    const reloadActive =
      monitor.status === "running" &&
      monitor.nextReloadAt !== null &&
      Number.isFinite(monitor.nextReloadAt);
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
      nextReloadAt: reloadActive ? monitor.nextReloadAt : null,
      keywords: monitor.keywordMonitoring.keywords.map((keyword) => keyword.value),
      monitorStatus: monitor.status,
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
