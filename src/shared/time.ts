import {
  MAX_INTERVAL_MS,
  MIN_INTERVAL_MS
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
      error: "Phase 1 supports intervals of 30 seconds or longer."
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
  return nextReloadAt === null ? null : Math.max(0, nextReloadAt - now);
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.ceil(hours / 24)}d`;
}

export function formatCountdown(ms: number | null): string {
  if (ms === null) return "—";
  const totalSeconds = Math.max(0, Math.ceil(ms / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
