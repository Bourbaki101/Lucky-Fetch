import { MAX_KEYWORD_LENGTH, MAX_QUICK_TRIGGERS } from "./constants";

export function normalizeQuickTriggers(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const candidate of value) {
    if (typeof candidate !== "string") continue;
    const trigger = candidate.trim().slice(0, MAX_KEYWORD_LENGTH);
    const key = trigger.toLocaleLowerCase();
    if (!trigger || seen.has(key)) continue;
    seen.add(key);
    normalized.push(trigger);
    if (normalized.length === MAX_QUICK_TRIGGERS) break;
  }
  return normalized;
}

export function addQuickTrigger(
  current: readonly string[],
  value: string
): string[] {
  const normalized = normalizeQuickTriggers(current);
  const trigger = value.trim().slice(0, MAX_KEYWORD_LENGTH);
  if (!trigger) return normalized;
  if (normalized.some((item) => item.toLocaleLowerCase() === trigger.toLocaleLowerCase())) {
    return normalized;
  }
  return normalizeQuickTriggers([...normalized, trigger]);
}

export function removeQuickTrigger(
  current: readonly string[],
  value: string
): string[] {
  const key = value.trim().toLocaleLowerCase();
  return normalizeQuickTriggers(current).filter(
    (item) => item.toLocaleLowerCase() !== key
  );
}
