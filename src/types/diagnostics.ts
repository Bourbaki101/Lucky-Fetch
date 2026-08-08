import type { TabMonitor } from "./monitor";

export interface AlarmDiagnostic {
  name: string;
  scheduledTime: number;
  periodInMinutes: number | null;
}

export interface DiagnosticSnapshot {
  generatedAt: number;
  initializationStatus: "starting" | "ready" | "error";
  initializationError: string | null;
  requestedTabId: number | null;
  requestedTabExists: boolean | null;
  storedMonitor: TabMonitor | null;
  memoryMonitor: TabMonitor | null;
  matchingAlarm: AlarmDiagnostic | null;
  matchingScanAlarms: AlarmDiagnostic[];
  monitorTabIds: number[];
  alarmNames: string[];
  notes: string[];
}
