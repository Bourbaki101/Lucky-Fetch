import { describe, expect, it } from "vitest";
import {
  matchVisibleText,
  matchAnyKeyword,
  normalizeVisibleText,
  validateKeyword,
  validateKeywordConfig
} from "../src/monitoring/matching";

describe("visible-text keyword matching", () => {
  it("finds a case-insensitive keyword", () => {
    expect(matchVisibleText("A New TICKET arrived", "new ticket", false).matched)
      .toBe(true);
  });

  it("reports a case-insensitive keyword as absent", () => {
    expect(matchVisibleText("No work is queued", "new ticket", false).matched)
      .toBe(false);
  });

  it("supports case-sensitive matches", () => {
    expect(matchVisibleText("New Ticket", "New Ticket", true).matched).toBe(true);
  });

  it("rejects a case-sensitive mismatch", () => {
    expect(matchVisibleText("New Ticket", "new ticket", true).matched).toBe(false);
  });

  it("matches multi-word phrases", () => {
    expect(
      matchVisibleText("There are no appointments available today", "appointments available", false)
        .matched
    ).toBe(true);
  });

  it("matches Unicode text", () => {
    expect(matchVisibleText("Próxima cita: mañana ☕", "MAÑANA ☕", false).matched)
      .toBe(true);
  });

  it("rejects empty and whitespace-only keywords", () => {
    expect(validateKeyword("")).not.toBeNull();
    expect(validateKeyword(" \r\n\t ")).not.toBeNull();
    expect(() => matchVisibleText("anything", "  ", false)).toThrow();
  });

  it("normalizes line endings and repeated whitespace", () => {
    expect(normalizeVisibleText(" New\r\n  Ticket\tready ")).toBe(
      "New Ticket ready"
    );
    expect(
      matchVisibleText("New\r\n  Ticket ready", "New Ticket", false).matched
    ).toBe(true);
  });

  it("matches any configured keyword and returns compact metadata", () => {
    expect(
      matchAnyKeyword(
        "An Escalated urgent ticket",
        [
          { id: "new", value: "New Ticket" },
          { id: "escalated", value: "Escalated" },
          { id: "urgent", value: "Urgent" }
        ],
        false
      ).matches.filter((match) => match.matched)
    ).toMatchObject([
      { keywordId: "escalated", keyword: "Escalated" },
      { keywordId: "urgent", keyword: "Urgent" }
    ]);
  });

  it("rejects duplicates using the active case-sensitivity rule", () => {
    const base = {
      enabled: true,
      keywords: [
        { id: "one", value: "Urgent" },
        { id: "two", value: "urgent" }
      ],
      mode: "found" as const,
      caseSensitive: false,
      scanDelayMs: 0,
      actionOnDetection: "continue" as const,
      highlightMatches: false,
      notificationMessage: "",
      bringToFront: "never" as const,
      autoOpenResult: "off" as const
    };
    expect(validateKeywordConfig(base)).toContain("Duplicate");
    expect(validateKeywordConfig({ ...base, caseSensitive: true })).toBeNull();
  });
});
