import { validateKeywordConfig } from "../monitoring/matching";
import type { KeywordMonitoringConfig, MonitorSettings } from "../types/monitor";
import { MAX_INTERVAL_MS, MIN_INTERVAL_MS } from "./constants";
import { validateMonitorDelayForReload } from "./time";

export function validateMonitorSettings(
  settings: MonitorSettings
): string | null {
  if (
    settings.reloadEnabled !== undefined &&
    typeof settings.reloadEnabled !== "boolean"
  ) {
    return "Reload enabled state is invalid.";
  }
  if (!Number.isFinite(settings.intervalMs)) {
    return "Enter a valid reload interval.";
  }
  if (settings.intervalMs < MIN_INTERVAL_MS) {
    return "Minimum reload interval is 10 seconds.";
  }
  if (settings.intervalMs > MAX_INTERVAL_MS) {
    return "Choose a reload interval of 30 days or less.";
  }
  if (
    settings.maximumReloads !== null &&
    (!Number.isInteger(settings.maximumReloads) ||
      settings.maximumReloads < 1 ||
      settings.maximumReloads > 1_000_000)
  ) {
    return "The maximum reload count must be between 1 and 1,000,000.";
  }
  if (
    !["ignore", "delay", "pause", "stop"].includes(
      settings.interactionBehavior
    )
  ) {
    return "Unknown interaction behavior.";
  }
  if (typeof settings.bypassCache !== "boolean") {
    return "No-cache setting is invalid.";
  }
  if (typeof settings.protectActiveTyping !== "boolean") {
    return "Typing protection setting is invalid.";
  }
  return null;
}

export function validateCombinedConfiguration(
  settings: MonitorSettings,
  keywordMonitoring: KeywordMonitoringConfig
): string | null {
  return (
    validateMonitorSettings(settings) ??
    validateKeywordConfig(keywordMonitoring) ??
    (settings.reloadEnabled === false && !keywordMonitoring.enabled
      ? "Enable Reload or Monitor before starting this setup."
      : null) ??
    validateMonitorDelayForReload(
      settings.intervalMs,
      keywordMonitoring.scanDelayMs,
      settings.reloadEnabled !== false && keywordMonitoring.enabled
    )
  );
}
