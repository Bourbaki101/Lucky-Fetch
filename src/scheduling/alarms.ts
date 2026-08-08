import {
  ALARM_PREFIX,
  BADGE_ALARM_NAME,
  BADGE_REFRESH_MINUTES,
  CHROME_API_TIMEOUT_MS,
  SCAN_ALARM_PREFIX
} from "../shared/constants";
import { withTimeout } from "../shared/async";

export function alarmName(tabId: number): string {
  return `${ALARM_PREFIX}${tabId}`;
}

export function tabIdFromAlarm(name: string): number | null {
  if (!name.startsWith(ALARM_PREFIX)) return null;
  const tabId = Number(name.slice(ALARM_PREFIX.length));
  return Number.isInteger(tabId) && tabId >= 0 ? tabId : null;
}

export interface ScanAlarmIdentity {
  tabId: number;
  generation: number;
}

export function scanAlarmName(tabId: number, generation: number): string {
  return `${SCAN_ALARM_PREFIX}${tabId}:${generation}`;
}

export function scanIdentityFromAlarm(
  name: string
): ScanAlarmIdentity | null {
  if (!name.startsWith(SCAN_ALARM_PREFIX)) return null;
  const [rawTabId, rawGeneration, extra] = name
    .slice(SCAN_ALARM_PREFIX.length)
    .split(":");
  if (extra !== undefined) return null;
  const tabId = Number(rawTabId);
  const generation = Number(rawGeneration);
  return Number.isInteger(tabId) &&
    tabId >= 0 &&
    Number.isInteger(generation) &&
    generation >= 0
    ? { tabId, generation }
    : null;
}

export async function scheduleReload(
  tabId: number,
  timestamp: number,
  now = Date.now()
): Promise<chrome.alarms.Alarm> {
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Cannot schedule tab ${tabId}: invalid reload timestamp.`);
  }

  const name = alarmName(tabId);
  const when = Math.max(timestamp, now + 250);
  await withTimeout(
    chrome.alarms.create(name, { when }),
    `Create reload alarm for tab ${tabId}`,
    CHROME_API_TIMEOUT_MS
  );
  const created = await withTimeout(
    chrome.alarms.get(name),
    `Verify reload alarm for tab ${tabId}`,
    CHROME_API_TIMEOUT_MS
  );
  if (!created) {
    throw new Error(`Chromium did not retain the reload alarm for tab ${tabId}.`);
  }
  return created;
}

export async function clearReload(tabId: number): Promise<boolean> {
  const name = alarmName(tabId);
  const cleared = await withTimeout(
    chrome.alarms.clear(name),
    `Clear reload alarm for tab ${tabId}`,
    CHROME_API_TIMEOUT_MS
  );
  const remaining = await withTimeout(
    chrome.alarms.get(name),
    `Verify cleared reload alarm for tab ${tabId}`,
    CHROME_API_TIMEOUT_MS
  );
  if (remaining) {
    throw new Error(`Reload alarm for tab ${tabId} could not be cleared.`);
  }
  return cleared;
}

export async function scheduleScan(
  tabId: number,
  generation: number,
  timestamp: number,
  now = Date.now()
): Promise<chrome.alarms.Alarm> {
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Cannot schedule tab ${tabId}: invalid scan timestamp.`);
  }
  const name = scanAlarmName(tabId, generation);
  await withTimeout(
    chrome.alarms.create(name, { when: Math.max(timestamp, now + 250) }),
    `Create scan alarm for tab ${tabId}`,
    CHROME_API_TIMEOUT_MS
  );
  const created = await withTimeout(
    chrome.alarms.get(name),
    `Verify scan alarm for tab ${tabId}`,
    CHROME_API_TIMEOUT_MS
  );
  if (!created) {
    throw new Error(`Chromium did not retain the scan alarm for tab ${tabId}.`);
  }
  return created;
}

export async function clearScan(
  tabId: number,
  generation: number
): Promise<boolean> {
  return withTimeout(
    chrome.alarms.clear(scanAlarmName(tabId, generation)),
    `Clear scan alarm for tab ${tabId}`,
    CHROME_API_TIMEOUT_MS
  );
}

export async function clearScansForTab(tabId: number): Promise<number> {
  const alarms = await withTimeout(
    chrome.alarms.getAll(),
    `Read scan alarms for tab ${tabId}`,
    CHROME_API_TIMEOUT_MS
  );
  const names = alarms
    .filter((alarm) => scanIdentityFromAlarm(alarm.name)?.tabId === tabId)
    .map((alarm) => alarm.name);
  const results = await Promise.all(
    names.map((name) =>
      withTimeout(
        chrome.alarms.clear(name),
        `Clear scan alarm ${name}`,
        CHROME_API_TIMEOUT_MS
      )
    )
  );
  return results.filter(Boolean).length;
}

export async function ensureBadgeAlarm(): Promise<chrome.alarms.Alarm> {
  const existing = await withTimeout(
    chrome.alarms.get(BADGE_ALARM_NAME),
    "Read badge refresh alarm",
    CHROME_API_TIMEOUT_MS
  );
  if (!existing) {
    await withTimeout(
      chrome.alarms.create(BADGE_ALARM_NAME, {
        delayInMinutes: BADGE_REFRESH_MINUTES,
        periodInMinutes: BADGE_REFRESH_MINUTES
      }),
      "Create badge refresh alarm",
      CHROME_API_TIMEOUT_MS
    );
  }
  const verified = await withTimeout(
    chrome.alarms.get(BADGE_ALARM_NAME),
    "Verify badge refresh alarm",
    CHROME_API_TIMEOUT_MS
  );
  if (!verified) throw new Error("Chromium did not retain the badge refresh alarm.");
  return verified;
}
