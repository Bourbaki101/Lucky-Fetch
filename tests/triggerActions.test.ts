import { describe, expect, it } from "vitest";
import {
  autoOpenNeedsClick,
  buildResultSignature,
  focusCooldownActive,
  focusModeIncludesTransition,
  selectUnambiguousResult,
  transitionKind
} from "../src/monitoring/triggerActions";

describe("monitor trigger actions", () => {
  it("recognizes only real found and missing transitions", () => {
    expect(transitionKind(false, true)).toBe("found");
    expect(transitionKind(true, false)).toBe("missing");
    expect(transitionKind(true, true)).toBeNull();
    expect(transitionKind(false, false)).toBeNull();
    expect(transitionKind(null, true)).toBeNull();
  });

  it("applies bring-to-front filters and the safety cooldown", () => {
    expect(focusModeIncludesTransition("never", "found")).toBe(false);
    expect(focusModeIncludesTransition("found", "found")).toBe(true);
    expect(focusModeIncludesTransition("found", "missing")).toBe(false);
    expect(focusModeIncludesTransition("all", "missing")).toBe(true);
    expect(focusCooldownActive(100_000, 399_999)).toBe(true);
    expect(focusCooldownActive(100_000, 400_000)).toBe(false);
  });

  it("builds stable signatures that change with the result identity", () => {
    const base = {
      keywordId: "ticket",
      tabId: 7,
      pageUrl: "https://example.test/queue",
      frameId: 2,
      frameUrl: "https://example.test/grid",
      matchedText: "New Ticket",
      resultIdentifierHash: "abc",
      rowTextHash: "row-one",
      linkUrl: "https://example.test/tickets/1"
    };
    expect(buildResultSignature(base)).toBe(buildResultSignature(base));
    expect(buildResultSignature(base)).not.toBe(
      buildResultSignature({ ...base, rowTextHash: "row-two" })
    );
  });

  it("skips ambiguous and duplicate results but permits one new result", () => {
    expect(
      selectUnambiguousResult(
        [{ signature: "one" }, { signature: "two" }],
        null
      ).reason
    ).toBe("ambiguous");
    expect(
      selectUnambiguousResult(
        [{ signature: "same" }, { signature: "same" }],
        null
      ).reason
    ).toBe("ambiguous");
    expect(
      selectUnambiguousResult([{ signature: "one" }], "one").reason
    ).toBe("duplicate");
    expect(
      selectUnambiguousResult(
        [{ signature: "one" }, { signature: "two" }],
        "one"
      ).selected?.signature
    ).toBe("two");
    expect(autoOpenNeedsClick("scroll-highlight")).toBe(false);
    expect(autoOpenNeedsClick("click")).toBe(true);
  });
});
