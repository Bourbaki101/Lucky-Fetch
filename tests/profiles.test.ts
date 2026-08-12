import { describe, expect, it } from "vitest";
import { createKeywordConfig } from "../src/monitoring/runtime";
import {
  createProfile,
  deleteProfile,
  normalizeProfileUrl,
  profileMatchesUrl,
  resolveProfileMatches,
  setProfileEnabled,
  updateProfile,
  validateProfileMetadata,
  validateProfileInput
} from "../src/shared/profiles";
import { normalizePersistedState } from "../src/storage/storage";
import type { Profile, ProfileInput, ProfileMatchScope } from "../src/types/monitor";

function input(overrides: Partial<ProfileInput> = {}): ProfileInput {
  return {
    name: "Autotask Queue",
    enabled: true,
    match: { scope: "exact", url: "https://Example.com/tickets/?queue=2#top" },
    behavior: "suggest",
    reloadConfig: {
      reloadEnabled: true,
      intervalMs: 14_000,
      bypassCache: true,
      maximumReloads: 9,
      interactionBehavior: "delay",
      protectActiveTyping: true
    },
    monitorConfig: {
      ...createKeywordConfig(),
      enabled: true,
      keywords: [{ id: "available", value: "Available" }],
      mode: "found",
      scanDelayMs: 7_000,
      notificationMessage: "Queue",
      bringToFront: "found",
      autoOpenResult: "scroll-highlight"
    },
    ...overrides
  };
}

function profile(id: string, scope: ProfileMatchScope, behavior: Profile["behavior"] = "suggest"): Profile {
  return createProfile([], input({ match: { scope, url: "https://example.com/tickets?queue=2" }, behavior }), id, 1)[0]!;
}

describe("Profile URL matching", () => {
  it("normalizes casing, default ports, fragments, query ordering, and trailing slashes", () => {
    expect(normalizeProfileUrl("https://EXAMPLE.com:443/tickets/?b=2&a=1#top", "exact"))
      .toBe("https://example.com/tickets?a=1&b=2");
  });

  it("matches an exact page but not a different path or meaningful query", () => {
    const exact = profile("exact", "exact");
    expect(profileMatchesUrl(exact, "https://example.com/tickets/?queue=2#later")).toBe(true);
    expect(profileMatchesUrl(exact, "https://example.com/tickets?queue=3")).toBe(false);
    expect(profileMatchesUrl(exact, "https://example.com/other?queue=2")).toBe(false);
  });

  it("matches only the same origin and path for This path", () => {
    const path = profile("path", "path");
    expect(profileMatchesUrl(path, "https://example.com/tickets/?queue=99#open")).toBe(true);
    expect(profileMatchesUrl(path, "https://example.com/tickets/archive")).toBe(false);
    expect(profileMatchesUrl(path, "https://other.example/tickets")).toBe(false);
  });

  it("matches the same origin broadly for This site and rejects unrelated origins", () => {
    const site = profile("site", "site");
    expect(profileMatchesUrl(site, "https://example.com/anything?q=1")).toBe(true);
    expect(profileMatchesUrl(site, "http://example.com/anything")).toBe(false);
    expect(profileMatchesUrl(site, "https://example.org/anything")).toBe(false);
  });

  it("uses Exact over Path over Site and blocks equal Auto-start conflicts", () => {
    const site = profile("site", "site", "auto-start");
    const path = profile("path", "path", "auto-start");
    const exact = profile("exact", "exact", "auto-start");
    expect(resolveProfileMatches([site, path, exact], "https://example.com/tickets?queue=2").autoStartProfile?.id)
      .toBe("exact");
    const exactTwo = { ...exact, id: "exact-two", name: "Second exact" };
    const conflict = resolveProfileMatches([site, exact, exactTwo], "https://example.com/tickets?queue=2");
    expect(conflict.autoStartProfile).toBeNull();
    expect(conflict.autoStartConflict.map(({ id }) => id)).toEqual(["exact", "exact-two"]);
  });

  it("surfaces multiple Suggest matches without selecting one for auto-start", () => {
    const resolution = resolveProfileMatches(
      [profile("one", "exact"), profile("two", "path")],
      "https://example.com/tickets?queue=2"
    );
    expect(resolution.matches.map(({ id }) => id)).toEqual(["one", "two"]);
    expect(resolution.autoStartProfile).toBeNull();
  });
});

describe("Profile CRUD and persistence", () => {
  it("creates, edits, disables, enables, and deletes Profiles", () => {
    let profiles = createProfile([], input(), "stable-id", 10);
    expect(profiles[0]).toMatchObject({ id: "stable-id", behavior: "suggest", enabled: true });
    profiles = updateProfile(profiles, "stable-id", input({ name: "Edited", behavior: "auto-start" }), 20);
    expect(profiles[0]).toMatchObject({ id: "stable-id", name: "Edited", behavior: "auto-start", createdAt: 10, updatedAt: 20 });
    profiles = setProfileEnabled(profiles, "stable-id", false, 30);
    expect(resolveProfileMatches(profiles, "https://example.com/tickets?queue=2").matches).toEqual([]);
    profiles = setProfileEnabled(profiles, "stable-id", true, 40);
    expect(profiles[0]?.enabled).toBe(true);
    expect(deleteProfile(profiles, "stable-id")).toEqual([]);
  });

  it("round-trips the complete Reload and Monitor configuration through version 6 storage", () => {
    const saved = createProfile([], input(), "saved", 10)[0]!;
    const restored = normalizePersistedState({
      version: 6,
      monitors: {},
      notificationHistory: [],
      quickTriggers: ["Available"],
      profiles: [saved]
    });
    expect(restored.profiles[0]).toEqual(saved);
    expect(restored.quickTriggers).toEqual(["Available"]);
  });

  it("preserves a now-invalid saved interval so it is surfaced instead of silently run", () => {
    const saved = createProfile([], input(), "saved", 10)[0]!;
    saved.reloadConfig.intervalMs = 5_000;
    const restored = normalizePersistedState({
      version: 6,
      monitors: {},
      notificationHistory: [],
      quickTriggers: [],
      profiles: [saved]
    });
    expect(restored.profiles[0]?.reloadConfig.intervalMs).toBe(5_000);
    expect(validateProfileInput({
      ...input(),
      reloadConfig: restored.profiles[0]!.reloadConfig
    })).toBe("Minimum reload interval is 10 seconds.");
  });

  it("rejects invalid intervals, keywords, and custom monitor delays with shared validation", () => {
    expect(validateProfileInput(input({ reloadConfig: { ...input().reloadConfig, intervalMs: 9_000 } })))
      .toBe("Minimum reload interval is 10 seconds.");
    expect(validateProfileInput(input({ monitorConfig: { ...input().monitorConfig, keywords: [] } })))
      .toBe("Add at least one keyword or phrase.");
    expect(validateProfileInput(input({ monitorConfig: { ...input().monitorConfig, scanDelayMs: 7_001 } })))
      .toBe("Monitor delay must be 7 seconds or less with a 14-second reload interval.");
    expect(validateProfileInput(input({
      reloadConfig: { ...input().reloadConfig, reloadEnabled: false },
      monitorConfig: { ...input().monitorConfig, scanDelayMs: 60_000 }
    }))).toBeNull();
  });

  it("validates metadata before a new Profile enters configuration mode", () => {
    expect(validateProfileMetadata({
      name: "",
      match: { scope: "exact", url: "https://example.com/tickets" },
      behavior: "suggest"
    })).toBe("Enter a Profile name.");
    expect(validateProfileMetadata({
      name: "Monitor only",
      match: { scope: "path", url: "not a URL" },
      behavior: "suggest"
    })).toBe("Enter a valid profile URL.");
    expect(validateProfileMetadata({
      name: "Monitor only",
      match: { scope: "path", url: "https://example.com/tickets" },
      behavior: "suggest"
    })).toBeNull();
  });

  it("accepts a Monitor-only Profile configured independently of tab state", () => {
    const monitorOnly = input({
      reloadConfig: { ...input().reloadConfig, reloadEnabled: false },
      monitorConfig: {
        ...input().monitorConfig,
        enabled: true,
        keywords: [{ id: "fresh", value: "Created from scratch" }],
        scanDelayMs: 60_000
      }
    });
    expect(validateProfileInput(monitorOnly)).toBeNull();
    expect(createProfile([], monitorOnly, "monitor-only", 42)[0]).toMatchObject({
      id: "monitor-only",
      reloadConfig: { reloadEnabled: false },
      monitorConfig: {
        enabled: true,
        keywords: [{ id: "fresh", value: "Created from scratch" }]
      }
    });
  });
});
