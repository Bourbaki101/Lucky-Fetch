import {
  MAX_INTERVAL_MS,
  MIN_INTERVAL_MS,
  MONITOR_DELAY_RELOAD_RATIO
} from "./constants";
import type { IntervalUnit } from "../types/monitor";

const UNIT_MULTIPLIERS: Record<IntervalUnit, number> = {
  seconds: 1_000,
  minutes: 60_000,
  hours: 3_600_000
};

export interface ValidationResult {
  valid: boolean;
  intervalMs: number | null;
  error: string | null;
}

export function intervalToMs(value: number, unit: IntervalUnit): number {
  return value * UNIT_MULTIPLIERS[unit];
}

export function normalizeIntervalMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return MIN_INTERVAL_MS;
  }
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, value));
}

export function getMaxMonitorDelay(intervalMs: number): number {
  const effectiveIntervalSeconds = normalizeIntervalMs(intervalMs) / 1_000;
  return Math.floor(
    effectiveIntervalSeconds * MONITOR_DELAY_RELOAD_RATIO
  ) * 1_000;
}

function formatSeconds(ms: number): string {
  const seconds = ms / 1_000;
  return Number.isInteger(seconds) ? String(seconds) : String(Number(seconds.toFixed(3)));
}

export function validateMonitorDelayForReload(
  intervalMs: number,
  monitorDelayMs: number,
  monitorEnabled: boolean
): string | null {
  if (!monitorEnabled) return null;
  const maximumMs = getMaxMonitorDelay(intervalMs);
  if (!Number.isFinite(monitorDelayMs) || monitorDelayMs > maximumMs) {
    return `Monitor delay must be ${formatSeconds(maximumMs)} seconds or less with a ${formatSeconds(normalizeIntervalMs(intervalMs))}-second reload interval.`;
  }
  return null;
}

export function validateInterval(
  rawValue: string | number,
  unit: IntervalUnit
): ValidationResult {
  const value =
    typeof rawValue === "number" ? rawValue : Number(rawValue.trim());

  if (!Number.isFinite(value)) {
    return { valid: false, intervalMs: null, error: "Enter a valid number." };
  }
  if (value <= 0) {
    return {
      valid: false,
      intervalMs: null,
      error: "The interval must be greater than zero."
    };
  }

  const intervalMs = intervalToMs(value, unit);
  if (intervalMs < MIN_INTERVAL_MS) {
    return {
      valid: false,
      intervalMs: null,
      error: "Minimum reload interval is 10 seconds."
    };
  }
  if (intervalMs > MAX_INTERVAL_MS) {
    return {
      valid: false,
      intervalMs: null,
      error: "Choose an interval of 30 days or less."
    };
  }

  return { valid: true, intervalMs, error: null };
}

export function remainingMs(
  nextReloadAt: number | null,
  now = Date.now()
): number | null {
  return nextReloadAt === null || !Number.isFinite(nextReloadAt)
    ? null
    : Math.max(0, nextReloadAt - now);
}

export function remainingReloadMs(
  nextReloadAt: number | null,
  intervalMs: number,
  now = Date.now()
): number | null {
  const remaining = remainingMs(nextReloadAt, now);
  if (remaining === null) return null;
  const maximumRemaining = normalizeIntervalMs(intervalMs) + 1_000;
  return remaining <= maximumRemaining ? remaining : null;
}

export function hasPlausibleReloadDeadline(
  nextReloadAt: number | null,
  intervalMs: number,
  now = Date.now()
): boolean {
  return remainingReloadMs(nextReloadAt, intervalMs, now) !== null;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "0s";
  const seconds = Math.max(0, Math.ceil(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.ceil(hours / 24)}d`;
}

export function formatCountdown(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  const totalSeconds = Math.max(0, Math.ceil(ms / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
