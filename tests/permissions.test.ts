import { afterEach, describe, expect, it, vi } from "vitest";
import {
  accessSatisfiesPreference,
  permissionOriginsFor,
  readSitePermissionStatus
} from "../src/shared/permissions";

afterEach(() => {
  Reflect.deleteProperty(globalThis, "chrome");
});

function installPermissionMock(results: boolean[]) {
  const contains = vi.fn(async () => results.shift() ?? false);
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: { permissions: { contains } }
  });
  return contains;
}

describe("site access permissions", () => {
  it("normalizes a URL to an origin-level website pattern", () => {
    expect(
      permissionOriginsFor(
        "https://Example.COM/path?q=secret#fragment",
        "site"
      )
    ).toEqual(["https://example.com/*"]);
    expect(
      permissionOriginsFor("http://localhost:5173/test", "site")
    ).toEqual(["http://localhost/*"]);
  });

  it("requests only declared optional patterns for all websites", () => {
    expect(permissionOriginsFor("https://example.com/path", "all")).toEqual([
      "http://*/*",
      "https://*/*"
    ]);
  });

  it("reuses all-sites access before checking the current origin", async () => {
    const contains = installPermissionMock([true]);
    await expect(
      readSitePermissionStatus("https://example.com/path")
    ).resolves.toEqual({
      state: "granted-all",
      pageOrigin: "https://example.com/*"
    });
    expect(contains).toHaveBeenCalledOnce();
    expect(contains).toHaveBeenCalledWith({
      origins: ["http://*/*", "https://*/*"]
    });
  });

  it("reuses an existing per-origin grant", async () => {
    const contains = installPermissionMock([false, true]);
    await expect(
      readSitePermissionStatus("https://example.com/path")
    ).resolves.toMatchObject({ state: "granted-site" });
    expect(contains).toHaveBeenLastCalledWith({
      origins: ["https://example.com/*"]
    });
  });

  it("does not treat per-site access as satisfying an all-sites choice", () => {
    expect(accessSatisfiesPreference("granted-site", "site")).toBe(true);
    expect(accessSatisfiesPreference("granted-site", "all")).toBe(false);
    expect(accessSatisfiesPreference("granted-all", "all")).toBe(true);
  });
});
