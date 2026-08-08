import { TRIGGER_FOCUS_COOLDOWN_MS } from "../shared/constants";
import type {
  AutoOpenResultMode,
  BringToFrontMode
} from "../types/monitor";

export type TriggerTransitionKind = "found" | "missing";

export interface ResultSignatureInput {
  keywordId: string;
  tabId: number;
  pageUrl: string;
  frameId: number;
  frameUrl: string;
  matchedText: string;
  resultIdentifierHash: string;
  rowTextHash: string;
  linkUrl: string;
}

function stableHash(value: string): string {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

export function buildResultSignature(input: ResultSignatureInput): string {
  return `result-${stableHash([
    input.keywordId,
    String(input.tabId),
    input.pageUrl,
    String(input.frameId),
    input.frameUrl,
    input.matchedText,
    input.resultIdentifierHash,
    input.rowTextHash,
    input.linkUrl
  ].join("\u001f"))}`;
}

export function transitionKind(
  previousState: boolean | null,
  currentState: boolean
): TriggerTransitionKind | null {
  if (previousState === null || previousState === currentState) return null;
  return currentState ? "found" : "missing";
}

export function focusModeIncludesTransition(
  mode: BringToFrontMode,
  transition: TriggerTransitionKind
): boolean {
  return mode === "all" || mode === transition;
}

export function autoOpenNeedsClick(mode: AutoOpenResultMode): boolean {
  return mode === "click" || mode === "click-and-focus";
}

export function autoOpenNeedsFocus(mode: AutoOpenResultMode): boolean {
  return mode === "click-and-focus";
}

export function focusCooldownActive(
  lastFocusAt: number | null,
  now: number,
  cooldownMs = TRIGGER_FOCUS_COOLDOWN_MS
): boolean {
  return lastFocusAt !== null && now - lastFocusAt < cooldownMs;
}

export function selectUnambiguousResult<T extends { signature: string }>(
  candidates: readonly T[],
  lastActionResultSignature: string | null
): { selected: T | null; reason: "ambiguous" | "duplicate" | "none" | null } {
  if (candidates.length === 0) return { selected: null, reason: "none" };
  const unseen = candidates.filter(
    (candidate) => candidate.signature !== lastActionResultSignature
  );
  if (unseen.length === 1) return { selected: unseen[0]!, reason: null };
  if (unseen.length === 0) return { selected: null, reason: "duplicate" };
  return { selected: null, reason: "ambiguous" };
}
