import type { TabMonitor } from "../types/monitor";
import { formatDuration, remainingMs } from "./time";

export interface BadgePresentation {
  text: string;
  color: string;
  title: string;
}

export function nearestActiveReloadAt(
  monitors: Iterable<TabMonitor>
): number | null {
  let nearest: number | null = null;
  for (const monitor of monitors) {
    if (
      monitor.status !== "running" ||
      monitor.nextReloadAt === null ||
      !Number.isFinite(monitor.nextReloadAt)
    ) {
      continue;
    }
    nearest =
      nearest === null
        ? monitor.nextReloadAt
        : Math.min(nearest, monitor.nextReloadAt);
  }
  return nearest;
}

export function badgeForReloadDeadline(
  nextReloadAt: number,
  now = Date.now()
): BadgePresentation {
  const remaining = Math.max(0, nextReloadAt - now);
  const remainingSeconds = Math.max(0, Math.ceil(remaining / 1_000));
  const duration = formatDuration(remaining);
  return {
    text:
      remainingSeconds <= 999
        ? String(remainingSeconds)
        : duration.slice(0, 4),
    color: "#2563eb",
    title: `Lucky Fetch: next reload in ${duration}`
  };
}

export function badgeForMonitor(
  monitor: TabMonitor | undefined,
  now = Date.now()
): BadgePresentation {
  if (!monitor || monitor.status === "stopped") {
    return { text: "", color: "#59636e", title: "Lucky Fetch" };
  }
  if (monitor.status === "paused") {
    return { text: "Ⅱ", color: "#8a5a00", title: "Lucky Fetch: paused" };
  }
  if (monitor.status === "completed") {
    return {
      text: "✓",
      color: "#177245",
      title: "Lucky Fetch: reload limit completed"
    };
  }
  if (monitor.status === "error") {
    return { text: "!", color: "#b42318", title: "Lucky Fetch: error" };
  }

  const remaining = remainingMs(monitor.nextReloadAt, now);
  return remaining === null
    ? { text: "ON", color: "#2563eb", title: "Lucky Fetch: running" }
    : badgeForReloadDeadline(monitor.nextReloadAt!, now);
}
