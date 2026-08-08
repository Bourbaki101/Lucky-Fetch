import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  alarmName,
  clearReload,
  clearScansForTab,
  scheduleReload,
  scheduleScan,
  scanAlarmName,
  scanIdentityFromAlarm,
  tabIdFromAlarm
} from "../src/scheduling/alarms";

describe("reload alarms", () => {
  const alarms = new Map<string, chrome.alarms.Alarm>();

  beforeEach(() => {
    alarms.clear();
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: {
        alarms: {
          create: vi.fn(
            async (name: string, info: chrome.alarms.AlarmCreateInfo) => {
              alarms.set(name, {
                name,
                scheduledTime: info.when ?? Date.now()
              });
            }
          ),
          get: vi.fn(async (name: string) => alarms.get(name)),
          getAll: vi.fn(async () => [...alarms.values()]),
          clear: vi.fn(async (name: string) => alarms.delete(name))
        }
      }
    });
  });

  it("uses deterministic, independently parseable tab names", () => {
    expect(alarmName(12)).not.toBe(alarmName(13));
    expect(tabIdFromAlarm(alarmName(12))).toBe(12);
    expect(tabIdFromAlarm("unrelated")).toBeNull();
  });

  it("creates and verifies the exact tab alarm", async () => {
    const alarm = await scheduleReload(12, 200_000, 100_000);
    expect(alarm.name).toBe(alarmName(12));
    expect(alarm.scheduledTime).toBe(200_000);
  });

  it("clears and verifies removal", async () => {
    await scheduleReload(12, 200_000, 100_000);
    await expect(clearReload(12)).resolves.toBe(true);
    expect(alarms.has(alarmName(12))).toBe(false);
  });

  it("fails instead of implying a schedule when Chromium drops the alarm", async () => {
    vi.mocked(chrome.alarms.get).mockImplementation(
      async () => undefined as unknown as chrome.alarms.Alarm
    );
    await expect(scheduleReload(12, 200_000, 100_000)).rejects.toThrow(
      "did not retain"
    );
  });

  it("uses generation-qualified scan alarms distinct from reload alarms", async () => {
    const scan = await scheduleScan(12, 3, 200_000, 100_000);
    expect(scan.name).toBe(scanAlarmName(12, 3));
    expect(scan.name).not.toBe(alarmName(12));
    expect(scanIdentityFromAlarm(scan.name)).toEqual({
      tabId: 12,
      generation: 3
    });
  });

  it("clears only the target tab's scan alarms", async () => {
    await scheduleScan(12, 1, 200_000, 100_000);
    await scheduleScan(12, 2, 210_000, 100_000);
    await scheduleScan(13, 1, 220_000, 100_000);
    await expect(clearScansForTab(12)).resolves.toBe(2);
    expect(alarms.has(scanAlarmName(12, 1))).toBe(false);
    expect(alarms.has(scanAlarmName(13, 1))).toBe(true);
  });
});
