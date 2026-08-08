import {
  ALL_WEBSITE_PERMISSION_PATTERNS,
  CHROME_API_TIMEOUT_MS
} from "./constants";
import { withTimeout } from "./async";
import { inspectUrl } from "./url";
import type { SiteAccessPreference } from "../types/monitor";

export type SiteAccessState =
  | "granted-site"
  | "granted-all"
  | "required"
  | "denied"
  | "unsupported";

export interface SitePermissionStatus {
  state: SiteAccessState;
  pageOrigin: string | null;
}

export function permissionOriginsFor(
  rawUrl: string,
  preference: SiteAccessPreference
): string[] {
  const support = inspectUrl(rawUrl);
  if (!support.supported || !support.permissionPattern) return [];
  if (preference === "all" && !rawUrl.startsWith("file:")) {
    return [...ALL_WEBSITE_PERMISSION_PATTERNS];
  }
  return [support.permissionPattern];
}

export async function readSitePermissionStatus(
  rawUrl: string
): Promise<SitePermissionStatus> {
  const support = inspectUrl(rawUrl);
  if (!support.supported || !support.permissionPattern) {
    return { state: "unsupported", pageOrigin: null };
  }

  const allGranted =
    !rawUrl.startsWith("file:") &&
    (await withTimeout(
      chrome.permissions.contains({
        origins: [...ALL_WEBSITE_PERMISSION_PATTERNS]
      }),
      "Check access to all websites",
      CHROME_API_TIMEOUT_MS
    ));
  if (allGranted) {
    return {
      state: "granted-all",
      pageOrigin: support.permissionPattern
    };
  }

  const siteGranted = await withTimeout(
    chrome.permissions.contains({
      origins: [support.permissionPattern]
    }),
    "Check access to this website",
    CHROME_API_TIMEOUT_MS
  );
  return {
    state: siteGranted ? "granted-site" : "required",
    pageOrigin: support.permissionPattern
  };
}

export function accessSatisfiesPreference(
  state: SiteAccessState,
  preference: SiteAccessPreference
): boolean {
  return (
    state === "granted-all" ||
    (preference === "site" && state === "granted-site")
  );
}
