import type {
  FrameHighlightResult,
  KeywordRule,
  TypedHighlightError
} from "../types/monitor";

const CONTENT_MAX_HIGHLIGHTS_PER_FRAME = 500;
const CONTENT_MAX_HIGHLIGHT_TEXT_NODES = 20_000;

export const HIGHLIGHT_ATTRIBUTE = "data-tab-monitor-highlight";
export const HIGHLIGHT_CLASS = "luckyfetch-keyword-highlight";

function highlightError(
  code: TypedHighlightError["code"],
  message: string
): TypedHighlightError {
  return {
    code,
    message,
    occurredAt: Date.now(),
    recoverable: true
  };
}

export function clearOwnedHighlights(root: ParentNode = document): number {
  const marks = Array.from(
    root.querySelectorAll<HTMLElement>(`mark[${HIGHLIGHT_ATTRIBUTE}="true"]`)
  );
  const parents = new Set<Node>();
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    parents.add(parent);
    mark.replaceWith(document.createTextNode(mark.textContent ?? ""));
  }
  for (const parent of parents) parent.normalize();
  return marks.length;
}

function isSafeTextNode(node: Text): boolean {
  const parent = node.parentElement;
  if (!parent || !node.data) return false;
  if (
    parent.closest(
      [
        "script",
        "style",
        "noscript",
        "textarea",
        "input",
        "select",
        "option",
        "[contenteditable]",
        `[${HIGHLIGHT_ATTRIBUTE}="true"]`,
        "[data-luckyfetch-ui]"
      ].join(",")
    )
  ) {
    return false;
  }
  const selection = document.getSelection();
  if (selection && !selection.isCollapsed) {
    for (let index = 0; index < selection.rangeCount; index += 1) {
      try {
        if (selection.getRangeAt(index).intersectsNode(node)) return false;
      } catch {
        // A stale selection should not block safe highlighting elsewhere.
      }
    }
  }
  const style = getComputedStyle(parent);
  return (
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    style.visibility !== "collapse"
  );
}

interface TextMatch {
  start: number;
  end: number;
  keyword: KeywordRule;
}

function findNonOverlappingMatches(
  text: string,
  keywords: readonly KeywordRule[],
  caseSensitive: boolean
): TextMatch[] {
  const sorted = [...keywords].sort(
    (left, right) => right.value.length - left.value.length
  );
  const occupied = new Uint8Array(text.length);
  const matches: TextMatch[] = [];
  for (const keyword of sorted) {
    const needle = caseSensitive
      ? keyword.value
      : keyword.value.toLowerCase();
    const haystack = caseSensitive ? text : text.toLowerCase();
    let from = 0;
    while (needle.length > 0) {
      const start = haystack.indexOf(needle, from);
      if (start < 0) break;
      const end = start + needle.length;
      let overlaps = false;
      for (let index = start; index < end; index += 1) {
        if (occupied[index]) {
          overlaps = true;
          break;
        }
      }
      if (!overlaps) {
        occupied.fill(1, start, end);
        matches.push({ start, end, keyword });
      }
      from = start + Math.max(1, needle.length);
    }
  }
  return matches.sort((left, right) => left.start - right.start);
}

function wrapTextNode(node: Text, matches: readonly TextMatch[]): number {
  if (matches.length === 0 || !node.parentNode) return 0;
  const fragment = document.createDocumentFragment();
  let offset = 0;
  for (const match of matches) {
    if (match.start > offset) {
      fragment.append(node.data.slice(offset, match.start));
    }
    const mark = document.createElement("mark");
    mark.setAttribute(HIGHLIGHT_ATTRIBUTE, "true");
    mark.setAttribute("data-keyword-id", match.keyword.id);
    mark.className = HIGHLIGHT_CLASS;
    mark.style.background = "#ffe58f";
    mark.style.color = "#1f2937";
    mark.style.outline = "1px solid #d6a600";
    mark.style.borderRadius = "2px";
    mark.style.padding = "0";
    mark.textContent = node.data.slice(match.start, match.end);
    fragment.append(mark);
    offset = match.end;
  }
  if (offset < node.data.length) fragment.append(node.data.slice(offset));
  node.replaceWith(fragment);
  return matches.length;
}

export function highlightDocument(
  frameId: number,
  keywords: readonly KeywordRule[],
  caseSensitive: boolean
): FrameHighlightResult {
  clearOwnedHighlights();
  if (
    !["text/html", "application/xhtml+xml"].includes(document.contentType)
  ) {
    return {
      frameId,
      highlightedOccurrenceCount: 0,
      truncated: false,
      error: highlightError(
        "UNSUPPORTED_DOCUMENT",
        "This document type does not support safe highlighting."
      )
    };
  }
  if (!document.body) {
    return {
      frameId,
      highlightedOccurrenceCount: 0,
      truncated: false,
      error: highlightError("DOM_UNAVAILABLE", "The frame DOM is unavailable.")
    };
  }

  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT
  );
  const nodes: Text[] = [];
  let current: Node | null = null;
  while (
    nodes.length < CONTENT_MAX_HIGHLIGHT_TEXT_NODES &&
    (current = walker.nextNode())
  ) {
    if (current instanceof Text && isSafeTextNode(current)) nodes.push(current);
  }
  let highlightedOccurrenceCount = 0;
  let truncated = current !== null;
  for (const node of nodes) {
    const remaining =
      CONTENT_MAX_HIGHLIGHTS_PER_FRAME - highlightedOccurrenceCount;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const matches = findNonOverlappingMatches(
      node.data,
      keywords,
      caseSensitive
    );
    if (matches.length > remaining) truncated = true;
    highlightedOccurrenceCount += wrapTextNode(node, matches.slice(0, remaining));
  }
  return {
    frameId,
    highlightedOccurrenceCount,
    truncated,
    ...(truncated
      ? {
          error: highlightError(
            "HIGHLIGHT_LIMIT_REACHED",
            `Highlighting stopped at ${CONTENT_MAX_HIGHLIGHTS_PER_FRAME} occurrences or ${CONTENT_MAX_HIGHLIGHT_TEXT_NODES} text nodes.`
          )
        }
      : {})
  };
}
