import { describe, expect, it } from "vitest";
import { evaluateKeywordTransition } from "../src/monitoring/transitions";

describe("Found transition detection", () => {
  it.each([
    [null, false, false],
    [null, true, true],
    [false, true, true],
    [true, true, false],
    [true, false, false],
    [false, false, false]
  ] as const)("%s -> %s detects: %s", (previous, current, detected) => {
    expect(evaluateKeywordTransition("found", previous, current).detected)
      .toBe(detected);
  });

  it("detects again after the condition rearms", () => {
    const sequence = [false, true, true, false, true];
    let previous: boolean | null = null;
    const detections = sequence.map((current) => {
      const detected = evaluateKeywordTransition(
        "found",
        previous,
        current
      ).detected;
      previous = current;
      return detected;
    });
    expect(detections).toEqual([false, true, false, false, true]);
  });
});

describe("Lost transition detection", () => {
  it.each([
    [null, true, false],
    [null, false, false],
    [true, false, true],
    [false, false, false],
    [false, true, false],
    [true, true, false]
  ] as const)("%s -> %s detects: %s", (previous, current, detected) => {
    expect(evaluateKeywordTransition("lost", previous, current).detected)
      .toBe(detected);
  });

  it("detects again after the condition rearms", () => {
    const sequence = [true, false, false, true, false];
    let previous: boolean | null = null;
    const detections = sequence.map((current) => {
      const detected = evaluateKeywordTransition(
        "lost",
        previous,
        current
      ).detected;
      previous = current;
      return detected;
    });
    expect(detections).toEqual([false, true, false, false, true]);
  });
});
