import type {
  Profile,
  ProfileBehavior,
  ProfileInput,
  ProfileMatchResult,
  ProfileMatchRule,
  ProfileMatchScope
} from "../types/monitor";
import { validateCombinedConfiguration } from "./configValidation";

function normalizedPathname(pathname: string): string {
  if (!pathname || pathname === "/") return "/";
  return pathname.replace(/\/+$/u, "") || "/";
}

function normalizedOrigin(url: URL): string {
  if (url.protocol === "file:") return "file://";
  return url.origin.toLowerCase();
}

export function normalizeProfileUrl(
  rawUrl: string,
  scope: ProfileMatchScope
): string {
  const url = new URL(rawUrl);
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  url.pathname = normalizedPathname(url.pathname);
  if (scope !== "exact") url.search = "";
  if (scope === "exact") url.searchParams.sort();
  if (scope === "site") return normalizedOrigin(url);
  return `${normalizedOrigin(url)}${url.pathname}${scope === "exact" ? url.search : ""}`;
}

export function profileMatchesUrl(profile: Profile, pageUrl: string): boolean {
  try {
    return normalizeProfileUrl(profile.match.url, profile.match.scope) ===
      normalizeProfileUrl(pageUrl, profile.match.scope);
  } catch {
    return false;
  }
}

export function profileScopeSpecificity(scope: ProfileMatchScope): number {
  return scope === "exact" ? 3 : scope === "path" ? 2 : 1;
}

export function resolveProfileMatches(
  profiles: readonly Profile[],
  pageUrl: string
): ProfileMatchResult {
  const matches = profiles
    .filter((profile) => profile.enabled && profileMatchesUrl(profile, pageUrl))
    .sort((left, right) =>
      profileScopeSpecificity(right.match.scope) - profileScopeSpecificity(left.match.scope) ||
      left.name.localeCompare(right.name) ||
      left.id.localeCompare(right.id)
    );
  const autoMatches = matches.filter((profile) => profile.behavior === "auto-start");
  const highestSpecificity = autoMatches.length
    ? profileScopeSpecificity(autoMatches[0]!.match.scope)
    : 0;
  const highestAutoMatches = autoMatches.filter(
    (profile) => profileScopeSpecificity(profile.match.scope) === highestSpecificity
  );
  return {
    matches,
    autoStartProfile: highestAutoMatches.length === 1 ? highestAutoMatches[0]! : null,
    autoStartConflict: highestAutoMatches.length > 1 ? highestAutoMatches : []
  };
}

export interface ProfileMetadata {
  name: string;
  match: ProfileMatchRule;
  behavior: ProfileBehavior;
}

export function validateProfileMetadata(
  metadata: ProfileMetadata
): string | null {
  if (!metadata.name.trim()) return "Enter a Profile name.";
  if (metadata.name.trim().length > 100) {
    return "Profile names must be 100 characters or fewer.";
  }
  if (!["exact", "path", "site"].includes(metadata.match.scope)) {
    return "Choose a valid URL scope.";
  }
  try {
    normalizeProfileUrl(metadata.match.url, metadata.match.scope);
  } catch {
    return "Enter a valid profile URL.";
  }
  if (!["suggest", "auto-start"].includes(metadata.behavior)) {
    return "Choose a valid profile behavior.";
  }
  return null;
}

export function validateProfileInput(input: ProfileInput): string | null {
  const metadataError = validateProfileMetadata(input);
  if (metadataError) return metadataError;
  return validateCombinedConfiguration(input.reloadConfig, input.monitorConfig);
}

function normalizedInput(input: ProfileInput): ProfileInput {
  return {
    ...input,
    name: input.name.trim(),
    match: {
      ...input.match,
      url: normalizeProfileUrl(input.match.url, input.match.scope)
    },
    reloadConfig: {
      ...input.reloadConfig,
      reloadEnabled: input.reloadConfig.reloadEnabled !== false
    },
    monitorConfig: {
      ...input.monitorConfig,
      keywords: input.monitorConfig.keywords.map((keyword) => ({
        ...keyword,
        value: keyword.value.trim()
      }))
    }
  };
}

export function createProfile(
  profiles: readonly Profile[],
  input: ProfileInput,
  id: string,
  now = Date.now()
): Profile[] {
  const error = validateProfileInput(input);
  if (error) throw new Error(error);
  if (profiles.some((profile) => profile.id === id)) throw new Error("Profile ID already exists.");
  return [...profiles, { ...normalizedInput(input), id, createdAt: now, updatedAt: now }];
}

export function updateProfile(
  profiles: readonly Profile[],
  id: string,
  input: ProfileInput,
  now = Date.now()
): Profile[] {
  const error = validateProfileInput(input);
  if (error) throw new Error(error);
  if (!profiles.some((profile) => profile.id === id)) throw new Error("Profile was not found.");
  const normalized = normalizedInput(input);
  return profiles.map((profile) =>
    profile.id === id
      ? { ...profile, ...normalized, id: profile.id, createdAt: profile.createdAt, updatedAt: now }
      : profile
  );
}

export function deleteProfile(profiles: readonly Profile[], id: string): Profile[] {
  if (!profiles.some((profile) => profile.id === id)) throw new Error("Profile was not found.");
  return profiles.filter((profile) => profile.id !== id);
}

export function setProfileEnabled(
  profiles: readonly Profile[],
  id: string,
  enabled: boolean,
  now = Date.now()
): Profile[] {
  if (!profiles.some((profile) => profile.id === id)) throw new Error("Profile was not found.");
  return profiles.map((profile) =>
    profile.id === id ? { ...profile, enabled, updatedAt: now } : profile
  );
}
