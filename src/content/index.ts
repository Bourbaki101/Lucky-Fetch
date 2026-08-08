import type {
  ContentRequest,
  PageContentResponse
} from "../messaging/contracts";
import {
  isPageContentRequest,
  matchContentText
} from "./scanner";
import {
  clearOwnedHighlights,
  highlightDocument
} from "./highlighting";
import type { InteractionEvent } from "../types/monitor";

declare global {
  interface Window {
    __luckyFetchInteractionDetector?: boolean;
    __luckyFetchContentScript?: {
      listenerReady: boolean;
      initializedAt: number;
    };
  }
}

console.info("[content:init]", {
  pageUrl: window.location.href,
  existingReady: window.__luckyFetchContentScript?.listenerReady === true
});

if (!window.__luckyFetchContentScript?.listenerReady) {
  window.__luckyFetchContentScript = {
    listenerReady: false,
    initializedAt: Date.now()
  };
  window.__luckyFetchInteractionDetector = true;

  chrome.runtime.onMessage.addListener(
    (
      request: unknown,
      _sender,
      sendResponse: (response: PageContentResponse) => void
    ) => {
      if (!isPageContentRequest(request)) return false;
      if (request.type === "content:ping") {
        sendResponse({
          ok: true,
          ready: true,
          pageUrl: window.location.href
        });
        return false;
      }
      if (request.type === "content:clear-highlights") {
        sendResponse({ ok: true, cleared: clearOwnedHighlights() });
        return false;
      }
      if (request.type === "content:highlight-matches") {
        const result = highlightDocument(
          0,
          request.keywords,
          request.caseSensitive
        );
        if (result.error && result.error.code !== "HIGHLIGHT_LIMIT_REACHED") {
          sendResponse({
            ok: false,
            generation: request.generation,
            error: result.error
          });
        } else {
          sendResponse({
            ok: true,
            generation: request.generation,
            result
          });
        }
        return false;
      }

      console.info("[scan:request]", {
        generation: request.generation,
        keywordCount: request.keywords.length,
        caseSensitive: request.caseSensitive
      });

      if (!document.body) {
        const response: PageContentResponse = {
          ok: false,
          generation: request.generation,
          error: {
            code: "EMPTY_DOCUMENT",
            message: "The page does not have a readable document body.",
            occurredAt: Date.now(),
            recoverable: true
          }
        };
        sendResponse(response);
        console.info("[scan:response]", {
          generation: request.generation,
          ok: false,
          code: "EMPTY_DOCUMENT"
        });
        return false;
      }

      try {
        const match = matchContentText(
          document.body.innerText,
          request.keywords,
          request.caseSensitive
        );
        const response: PageContentResponse = {
          ok: true,
          generation: request.generation,
          result: {
            matched: match.matched,
            matchedKeywords: match.matches
              .filter((candidate) => candidate.matched)
              .map((candidate) => ({
                id: candidate.keywordId,
                value: candidate.keyword
              })),
            matchingFrameCount: match.matched ? 1 : 0,
            scannedAt: Date.now(),
            pageTitle: document.title,
            pageUrl: window.location.href,
            textLength: match.normalizedTextLength
          }
        };
        sendResponse(response);
        console.info("[scan:response]", {
          generation: request.generation,
          ok: true,
          matched: match.matched,
          textLength: match.normalizedTextLength
        });
      } catch (error) {
        const response: PageContentResponse = {
          ok: false,
          generation: request.generation,
          error: {
            code: "INVALID_CONFIGURATION",
            message: error instanceof Error ? error.message : String(error),
            occurredAt: Date.now(),
            recoverable: true
          }
        };
        sendResponse(response);
        console.info("[scan:response]", {
          generation: request.generation,
          ok: false,
          code: "INVALID_CONFIGURATION"
        });
      }
      return false;
    }
  );
  window.__luckyFetchContentScript.listenerReady = true;
  console.info("[content:listener-ready]", {
    pageUrl: window.location.href,
    initializedAt: window.__luckyFetchContentScript.initializedAt
  });

  let communicationErrorLogged = false;
  const sendToBackground = (message: ContentRequest): void => {
    void chrome.runtime.sendMessage(message).catch((error: unknown) => {
      if (communicationErrorLogged) return;
      communicationErrorLogged = true;
      console.warn(
        "[content:message] Background worker is unavailable; interaction updates may be delayed.",
        error
      );
    });
  };

  const send = (event: InteractionEvent): void => {
    const message: ContentRequest = {
      type: "content:interaction",
      event
    };
    sendToBackground(message);
  };

  let pendingInteraction: InteractionEvent | null = null;
  let interactionTimer: number | null = null;
  const flushInteraction = (): void => {
    const latest = pendingInteraction;
    pendingInteraction = null;
    if (latest) {
      send(latest);
      interactionTimer = window.setTimeout(flushInteraction, 150);
    } else {
      interactionTimer = null;
    }
  };
  const queueInteraction = (event: InteractionEvent): void => {
    if (interactionTimer === null) {
      send(event);
      interactionTimer = window.setTimeout(flushInteraction, 150);
      return;
    }
    pendingInteraction = event;
  };

  const isEditable = (target: EventTarget | null): boolean => {
    if (!(target instanceof Element)) return false;
    return (
      target.matches("input, textarea, select, [contenteditable='true']") ||
      target.closest("input, textarea, select, [contenteditable='true']") !==
        null
    );
  };

  const report = (
    kind: InteractionEvent["kind"],
    activeTyping = false
  ): void => {
    queueInteraction({
      kind,
      occurredAt: Date.now(),
      activeTyping
    });
  };

  let lastScrollReport = 0;
  document.addEventListener(
    "pointerdown",
    () => report("pointer"),
    { capture: true, passive: true }
  );
  document.addEventListener(
    "keydown",
    (event) => {
      if (!isEditable(event.target)) report("keyboard");
    },
    { capture: true }
  );
  document.addEventListener(
    "input",
    (event) => report("input", isEditable(event.target)),
    { capture: true }
  );
  document.addEventListener(
    "focusin",
    (event) => {
      if (isEditable(event.target)) report("editable-focus");
    },
    { capture: true }
  );
  document.addEventListener(
    "scroll",
    () => {
      const now = Date.now();
      if (now - lastScrollReport >= 500) {
        lastScrollReport = now;
        report("scroll");
      }
    },
    { capture: true, passive: true }
  );

  const ready: ContentRequest = {
    type: "content:ready",
    pageTitle: document.title,
    pageUrl: window.location.href
  };
  sendToBackground(ready);
} else {
  console.info("[content:listener-ready]", {
    pageUrl: window.location.href,
    reused: true
  });
}
