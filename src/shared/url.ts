const RESTRICTED_HOSTS = new Set([
  "chrome.google.com",
  "chromewebstore.google.com",
  "microsoftedge.microsoft.com"
]);

export interface UrlSupport {
  supported: boolean;
  reason: string | null;
  permissionPattern: string | null;
}

export function inspectUrl(rawUrl: string): UrlSupport {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return {
      supported: false,
      reason: "This tab does not have a valid reloadable URL.",
      permissionPattern: null
    };
  }

  if (!["http:", "https:", "file:"].includes(url.protocol)) {
    return {
      supported: false,
      reason: `${url.protocol} pages are protected by the browser and cannot be monitored.`,
      permissionPattern: null
    };
  }

  if (RESTRICTED_HOSTS.has(url.hostname)) {
    return {
      supported: false,
      reason: "Browser extension store pages cannot be monitored.",
      permissionPattern: null
    };
  }

  return {
    supported: true,
    reason: null,
    permissionPattern:
      url.protocol === "file:" ? "file:///*" : `${url.protocol}//${url.hostname}/*`
  };
}
