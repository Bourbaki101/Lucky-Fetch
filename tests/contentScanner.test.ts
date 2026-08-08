import { describe, expect, it } from "vitest";
import {
  isPageContentRequest,
  matchContentText
} from "../src/content/scanner";

describe("content scanner entry dependencies", () => {
  it("accepts the readiness ping and typed scan request", () => {
    expect(isPageContentRequest({ type: "content:ping" })).toBe(true);
    expect(
      isPageContentRequest({
        type: "content:scan-page",
        keywords: [{ id: "one", value: "New Ticket" }],
        caseSensitive: false,
        generation: 2
      })
    ).toBe(true);
  });

  it("rejects malformed requests", () => {
    expect(isPageContentRequest({ type: "content:scan-page" })).toBe(false);
    expect(isPageContentRequest({ type: "unknown" })).toBe(false);
  });

  it("matches locally with whitespace normalization", () => {
    expect(
      matchContentText(
        "A\n  New\tTicket is ready",
        [{ id: "one", value: "new ticket" }],
        false
      )
    ).toEqual({
      matched: true,
      matches: [
        {
          keywordId: "one",
          keyword: "new ticket",
          matched: true,
          occurrenceCount: 1
        }
      ],
      normalizedTextLength: 21
    });
  });

  it("rejects an empty keyword", () => {
    expect(() =>
      matchContentText(
        "Visible page",
        [{ id: "one", value: " \n " }],
        false
      )
    ).toThrow(
      "Enter a keyword or phrase."
    );
  });
});
