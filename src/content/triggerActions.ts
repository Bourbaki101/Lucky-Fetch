import type { KeywordRule } from "../types/monitor";

export interface FrameResolvedMatch {
  matchToken: string;
  clickableToken: string | null;
  keywordId: string;
  matchedText: string;
  frameUrl: string;
  resultIdentifierHash: string;
  rowTextHash: string;
  linkUrl: string;
  clickable: boolean;
  clickSkipReason: "no-safe-target" | "unsafe-target" | null;
}

export interface FrameMatchInspection {
  ok: boolean;
  pageUrl: string;
  matches: FrameResolvedMatch[];
  truncated: boolean;
  error?: string;
}

export interface FrameTriggerActionResult {
  ok: boolean;
  pageUrl: string;
  scrolled: boolean;
  highlighted: boolean;
  clicked: boolean;
  reason?: string;
}

/** Runs in the target frame through chrome.scripting.executeScript. */
export function resolveMatchedElement(
  keywords: KeywordRule[],
  caseSensitive: boolean,
  expectedUrl: string,
  eventToken: string
): FrameMatchInspection {
  const pageUrl = window.location.href;
  if (pageUrl !== expectedUrl || !document.body) {
    return {
      ok: false,
      pageUrl,
      matches: [],
      truncated: false,
      error: pageUrl !== expectedUrl ? "document-changed" : "dom-unavailable"
    };
  }
  const normalize = (value: string): string =>
    value.replace(/\r\n?/gu, "\n").replace(/\s+/gu, " ").trim();
  const compare = (value: string): string =>
    caseSensitive ? normalize(value) : normalize(value).toLowerCase();
  const hash = (value: string): string => {
    let current = 2_166_136_261;
    for (const character of value) {
      current ^= character.codePointAt(0) ?? 0;
      current = Math.imul(current, 16_777_619);
    }
    return (current >>> 0).toString(36);
  };
  const visible = (element: Element): element is HTMLElement => {
    if (!(element instanceof HTMLElement) || !element.isConnected) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.visibility !== "collapse" &&
      rect.width > 0 &&
      rect.height > 0
    );
  };
  const clickableSelector =
    'a[href], button, [role="button"], [onclick], [data-href]';
  const destructive = (element: HTMLElement): boolean => {
    const label = normalize(
      `${element.getAttribute("aria-label") ?? ""} ${element.getAttribute("title") ?? ""} ${element.textContent ?? ""}`
    ).slice(0, 160);
    return /\b(delete|remove|destroy|cancel|close|reject|archive|disable|unsubscribe|purchase|buy|pay|send|submit)\b/iu.test(label);
  };
  const safe = (element: Element): element is HTMLElement => {
    if (!visible(element)) return false;
    if (
      element.matches(":disabled, [disabled], [aria-disabled='true']") ||
      destructive(element)
    ) {
      return false;
    }
    if (element instanceof HTMLButtonElement && element.type === "submit") {
      return false;
    }
    if (element instanceof HTMLAnchorElement) {
      const href = element.getAttribute("href") ?? "";
      if (/^javascript:/iu.test(href) || element.hasAttribute("download")) {
        return false;
      }
    }
    return true;
  };
  const resolveClickable = (
    matched: HTMLElement,
    resultRoot: HTMLElement,
    needle: string
  ): { target: HTMLElement | null; unsafeOnly: boolean } => {
    const direct = matched.matches(clickableSelector) ? matched : null;
    if (direct && safe(direct)) return { target: direct, unsafeOnly: false };

    const descendant = Array.from(
      matched.querySelectorAll<HTMLElement>(clickableSelector)
    );
    const preferredDescendant = descendant.filter(
      (candidate) => safe(candidate) && compare(candidate.innerText).includes(needle)
    );
    if (preferredDescendant.length === 1) {
      return { target: preferredDescendant[0]!, unsafeOnly: false };
    }
    const safeDescendants = descendant.filter(safe);
    if (safeDescendants.length === 1) {
      return { target: safeDescendants[0]!, unsafeOnly: false };
    }

    if (resultRoot.matches("tr, [role='row']")) {
      const rowLinks = Array.from(
        resultRoot.querySelectorAll<HTMLElement>("a[href]")
      ).filter(safe);
      const keywordRowLinks = rowLinks.filter((candidate) =>
        compare(candidate.innerText).includes(needle)
      );
      if (keywordRowLinks.length === 1) {
        return { target: keywordRowLinks[0]!, unsafeOnly: false };
      }
      if (rowLinks.length === 1) {
        return { target: rowLinks[0]!, unsafeOnly: false };
      }
    }

    const ancestor = matched.closest<HTMLElement>(clickableSelector);
    if (ancestor && resultRoot.contains(ancestor) && safe(ancestor)) {
      return { target: ancestor, unsafeOnly: false };
    }

    const rowCandidates = Array.from(
      resultRoot.querySelectorAll<HTMLElement>(clickableSelector)
    );
    const safeRowCandidates = rowCandidates.filter(safe);
    const keywordLinks = safeRowCandidates.filter(
      (candidate) =>
        candidate instanceof HTMLAnchorElement &&
        compare(candidate.innerText).includes(needle)
    );
    if (keywordLinks.length === 1) {
      return { target: keywordLinks[0]!, unsafeOnly: false };
    }
    const links = safeRowCandidates.filter(
      (candidate) => candidate instanceof HTMLAnchorElement
    );
    if (links.length === 1) return { target: links[0]!, unsafeOnly: false };
    if (safeRowCandidates.length === 1) {
      return { target: safeRowCandidates[0]!, unsafeOnly: false };
    }
    return {
      target: null,
      unsafeOnly:
        [...descendant, ...(ancestor ? [ancestor] : []), ...rowCandidates]
          .length > 0
    };
  };

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const results = new Map<HTMLElement, FrameResolvedMatch>();
  let inspected = 0;
  let node: Node | null;
  while ((node = walker.nextNode()) && inspected < 20_000 && results.size < 50) {
    inspected += 1;
    if (!(node instanceof Text) || !node.data.trim()) continue;
    const matched = node.parentElement;
    if (
      !matched ||
      matched.closest(
        "script, style, noscript, textarea, input, select, option, [contenteditable], [data-luckyfetch-ui]"
      ) ||
      !visible(matched)
    ) {
      continue;
    }
    const text = compare(node.data);
    for (const keyword of keywords) {
      const needle = compare(keyword.value);
      if (!needle || !text.includes(needle)) continue;
      const resultRoot =
        matched.closest<HTMLElement>(
          "tr, [role='row'], [data-result-id], [data-ticket-id], li, article, .result, .ticket, .card"
        ) ?? matched;
      const rootText = normalize(resultRoot.innerText).slice(0, 2_000);
      const identifier = normalize(
        resultRoot.getAttribute("data-ticket-id") ??
          resultRoot.getAttribute("data-result-id") ??
          resultRoot.id ??
          ""
      ).slice(0, 300);
      if (results.has(resultRoot)) continue;
      const click = resolveClickable(matched, resultRoot, needle);
      const suffix = `${eventToken}-${results.size}`;
      matched.setAttribute("data-luckyfetch-trigger-match", suffix);
      if (click.target) {
        click.target.setAttribute("data-luckyfetch-trigger-click", suffix);
      }
      const linkUrl =
        click.target instanceof HTMLAnchorElement
          ? click.target.href
          : click.target?.getAttribute("data-href") ?? "";
      results.set(resultRoot, {
        matchToken: suffix,
        clickableToken: click.target ? suffix : null,
        keywordId: keyword.id,
        matchedText: normalize(keyword.value),
        frameUrl: pageUrl,
        resultIdentifierHash: identifier ? hash(identifier) : "",
        rowTextHash: hash(rootText),
        linkUrl,
        clickable: click.target !== null,
        clickSkipReason: click.target
          ? null
          : click.unsafeOnly
            ? "unsafe-target"
            : "no-safe-target"
      });
    }
  }
  return {
    ok: true,
    pageUrl,
    matches: [...results.values()],
    truncated: results.size >= 50 || inspected >= 20_000
  };
}

/** Runs in the target frame through chrome.scripting.executeScript. */
export function scrollAndHighlightMatch(
  expectedUrl: string,
  matchToken: string,
  clickableToken: string | null,
  click: boolean
): FrameTriggerActionResult {
  const pageUrl = window.location.href;
  const cleanup = (): void => {
    for (const element of document.querySelectorAll<HTMLElement>(
      "[data-luckyfetch-trigger-match], [data-luckyfetch-trigger-click]"
    )) {
      element.removeAttribute("data-luckyfetch-trigger-match");
      element.removeAttribute("data-luckyfetch-trigger-click");
    }
  };
  if (pageUrl !== expectedUrl || !document.body) {
    cleanup();
    return {
      ok: false,
      pageUrl,
      scrolled: false,
      highlighted: false,
      clicked: false,
      reason: pageUrl !== expectedUrl ? "document-changed" : "dom-unavailable"
    };
  }
  const escapedMatch = CSS.escape(matchToken);
  const matched = document.querySelector<HTMLElement>(
    `[data-luckyfetch-trigger-match="${escapedMatch}"]`
  );
  if (!matched || !matched.isConnected || matched.ownerDocument !== document) {
    cleanup();
    return {
      ok: false,
      pageUrl,
      scrolled: false,
      highlighted: false,
      clicked: false,
      reason: "matched-element-detached"
    };
  }
  const visible = (element: HTMLElement): boolean => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      element.isConnected &&
      element.ownerDocument === document &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.visibility !== "collapse" &&
      rect.width > 0 &&
      rect.height > 0
    );
  };
  if (!visible(matched)) {
    cleanup();
    return {
      ok: false,
      pageUrl,
      scrolled: false,
      highlighted: false,
      clicked: false,
      reason: "matched-element-hidden"
    };
  }
  matched.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
  matched.animate(
    [
      {
        outline: "3px solid #f59e0b",
        outlineOffset: "2px",
        backgroundColor: "rgba(255, 229, 143, 0.7)"
      },
      {
        outline: "3px solid rgba(245, 158, 11, 0)",
        outlineOffset: "5px",
        backgroundColor: "rgba(255, 229, 143, 0)"
      }
    ],
    { duration: 12_000, easing: "ease-out" }
  );

  let clicked = false;
  let reason: string | undefined;
  if (click) {
    const escapedClick = clickableToken ? CSS.escape(clickableToken) : "";
    const target = escapedClick
      ? document.querySelector<HTMLElement>(
          `[data-luckyfetch-trigger-click="${escapedClick}"]`
        )
      : null;
    const label = `${target?.getAttribute("aria-label") ?? ""} ${target?.getAttribute("title") ?? ""} ${target?.textContent ?? ""}`
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 160);
    const unsafe =
      !target ||
      !visible(target) ||
      target.matches(":disabled, [disabled], [aria-disabled='true']") ||
      /\b(delete|remove|destroy|cancel|close|reject|archive|disable|unsubscribe|purchase|buy|pay|send|submit)\b/iu.test(label) ||
      (target instanceof HTMLButtonElement && target.type === "submit") ||
      (target instanceof HTMLAnchorElement &&
        (/^javascript:/iu.test(target.getAttribute("href") ?? "") ||
          target.hasAttribute("download")));
    if (unsafe) {
      reason = target ? "unsafe-or-unavailable-target" : "no-safe-target";
    } else {
      target.click();
      clicked = true;
    }
  }
  cleanup();
  return {
    ok: !click || clicked,
    pageUrl,
    scrolled: true,
    highlighted: true,
    clicked,
    ...(reason ? { reason } : {})
  };
}

/** Runs in the target frame through chrome.scripting.executeScript. */
export function clearResolvedMatchTokens(): void {
  for (const element of document.querySelectorAll<HTMLElement>(
    "[data-luckyfetch-trigger-match], [data-luckyfetch-trigger-click]"
  )) {
    element.removeAttribute("data-luckyfetch-trigger-match");
    element.removeAttribute("data-luckyfetch-trigger-click");
  }
}
