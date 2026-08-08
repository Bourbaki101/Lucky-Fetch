import { describe, expect, it } from "vitest";
import {
  aggregateFrameScans,
  type FrameScanOutcome
} from "../src/monitoring/frameAggregation";

function success(
  frameId: number,
  matched: boolean
): FrameScanOutcome {
  return {
    status: "success",
    frameId,
    matched,
    matches: [
      {
        keywordId: "keyword-1",
        keyword: "Ticket",
        matched,
        occurrenceCount: matched ? 1 : 0
      }
    ],
    scannedAt: 1_000 + frameId,
    textLength: 10
  };
}

describe("tab-level frame scan aggregation", () => {
  it("matches when any successfully scanned frame matches", () => {
    expect(
      aggregateFrameScans(
        [success(0, false), success(4, true), success(7, false)],
        500
      )
    ).toMatchObject({
      status: "complete",
      matched: true,
      scannedFrameCount: 3,
      unavailableFrameCount: 0,
      matchingFrameCount: 1,
      matchedKeywords: [{ id: "keyword-1", value: "Ticket" }]
    });
  });

  it("stays present when one of two matching frames disappears", () => {
    expect(
      aggregateFrameScans(
        [success(0, false), success(2, false), success(3, true)],
        500
      )
    ).toMatchObject({ status: "complete", matched: true });
  });

  it("returns a confident absence only when every frame succeeded", () => {
    expect(
      aggregateFrameScans([success(0, false), success(2, false)], 500)
    ).toMatchObject({
      status: "complete",
      matched: false,
      scannedFrameCount: 2,
      unavailableFrameCount: 0
    });
  });

  it("confirms absence when only terminal restricted frames were skipped", () => {
    expect(
      aggregateFrameScans(
        [
          success(0, false),
          {
            status: "restricted",
            frameId: 5,
            reason: "missing-permission"
          }
        ],
        500
      )
    ).toMatchObject({
      status: "complete",
      matched: false,
      scannedAt: 1_000,
      scannedFrameCount: 1,
      unavailableFrameCount: 1,
      textLength: 10,
      pendingFrameCount: 0,
      restrictedFrameCount: 1,
      conclusive: true
    });
  });

  it("stays inconclusive when a transient frame is pending", () => {
    expect(
      aggregateFrameScans(
        [
          success(0, false),
          {
            status: "pending",
            frameId: 5,
            reason: "injection-failed"
          }
        ],
        500
      )
    ).toMatchObject({
      status: "partial",
      matched: null,
      pendingFrameCount: 1,
      restrictedFrameCount: 0,
      conclusive: false
    });
  });

  it("accepts a positive match even when another frame is unavailable", () => {
    expect(
      aggregateFrameScans(
        [
          success(0, true),
          {
            status: "pending",
            frameId: 5,
            reason: "injection-failed"
          }
        ],
        500
      )
    ).toMatchObject({
      status: "partial",
      matched: true,
      unavailableFrameCount: 1,
      conclusive: true
    });
  });

  it("treats a positive match with only restricted frames as complete", () => {
    expect(
      aggregateFrameScans(
        [
          success(0, true),
          {
            status: "restricted",
            frameId: 5,
            reason: "unsupported"
          }
        ],
        500
      )
    ).toMatchObject({
      status: "complete",
      matched: true,
      pendingFrameCount: 0,
      restrictedFrameCount: 1,
      conclusive: true
    });
  });
});
