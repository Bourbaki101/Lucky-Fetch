import { describe, expect, it } from "vitest";
import {
  OperationTimeoutError,
  withTimeout
} from "../src/shared/async";

describe("bounded operations", () => {
  it("returns a settled operation", async () => {
    await expect(
      withTimeout(Promise.resolve("ready"), "test operation", 50)
    ).resolves.toBe("ready");
  });

  it("rejects an operation that never settles", async () => {
    const pending = new Promise<never>(() => undefined);
    await expect(withTimeout(pending, "stuck worker", 10)).rejects.toEqual(
      expect.objectContaining<Partial<OperationTimeoutError>>({
        name: "OperationTimeoutError",
        operation: "stuck worker",
        timeoutMs: 10
      })
    );
  });
});
