import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import type { ReactNode } from "react";
import type {
  ExtensionRequest,
  ExtensionResponse
} from "../messaging/contracts";
import {
  CHROME_API_TIMEOUT_MS,
  DEFAULT_KEYWORD_MONITORING,
  DEFAULT_SETTINGS,
  MAX_KEYWORDS_PER_MONITOR,
  MONITOR_DRAFTS_STORAGE_KEY,
  POPUP_PREFERENCES_STORAGE_KEY,
  POPUP_HISTORY_LIMIT,
  POPUP_INIT_TIMEOUT_MS,
  SESSION_TOKEN_PREFIX,
  STORAGE_KEY
} from "../shared/constants";
import { errorMessage, withTimeout } from "../shared/async";
import {
  badgeForReloadDeadline,
  nearestActiveReloadAt
} from "../shared/badge";
import {
  keywordConditionEquals,
  validateKeywordConfig
} from "../monitoring/matching";
import {
  accessSatisfiesPreference,
  permissionOriginsFor,
  readSitePermissionStatus
} from "../shared/permissions";
import type { SiteAccessState } from "../shared/permissions";
import { formatCountdown, remainingMs, validateInterval } from "../shared/time";
import { inspectUrl } from "../shared/url";
import {
  clearReload,
  clearScansForTab,
  scanIdentityFromAlarm,
  tabIdFromAlarm
} from "../scheduling/alarms";
import { monitorKey, readState, writeState } from "../storage/storage";
import {
  readMonitorDraft,
  removeMonitorDraft,
  writeMonitorDraft
} from "../storage/drafts";
import type {
  AutoOpenResultMode,
  BringToFrontMode,
  DetectionAction,
  InteractionBehavior,
  IntervalUnit,
  KeywordMonitorMode,
  KeywordMonitoringConfig,
  KeywordRule,
  KeywordTestResult,
  MonitorSettings,
  PendingMonitorDraft,
  SiteAccessPreference,
  TabMonitor,
  TabSummary
} from "../types/monitor";

const PRESETS = [
  { label: "30 sec", value: 30, unit: "seconds" as const },
  { label: "1 min", value: 1, unit: "minutes" as const },
  { label: "5 min", value: 5, unit: "minutes" as const },
  { label: "15 min", value: 15, unit: "minutes" as const }
];

type PopupPhase = "loading" | "ready" | "unsupported" | "error";
type ThemePreference = "system" | "light" | "dark";
type PopupTab = "interval" | "monitor";

interface AppShellProps {
  children: ReactNode;
  footer: ReactNode;
  header: ReactNode;
  tabs: ReactNode;
  variant?: string;
}

export function AppShell({
  children,
  footer,
  header,
  tabs,
  variant = ""
}: AppShellProps) {
  return (
    <main className={`popup app-shell ${variant}`.trim()}>
      {header}
      {tabs}
      <div className="app-content">{children}</div>
      {footer}
    </main>
  );
}

function createKeywordRule(value = ""): KeywordRule {
  return { id: globalThis.crypto.randomUUID(), value };
}

function pageHost(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname || parsed.protocol.replace(":", "");
  } catch {
    return url;
  }
}

function interactionSummary(
  behavior: InteractionBehavior,
  protectTyping: boolean,
  bypassCache: boolean,
  limitEnabled: boolean,
  maximumReloads: string
): string {
  const details: string[] = [];
  if (bypassCache) details.push("No cache");
  if (limitEnabled) details.push(`Stop after ${maximumReloads || "—"}`);
  if (behavior === "delay") details.push("Delay on interaction");
  if (behavior === "pause") details.push("Pause on interaction");
  if (behavior === "stop") details.push("Stop on interaction");
  if (protectTyping) details.push("Pause while typing");
  return details.length > 0 ? details.join(" · ") : "Default behavior";
}

function keywordSummary(
  enabled: boolean,
  keywords: readonly KeywordRule[],
  mode: KeywordMonitorMode
): string {
  if (!enabled) return "Disabled";
  const count = keywords.filter((keyword) => keyword.value.trim()).length;
  return `${count || "No"} monitored phrase${count === 1 ? "" : "s"} ${
    mode === "found" ? "appear" : "disappear"
  }`;
}

async function send(
  request: ExtensionRequest,
  timeoutMs = CHROME_API_TIMEOUT_MS
): Promise<ExtensionResponse> {
  const response = await withTimeout(
    new Promise<ExtensionResponse>((resolve, reject) => {
      chrome.runtime.sendMessage(request, (result: ExtensionResponse) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message));
          return;
        }
        if (result === undefined) {
          reject(new Error("The background worker returned no response."));
          return;
        }
        resolve(result);
      });
    }),
    `Background request ${request.type}`,
    timeoutMs
  );
  return response;
}

async function directResetMonitor(tabId: number): Promise<void> {
  const latest = await withTimeout(
    readState(),
    "Read saved monitor for reset",
    CHROME_API_TIMEOUT_MS
  );
  delete latest.monitors[monitorKey(tabId)];
  await withTimeout(
    writeState(latest),
    "Save monitor reset",
    CHROME_API_TIMEOUT_MS
  );
  const cleanup = await Promise.allSettled([
    clearReload(tabId),
    clearScansForTab(tabId),
    withTimeout(
      chrome.storage.session.remove(`${SESSION_TOKEN_PREFIX}${tabId}`),
      "Remove tab identity",
      CHROME_API_TIMEOUT_MS
    ),
    withTimeout(
      chrome.action.setBadgeText(
        { tabId, text: null } as unknown as chrome.action.BadgeTextDetails
      ),
      "Clear tab badge override",
      CHROME_API_TIMEOUT_MS
    ),
    withTimeout(
      chrome.action.setBadgeText({
        text: (() => {
          const nextReloadAt = nearestActiveReloadAt(
            Object.values(latest.monitors)
          );
          return nextReloadAt === null
            ? ""
            : badgeForReloadDeadline(nextReloadAt).text;
        })()
      }),
      "Restore global badge",
      CHROME_API_TIMEOUT_MS
    )
  ]);
  const failure = cleanup.find(
    (result): result is PromiseRejectedResult =>
      result.status === "rejected"
  );
  if (failure) throw failure.reason;
}

async function directResetAllMonitors(): Promise<void> {
  const [latest, alarms] = await Promise.all([
    withTimeout(
      readState(),
      "Read saved monitors for reset",
      CHROME_API_TIMEOUT_MS
    ),
    withTimeout(
      chrome.alarms.getAll(),
      "Read alarms for reset",
      CHROME_API_TIMEOUT_MS
    )
  ]);
  const storedTabIds = Object.values(latest.monitors)
    .map((saved) => saved?.tabId)
    .filter((tabId): tabId is number => Number.isInteger(tabId));
  const alarmTabIds = alarms
    .map(
      (alarm) =>
        tabIdFromAlarm(alarm.name) ??
        scanIdentityFromAlarm(alarm.name)?.tabId ??
        null
    )
    .filter((tabId): tabId is number => tabId !== null);
  const tabIds = [...new Set([...storedTabIds, ...alarmTabIds])];
  await withTimeout(
    writeState({ version: 3, monitors: {} }),
    "Clear saved monitors",
    CHROME_API_TIMEOUT_MS
  );
  const cleanup = await Promise.allSettled(
    [
      withTimeout(
        chrome.action.setBadgeText({ text: "" }),
        "Clear global badge",
        CHROME_API_TIMEOUT_MS
      ),
      ...tabIds.flatMap((tabId) => [
      clearReload(tabId),
      clearScansForTab(tabId),
      withTimeout(
        chrome.storage.session.remove(`${SESSION_TOKEN_PREFIX}${tabId}`),
        `Remove tab identity ${tabId}`,
        CHROME_API_TIMEOUT_MS
      ),
      withTimeout(
        chrome.action.setBadgeText(
          { tabId, text: null } as unknown as chrome.action.BadgeTextDetails
        ),
        `Clear badge override ${tabId}`,
        CHROME_API_TIMEOUT_MS
      )
      ])
    ]
  );
  const failures = cleanup.filter(
    (result) => result.status === "rejected"
  );
  if (failures.length > 0) {
    throw new Error(
      `Saved monitors were cleared, but ${failures.length} cleanup operation(s) failed.`
    );
  }
}

function formatTimestamp(timestamp: number | null): string {
  if (timestamp === null) return "Never";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit"
  }).format(timestamp);
}

function describeBehavior(behavior: InteractionBehavior): string {
  switch (behavior) {
    case "ignore":
      return "Keep the existing countdown.";
    case "delay":
      return "Restart the countdown after interaction.";
    case "pause":
      return "Pause until you manually resume.";
    case "stop":
      return "Stop this tab's monitor.";
  }
}

function describeScanStatus(
  runtime: TabMonitor["keywordRuntime"]
): string {
  const progress = runtime.scanProgress;
  if (runtime.lastScanStatus === "retrying" && progress) {
    return `Partial scan — retrying (${progress.scannedFrameCount} checked, ${
      progress.pendingFrameCount + progress.restrictedFrameCount
    } unavailable)`;
  }
  if (runtime.lastScanStatus === "partial" && progress?.conclusive) {
    return "Partial scan — Present confirmed";
  }
  if (runtime.lastScanStatus === "complete" && progress?.restrictedFrameCount) {
    return `Scan complete — ${progress.scannedFrameCount} relevant frame${
      progress.scannedFrameCount === 1 ? "" : "s"
    } checked; ${progress.restrictedFrameCount} restricted frame${
      progress.restrictedFrameCount === 1 ? "" : "s"
    } skipped`;
  }
  return {
    idle: "Idle",
    "waiting-for-load": "Waiting for next completed load",
    "waiting-for-delay": "Waiting for scan delay",
    scanning: "Scanning visible text",
    complete: "Complete",
    partial: "Partial scan",
    retrying: "Partial scan — retrying",
    incomplete: "Scan incomplete — retry limit reached",
    error: "Scan error"
  }[runtime.lastScanStatus];
}

function matchStateLabel(value: boolean | null): string {
  if (value === null) return "Never checked";
  return value ? "Present" : "Missing";
}

export function App() {
  const [phase, setPhase] = useState<PopupPhase>("loading");
  const [tab, setTab] = useState<TabSummary | null>(null);
  const [monitor, setMonitor] = useState<TabMonitor | null>(null);
  const [intervalValue, setIntervalValue] = useState("1");
  const [intervalUnit, setIntervalUnit] =
    useState<IntervalUnit>("minutes");
  const [bypassCache, setBypassCache] = useState<boolean>(
    DEFAULT_SETTINGS.bypassCache
  );
  const [limitEnabled, setLimitEnabled] = useState(false);
  const [maximumReloads, setMaximumReloads] = useState("5");
  const [interactionBehavior, setInteractionBehavior] =
    useState<InteractionBehavior>(DEFAULT_SETTINGS.interactionBehavior);
  const [protectActiveTyping, setProtectActiveTyping] = useState<boolean>(
    DEFAULT_SETTINGS.protectActiveTyping
  );
  const [keywordEnabled, setKeywordEnabled] = useState<boolean>(
    DEFAULT_KEYWORD_MONITORING.enabled
  );
  const [keywords, setKeywords] = useState<KeywordRule[]>([]);
  const [keywordMode, setKeywordMode] = useState<KeywordMonitorMode>(
    DEFAULT_KEYWORD_MONITORING.mode
  );
  const [caseSensitive, setCaseSensitive] = useState<boolean>(
    DEFAULT_KEYWORD_MONITORING.caseSensitive
  );
  const [scanDelaySeconds, setScanDelaySeconds] = useState(
    String(DEFAULT_KEYWORD_MONITORING.scanDelayMs / 1_000)
  );
  const [actionOnDetection, setActionOnDetection] =
    useState<DetectionAction>(
      DEFAULT_KEYWORD_MONITORING.actionOnDetection
    );
  const [notificationMessage, setNotificationMessage] = useState<string>(
    DEFAULT_KEYWORD_MONITORING.notificationMessage
  );
  const [highlightMatches, setHighlightMatches] = useState<boolean>(
    DEFAULT_KEYWORD_MONITORING.highlightMatches
  );
  const [bringToFront, setBringToFront] = useState<BringToFrontMode>(
    DEFAULT_KEYWORD_MONITORING.bringToFront
  );
  const [autoOpenResult, setAutoOpenResult] = useState<AutoOpenResultMode>(
    DEFAULT_KEYWORD_MONITORING.autoOpenResult
  );
  const [keywordTestResult, setKeywordTestResult] =
    useState<KeywordTestResult | null>(null);
  const [siteAccessPreference, setSiteAccessPreference] =
    useState<SiteAccessPreference>("site");
  const [siteAccessState, setSiteAccessState] =
    useState<SiteAccessState>("required");
  const [, setPendingDraft] =
    useState<PendingMonitorDraft | null>(null);
  const [activeTab, setActiveTab] = useState<PopupTab>("interval");
  const [showAccessHelp, setShowAccessHelp] = useState(false);
  const [reloadOptionsOpen, setReloadOptionsOpen] = useState(false);
  const [keywordDraft, setKeywordDraft] = useState("");
  const [monitorAreaOpen, setMonitorAreaOpen] = useState(false);
  const [alertSettingsOpen, setAlertSettingsOpen] = useState(false);
  const [triggerActionsOpen, setTriggerActionsOpen] = useState(true);
  const [advancedSettingsOpen, setAdvancedSettingsOpen] = useState(false);
  const [monitorActivityOpen, setMonitorActivityOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const [theme, setTheme] = useState<ThemePreference>("system");
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diagnosticText, setDiagnosticText] = useState<string | null>(null);
  const [diagnosticMessage, setDiagnosticMessage] = useState<string | null>(
    null
  );
  const initializedTabId = useRef<number | null>(null);
  const initializationGeneration = useRef(0);
  const autoStartingDraft = useRef<string | null>(null);

  const intervalValidation = useMemo(
    () => validateInterval(intervalValue, intervalUnit),
    [intervalValue, intervalUnit]
  );
  const maximumValidation = useMemo(() => {
    if (!limitEnabled) return null;
    const value = Number(maximumReloads);
    if (!Number.isInteger(value) || value < 1 || value > 1_000_000) {
      return "Enter a whole number from 1 to 1,000,000.";
    }
    return null;
  }, [limitEnabled, maximumReloads]);
  const keywordConfiguration = useMemo<KeywordMonitoringConfig>(
    () => ({
      enabled: keywordEnabled,
      keywords,
      mode: keywordMode,
      caseSensitive,
      scanDelayMs: Number(scanDelaySeconds) * 1_000,
      actionOnDetection,
      highlightMatches,
      notificationMessage,
      bringToFront,
      autoOpenResult
    }),
    [
      actionOnDetection,
      autoOpenResult,
      bringToFront,
      caseSensitive,
      highlightMatches,
      keywordEnabled,
      keywordMode,
      keywords,
      notificationMessage,
      scanDelaySeconds
    ]
  );
  const keywordValidation = useMemo(() => {
    const delay = Number(scanDelaySeconds);
    if (!Number.isFinite(delay) || delay < 0 || delay > 60) {
      return "Enter a scan delay from 0 to 60 seconds.";
    }
    return validateKeywordConfig(keywordConfiguration);
  }, [keywordConfiguration, scanDelaySeconds]);
  const keywordConfigurationDirty =
    monitor !== null &&
    (monitor.keywordMonitoring.enabled !== keywordConfiguration.enabled ||
      !keywordConditionEquals(
        monitor.keywordMonitoring,
        keywordConfiguration
      ) ||
      monitor.keywordMonitoring.mode !== keywordConfiguration.mode ||
      monitor.keywordMonitoring.scanDelayMs !==
        keywordConfiguration.scanDelayMs ||
      monitor.keywordMonitoring.actionOnDetection !==
        keywordConfiguration.actionOnDetection ||
      monitor.keywordMonitoring.highlightMatches !==
        keywordConfiguration.highlightMatches ||
      monitor.keywordMonitoring.bringToFront !==
        keywordConfiguration.bringToFront ||
      monitor.keywordMonitoring.autoOpenResult !==
        keywordConfiguration.autoOpenResult ||
      monitor.keywordMonitoring.notificationMessage !==
        keywordConfiguration.notificationMessage);

  const configLocked =
    monitor?.status === "running" || monitor?.status === "paused";
  const keywordConfigLocked = monitor?.status === "running";
  const countdown = remainingMs(monitor?.nextReloadAt ?? null, now);
  const support = tab ? inspectUrl(tab.url) : null;

  const hydrateForm = useCallback((
    tabId: number,
    reloadConfig: MonitorSettings,
    keywordConfig: KeywordMonitoringConfig,
    force = false
  ): void => {
    if (!force && initializedTabId.current === tabId) return;
    initializedTabId.current = tabId;
    if (reloadConfig.intervalMs % 3_600_000 === 0) {
      setIntervalValue(String(reloadConfig.intervalMs / 3_600_000));
      setIntervalUnit("hours");
    } else if (reloadConfig.intervalMs % 60_000 === 0) {
      setIntervalValue(String(reloadConfig.intervalMs / 60_000));
      setIntervalUnit("minutes");
    } else {
      setIntervalValue(String(reloadConfig.intervalMs / 1_000));
      setIntervalUnit("seconds");
    }
    setBypassCache(reloadConfig.bypassCache);
    setLimitEnabled(reloadConfig.maximumReloads !== null);
    setMaximumReloads(String(reloadConfig.maximumReloads ?? 5));
    setInteractionBehavior(reloadConfig.interactionBehavior);
    setProtectActiveTyping(reloadConfig.protectActiveTyping);
    setKeywordEnabled(keywordConfig.enabled);
    setKeywords(keywordConfig.keywords.map((keyword) => ({ ...keyword })));
    setKeywordMode(keywordConfig.mode);
    setCaseSensitive(keywordConfig.caseSensitive);
    setScanDelaySeconds(
      String(keywordConfig.scanDelayMs / 1_000)
    );
    setActionOnDetection(keywordConfig.actionOnDetection);
    setHighlightMatches(keywordConfig.highlightMatches);
    setNotificationMessage(keywordConfig.notificationMessage);
    setBringToFront(keywordConfig.bringToFront);
    setAutoOpenResult(keywordConfig.autoOpenResult);
  }, []);

  const hydrateConfiguration = useCallback((saved: TabMonitor): void => {
    hydrateForm(saved.tabId, saved, saved.keywordMonitoring);
  }, [hydrateForm]);

  const hydrateDraft = useCallback((draft: PendingMonitorDraft): void => {
    hydrateForm(
      draft.tabId,
      draft.reloadConfig,
      draft.keywordConfig,
      true
    );
    setSiteAccessPreference(draft.siteAccessPreference);
    setPendingDraft(draft);
  }, [hydrateForm]);

  const applyResponse = useCallback((response: ExtensionResponse): void => {
    if (!response.ok) {
      throw new Error(response.error);
    }
    setTab(response.tab);
    setMonitor(response.monitor);
    if (response.monitor) hydrateConfiguration(response.monitor);
  }, [hydrateConfiguration]);

  const initializePopup = useCallback(async (): Promise<void> => {
    const generation = ++initializationGeneration.current;
    setPhase("loading");
    setError(null);
    setDiagnosticMessage(null);
    let transitioned = false;

    try {
      console.info("[popup:init]", { phase: "begin" });
      const [activeTab] = await withTimeout(
        chrome.tabs.query({ active: true, currentWindow: true }),
        "Find the active tab",
        POPUP_INIT_TIMEOUT_MS
      );
      if (generation !== initializationGeneration.current) return;
      if (activeTab?.id === undefined) {
        throw new Error("Chromium did not return an active tab.");
      }

      const summary: TabSummary = {
        id: activeTab.id,
        title: activeTab.title ?? "Untitled tab",
        url: activeTab.url ?? "",
        ...(activeTab.favIconUrl ? { favIconUrl: activeTab.favIconUrl } : {})
      };
      setTab(summary);
      const supportResult = inspectUrl(summary.url);
      if (!supportResult.supported || !supportResult.permissionPattern) {
        setSiteAccessState("unsupported");
        setPhase("unsupported");
        transitioned = true;
        console.info("[popup:init]", {
          phase: "unsupported",
          tabId: summary.id
        });
        return;
      }

      let restoredDraft: PendingMonitorDraft | null = null;
      try {
        const [durableState, savedDraft] = await Promise.all([
          withTimeout(
            readState(),
            "Read saved popup state",
            POPUP_INIT_TIMEOUT_MS
          ),
          withTimeout(
            readMonitorDraft(summary.id),
            "Read saved monitor draft",
            POPUP_INIT_TIMEOUT_MS
          )
        ]);
        const durableMonitor =
          durableState.monitors[monitorKey(summary.id)] ?? null;
        setMonitor(durableMonitor);
        if (savedDraft?.pageOrigin === supportResult.permissionPattern) {
          restoredDraft = savedDraft;
        }
        if (durableMonitor) {
          hydrateConfiguration(durableMonitor);
        } else if (restoredDraft) {
          hydrateDraft(restoredDraft);
        }
      } catch (storageError) {
        console.error("[popup:init] Local state fallback failed.", storageError);
      }

      let permissionState: SiteAccessState = "required";
      try {
        permissionState = (
          await readSitePermissionStatus(summary.url)
        ).state;
      } catch (permissionError) {
        console.error(
          "[popup:permission] Could not read permission state.",
          permissionError
        );
      }
      if (
        restoredDraft?.startState === "requesting" &&
        permissionState === "required"
      ) {
        const deniedDraft: PendingMonitorDraft = {
          ...restoredDraft,
          startState: "denied",
          technicalError: "The site permission request was denied or dismissed."
        };
        restoredDraft = deniedDraft;
        hydrateDraft(deniedDraft);
        permissionState = "denied";
        await writeMonitorDraft(deniedDraft);
      } else if (
        restoredDraft?.startState === "denied" &&
        permissionState === "required"
      ) {
        permissionState = "denied";
        setError(
          "Page access is required. Your monitor configuration has been restored."
        );
      } else if (restoredDraft?.startState === "error") {
        setError(
          "The previous start attempt did not finish. Your monitor configuration has been restored."
        );
      }
      setSiteAccessState(permissionState);

      let response = await send({
        type: "monitor:get-current",
        tabId: summary.id
      });
      if (generation !== initializationGeneration.current) return;
      if (response.ok && response.monitor && restoredDraft) {
        await removeMonitorDraft(summary.id);
        restoredDraft = null;
        setPendingDraft(null);
      } else if (
        response.ok &&
        !response.monitor &&
        restoredDraft &&
        ["pending", "requesting"].includes(restoredDraft.startState) &&
        accessSatisfiesPreference(
          permissionState,
          restoredDraft.siteAccessPreference
        )
      ) {
        const autoStartKey =
          `${restoredDraft.tabId}:${restoredDraft.savedAt}`;
        if (autoStartingDraft.current !== autoStartKey) {
          autoStartingDraft.current = autoStartKey;
          response = await send({
            type: "monitor:start",
            tabId: restoredDraft.tabId,
            settings: restoredDraft.reloadConfig,
            keywordMonitoring: restoredDraft.keywordConfig
          });
          if (response.ok && response.monitor) {
            await removeMonitorDraft(restoredDraft.tabId);
            restoredDraft = null;
            setPendingDraft(null);
          }
        }
      }
      applyResponse(response);
      setPhase("ready");
      transitioned = true;
      console.info("[popup:init]", { phase: "ready", tabId: summary.id });
    } catch (loadError) {
      if (generation !== initializationGeneration.current) return;
      const message = errorMessage(loadError);
      console.error("[popup:init]", { phase: "error", error: loadError });
      setError(message);
      setPhase("error");
      transitioned = true;
    } finally {
      if (
        generation === initializationGeneration.current &&
        !transitioned
      ) {
        setError("Popup initialization ended without a usable state.");
        setPhase("error");
      }
    }
  }, [applyResponse, hydrateConfiguration, hydrateDraft]);

  useEffect(() => {
    void initializePopup();
    return () => {
      initializationGeneration.current += 1;
    };
  }, [initializePopup]);

  useEffect(() => {
    const clockId = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(clockId);
  }, []);

  useEffect(() => {
    let disposed = false;
    void chrome.storage.local
      .get(POPUP_PREFERENCES_STORAGE_KEY)
      .then((stored) => {
        if (disposed) return;
        const saved = stored[POPUP_PREFERENCES_STORAGE_KEY] as
          | { theme?: unknown }
          | undefined;
        if (["system", "light", "dark"].includes(String(saved?.theme))) {
          setTheme(saved!.theme as ThemePreference);
        }
      })
      .catch((preferenceError) => {
        console.error("[popup:preferences] Could not load theme.", preferenceError);
      });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme =
      theme === "system" ? "light dark" : theme;
  }, [theme]);

  useEffect(() => {
    if (phase !== "ready" || !tab) return;
    let disposed = false;
    let inFlight = false;

    const refresh = async (): Promise<void> => {
      if (inFlight || disposed) return;
      inFlight = true;
      try {
        const response = await send({
          type: "monitor:get-current",
          tabId: tab.id
        });
        if (disposed) return;
        applyResponse(response);
      } catch (refreshError) {
        if (disposed) return;
        console.error("[popup:init] Background refresh failed.", refreshError);
        setError(`Background connection lost: ${errorMessage(refreshError)}`);
        setPhase("error");
      } finally {
        inFlight = false;
      }
    };

    const refreshId = window.setInterval(() => void refresh(), 2_000);
    return () => {
      disposed = true;
      window.clearInterval(refreshId);
    };
  }, [applyResponse, phase, tab]);

  const runAction = async (request: ExtensionRequest): Promise<void> => {
    if (!tab) return;
    setBusy(true);
    setError(null);
    try {
      const response = await send(request);
      applyResponse(response);
    } catch (actionError) {
      setError(
        actionError instanceof Error ? actionError.message : String(actionError)
      );
    } finally {
      setBusy(false);
    }
  };

  const start = async (): Promise<void> => {
    if (
      !tab ||
      !intervalValidation.valid ||
      maximumValidation ||
      keywordValidation
    ) {
      return;
    }
    const settings: MonitorSettings = {
      intervalMs: intervalValidation.intervalMs!,
      bypassCache,
      maximumReloads: limitEnabled ? Number(maximumReloads) : null,
      interactionBehavior,
      protectActiveTyping
    };
    const supportResult = inspectUrl(tab.url);
    if (!supportResult.supported || !supportResult.permissionPattern) {
      setSiteAccessState("unsupported");
      setError(supportResult.reason ?? "This page cannot be monitored.");
      return;
    }
    const effectivePreference: SiteAccessPreference =
      tab.url.startsWith("file:") ? "site" : siteAccessPreference;
    const draft: PendingMonitorDraft = {
      version: 1,
      tabId: tab.id,
      pageOrigin: supportResult.permissionPattern,
      savedAt: Date.now(),
      reloadConfig: settings,
      keywordConfig: { ...keywordConfiguration },
      siteAccessPreference: effectivePreference,
      startState: "pending"
    };

    setBusy(true);
    setError(null);
    try {
      await writeMonitorDraft(draft);
      setPendingDraft(draft);

      let permissionStatus = await readSitePermissionStatus(tab.url);
      setSiteAccessState(permissionStatus.state);
      if (
        !accessSatisfiesPreference(
          permissionStatus.state,
          effectivePreference
        )
      ) {
        const requestingDraft: PendingMonitorDraft = {
          ...draft,
          startState: "requesting"
        };
        await writeMonitorDraft(requestingDraft);
        setPendingDraft(requestingDraft);
        const origins = permissionOriginsFor(tab.url, effectivePreference);
        const granted = await chrome.permissions.request({ origins });
        if (!granted) {
          const deniedDraft: PendingMonitorDraft = {
            ...requestingDraft,
            startState: "denied",
            technicalError:
              "The site permission request was denied or dismissed."
          };
          await writeMonitorDraft(deniedDraft);
          setPendingDraft(deniedDraft);
          setSiteAccessState("denied");
          setError(
            "Page access is required. Your monitor configuration has been saved."
          );
          return;
        }
        permissionStatus = await readSitePermissionStatus(tab.url);
        setSiteAccessState(permissionStatus.state);
      }

      const response = await send({
        type: "monitor:start",
        tabId: draft.tabId,
        settings: draft.reloadConfig,
        keywordMonitoring: draft.keywordConfig
      });
      applyResponse(response);
      if (response.ok && response.monitor) {
        await removeMonitorDraft(draft.tabId);
        setPendingDraft(null);
      }
    } catch (startError) {
      const technicalError = errorMessage(startError);
      console.error("[popup:permission] Monitor start failed.", startError);
      const failedDraft: PendingMonitorDraft = {
        ...draft,
        startState: "error",
        technicalError
      };
      try {
        await writeMonitorDraft(failedDraft);
        setPendingDraft(failedDraft);
      } catch (draftError) {
        console.error(
          "[popup:permission] Could not update the saved draft.",
          draftError
        );
      }
      setError(
        "The monitor could not be started. Your configuration remains saved."
      );
    } finally {
      setBusy(false);
    }
  };

  const grantAccessAndRetryScan = async (): Promise<void> => {
    if (!tab || !monitor) return;
    setBusy(true);
    setError(null);
    try {
      let permissionStatus = await readSitePermissionStatus(tab.url);
      if (
        !accessSatisfiesPreference(
          permissionStatus.state,
          siteAccessPreference
        )
      ) {
        const origins = permissionOriginsFor(
          tab.url,
          tab.url.startsWith("file:") ? "site" : siteAccessPreference
        );
        const granted = await chrome.permissions.request({ origins });
        if (!granted) {
          setSiteAccessState("denied");
          setError("Page access is required to scan this site.");
          return;
        }
        permissionStatus = await readSitePermissionStatus(tab.url);
      }
      setSiteAccessState(permissionStatus.state);
      const response = await send({
        type: "monitor:retry-scan",
        tabId: tab.id
      });
      applyResponse(response);
    } catch (permissionError) {
      console.error(
        "[popup:permission] Could not grant page access.",
        permissionError
      );
      setError(
        "Page access could not be updated. Review extension site access and try again."
      );
    } finally {
      setBusy(false);
    }
  };

  const saveKeywordConfiguration = async (): Promise<void> => {
    if (!tab || !monitor || keywordValidation) return;
    await runAction({
      type: "monitor:update-keyword",
      tabId: tab.id,
      keywordMonitoring: keywordConfiguration
    });
  };

  const addKeyword = (): void => {
    if (keywords.length >= MAX_KEYWORDS_PER_MONITOR) {
      setError(`A monitor can contain up to ${MAX_KEYWORDS_PER_MONITOR} keywords.`);
      return;
    }
    const value = keywordDraft.trim();
    if (!value) return;
    setKeywords((current) => [...current, createKeywordRule(value)]);
    setKeywordDraft("");
    setKeywordTestResult(null);
  };

  const updateKeyword = (id: string, value: string): void => {
    setKeywords((current) =>
      current.map((keyword) =>
        keyword.id === id ? { ...keyword, value } : keyword
      )
    );
    setKeywordTestResult(null);
  };

  const removeKeyword = (id: string): void => {
    setKeywords((current) =>
      current.filter((keyword) => keyword.id !== id)
    );
    setKeywordTestResult(null);
  };

  const testKeywords = async (): Promise<void> => {
    if (!tab || keywordValidation) return;
    setBusy(true);
    setError(null);
    try {
      const response = await send({
        type: "monitor:test-keywords",
        tabId: tab.id,
        keywordMonitoring: { ...keywordConfiguration, enabled: true }
      });
      if (!response.ok) throw new Error(response.error);
      applyResponse(response);
      setKeywordTestResult(response.testResult ?? null);
    } catch (testError) {
      setError(errorMessage(testError));
    } finally {
      setBusy(false);
    }
  };

  const clearPageHighlights = async (): Promise<void> => {
    if (!tab) return;
    setKeywordTestResult(null);
    await runAction({ type: "monitor:clear-highlights", tabId: tab.id });
  };

  const clearHistory = async (): Promise<void> => {
    if (!tab || !monitor) return;
    await runAction({ type: "monitor:clear-history", tabId: tab.id });
  };

  const resetBaseline = async (): Promise<void> => {
    if (!tab || !monitor) return;
    await runAction({ type: "monitor:reset-baseline", tabId: tab.id });
  };

  const resetCurrent = async (): Promise<void> => {
    if (!tab) return;
    setBusy(true);
    setError(null);
    let usedFallback = false;
    try {
      try {
        const response = await send({
          type: "monitor:reset",
          tabId: tab.id
        });
        applyResponse(response);
      } catch (backgroundError) {
        usedFallback = true;
        console.error(
          "[popup:init] Background reset unavailable; using durable fallback.",
          backgroundError
        );
        await directResetMonitor(tab.id);
        setMonitor(null);
      }
      initializedTabId.current = null;
      setDiagnosticMessage(
        usedFallback
          ? "Saved monitor and alarm cleared directly. Restart the extension if its worker remains unresponsive."
          : "Monitor, alarm, and badge cleared."
      );
      setPhase(inspectUrl(tab.url).supported ? "ready" : "unsupported");
    } catch (resetError) {
      setError(`Reset failed: ${errorMessage(resetError)}`);
      setPhase("error");
    } finally {
      setBusy(false);
    }
  };

  const reconcileExtensionState = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const response = await send(
        {
          type: "monitor:reconcile",
          tabId: tab?.id ?? null
        },
        POPUP_INIT_TIMEOUT_MS + 2_000
      );
      applyResponse(response);
      setDiagnosticMessage(response.ok ? response.message ?? null : null);
      setPhase(tab && !inspectUrl(tab.url).supported ? "unsupported" : "ready");
    } catch (reconcileError) {
      setError(`State reload failed: ${errorMessage(reconcileError)}`);
      setPhase("error");
    } finally {
      setBusy(false);
    }
  };

  const showDiagnostics = async (): Promise<void> => {
    setBusy(true);
    setDiagnosticMessage(null);
    const tabId = tab?.id ?? null;
    try {
      const [backgroundResult, storageResult, alarmsResult, tabResult] =
        await Promise.allSettled([
          send({ type: "monitor:diagnostics", tabId }),
          withTimeout(
            chrome.storage.local.get([
              STORAGE_KEY,
              MONITOR_DRAFTS_STORAGE_KEY
            ]),
            "Read local diagnostic state",
            POPUP_INIT_TIMEOUT_MS
          ),
          withTimeout(
            chrome.alarms.getAll(),
            "Read local diagnostic alarms",
            POPUP_INIT_TIMEOUT_MS
          ),
          tabId === null
            ? Promise.resolve(null)
            : withTimeout(
                chrome.tabs.get(tabId),
                "Read local diagnostic tab",
                POPUP_INIT_TIMEOUT_MS
              )
        ]);

      const report = {
        capturedAt: new Date().toISOString(),
        popup: {
          phase,
          error,
          tab,
          monitor,
          now: Date.now()
        },
        background:
          backgroundResult.status === "fulfilled"
            ? backgroundResult.value
            : { error: errorMessage(backgroundResult.reason) },
        localStorage:
          storageResult.status === "fulfilled"
            ? storageResult.value
            : { error: errorMessage(storageResult.reason) },
        alarms:
          alarmsResult.status === "fulfilled"
            ? alarmsResult.value.map((alarm) => ({
                name: alarm.name,
                scheduledTime: alarm.scheduledTime,
                periodInMinutes: alarm.periodInMinutes ?? null
              }))
            : { error: errorMessage(alarmsResult.reason) },
        currentTab:
          tabResult.status === "fulfilled"
            ? tabResult.value
            : { error: errorMessage(tabResult.reason) }
      };
      setDiagnosticText(JSON.stringify(report, null, 2));
      setDiagnosticMessage(
        "Diagnostics are local. Review them before copying or sharing."
      );
    } finally {
      setBusy(false);
    }
  };

  const copyDiagnostics = async (): Promise<void> => {
    if (!diagnosticText) return;
    try {
      await navigator.clipboard.writeText(diagnosticText);
      setDiagnosticMessage("Diagnostic details copied.");
    } catch (copyError) {
      setError(`Could not copy diagnostics: ${errorMessage(copyError)}`);
    }
  };

  const resetAll = async (): Promise<void> => {
    if (
      !window.confirm(
        "Reset every Lucky Fetch monitor and cancel all saved reload alarms?"
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      try {
        const response = await send({
          type: "monitor:reset-all",
          tabId: tab?.id ?? null
        });
        applyResponse(response);
      } catch (backgroundError) {
        console.error(
          "[popup:init] Background full reset unavailable; using durable fallback.",
          backgroundError
        );
        await directResetAllMonitors();
        setMonitor(null);
      }
      initializedTabId.current = null;
      setDiagnosticMessage("All saved monitors and reload alarms were cleared.");
      setPhase(
        tab && !inspectUrl(tab.url).supported ? "unsupported" : "ready"
      );
    } catch (resetError) {
      setError(`Full reset failed: ${errorMessage(resetError)}`);
      setPhase("error");
    } finally {
      setBusy(false);
    }
  };

  const grantSiteAccess = async (): Promise<void> => {
    if (!tab) return;
    setBusy(true);
    setError(null);
    try {
      const effectivePreference: SiteAccessPreference =
        tab.url.startsWith("file:") ? "site" : siteAccessPreference;
      const granted = await chrome.permissions.request({
        origins: permissionOriginsFor(tab.url, effectivePreference)
      });
      const permissionStatus = await readSitePermissionStatus(tab.url);
      setSiteAccessState(granted ? permissionStatus.state : "denied");
      if (!granted) {
        setError("Site access was not granted. You can try again when ready.");
      }
    } catch (permissionError) {
      console.error("[popup:permission] Could not grant site access.", permissionError);
      setError("Site access could not be updated.");
    } finally {
      setBusy(false);
    }
  };

  const chooseTheme = (nextTheme: ThemePreference): void => {
    setTheme(nextTheme);
    void chrome.storage.local
      .set({
        [POPUP_PREFERENCES_STORAGE_KEY]: { theme: nextTheme }
      })
      .catch((preferenceError) => {
        console.error("[popup:preferences] Could not save theme.", preferenceError);
        setError("The theme preference could not be saved.");
      });
  };

  const adjustInterval = (direction: -1 | 1): void => {
    const current = Number(intervalValue);
    const minimum = intervalUnit === "seconds" ? 30 : intervalUnit === "minutes" ? 0.5 : 0.01;
    const step = intervalUnit === "seconds" ? 30 : 1;
    const next = Number.isFinite(current)
      ? Math.max(minimum, current + direction * step)
      : minimum;
    setIntervalValue(String(Number(next.toFixed(2))));
  };

  const statusText = monitor?.errorMessage
    ? "Error"
    : monitor?.status === "running"
      ? "Running"
      : monitor?.status === "paused"
        ? "Paused"
        : "Ready";
  const statusTone = monitor?.errorMessage || monitor?.status === "error"
    ? "error"
    : monitor?.status === "paused"
      ? "waiting"
      : monitor?.status === "running"
        ? "running"
        : "neutral";

  const header = (
    <header className="app-header">
      <img src="/icons/icon-48.png" width="30" height="30" alt="" />
      <div className="brand-copy">
        <h1>Lucky Fetch</h1>
        <p>v{typeof chrome !== "undefined" ? chrome.runtime.getManifest().version : "0.2.0"} <span aria-hidden="true">·</span> Reliable reloads, tab by tab</p>
      </div>
      {phase === "ready" && (
        <div className="header-actions">
          <button
            type="button"
            className="icon-button settings-button"
            aria-label="Open settings"
            aria-expanded={settingsOpen}
            aria-controls="popup-settings"
            onClick={() => setSettingsOpen((open) => !open)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 8.25A3.75 3.75 0 1 0 12 15.75 3.75 3.75 0 0 0 12 8.25ZM19.25 13.4l1.25 1-.16 1.05-1.5 2.6-1 .4-1.5-.58a8.2 8.2 0 0 1-1.5.86L14.6 20.3l-.84.65h-3l-.84-.65-.24-1.57a8.2 8.2 0 0 1-1.5-.86l-1.5.58-1-.4-1.5-2.6-.16-1.05 1.25-1a8.13 8.13 0 0 1 0-1.72l-1.25-1 .16-1.05 1.5-2.6 1-.4 1.5.58a8.2 8.2 0 0 1 1.5-.86l.24-1.57.84-.65h3l.84.65.24 1.57a8.2 8.2 0 0 1 1.5.86l1.5-.58 1 .4 1.5 2.6.16 1.05-1.25 1a8.13 8.13 0 0 1 0 1.72Z" />
            </svg>
          </button>
        </div>
      )}
    </header>
  );

  const tabs = (
    <nav className="popup-tabs" role="tablist" aria-label="Lucky Fetch controls">
      <button
        type="button"
        role="tab"
        id="interval-tab"
        aria-controls="interval-panel"
        aria-selected={activeTab === "interval"}
        tabIndex={activeTab === "interval" ? 0 : -1}
        className={activeTab === "interval" ? "active" : ""}
        disabled={phase !== "ready"}
        onClick={() => setActiveTab("interval")}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight" || event.key === "End") {
            event.preventDefault();
            setActiveTab("monitor");
            document.getElementById("monitor-tab")?.focus();
          }
        }}
      >
        Interval
      </button>
      <button
        type="button"
        role="tab"
        id="monitor-tab"
        aria-controls="monitor-panel"
        aria-selected={activeTab === "monitor"}
        tabIndex={activeTab === "monitor" ? 0 : -1}
        className={activeTab === "monitor" ? "active" : ""}
        disabled={phase !== "ready"}
        onClick={() => setActiveTab("monitor")}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" || event.key === "Home") {
            event.preventDefault();
            setActiveTab("interval");
            document.getElementById("interval-tab")?.focus();
          }
        }}
      >
        Monitor
        {keywordEnabled && <span className="tab-indicator" aria-label="enabled" />}
      </button>
    </nav>
  );

  const recoveryStatus =
    phase === "loading"
      ? "Restoring saved state"
      : phase === "unsupported"
        ? "Unsupported page"
        : "Error";
  const canStopDuringRecovery =
    tab !== null &&
    monitor !== null &&
    ["running", "paused"].includes(monitor.status);
  const recoveryFooter = (
    <footer className="controls app-footer">
      <div className="footer-status" aria-live="polite" aria-atomic="true">
        <span
          className={`status-dot ${phase === "error" ? "status-dot-error" : "status-dot-neutral"}`}
          aria-hidden="true"
        />
        <span className="status-summary">
          <strong>{recoveryStatus}</strong>
          {monitor && ` · ${monitor.reloadCount} reloads`}
        </span>
      </div>
      <div className="footer-actions">
        {canStopDuringRecovery && tab ? (
          <button
            type="button"
            className="stop-button"
            disabled={busy}
            onClick={() =>
              void runAction({ type: "monitor:stop", tabId: tab.id })
            }
          >
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="primary-button"
            disabled={busy || phase === "loading"}
            onClick={() => void initializePopup()}
          >
            Retry
          </button>
        )}
        <button type="button" className="secondary-button" disabled>
          Reload now
        </button>
      </div>
    </footer>
  );

  const readyFooter = tab ? (
    <footer className="controls app-footer">
      <div className="footer-status" aria-live="polite" aria-atomic="true">
        <span className={`status-dot status-dot-${statusTone}`} aria-hidden="true" />
        <span className="status-summary">
          <strong>{statusText}</strong>
          <span aria-hidden="true"> · </span>
          {monitor?.reloadCount ?? 0} reloads
          <span aria-hidden="true"> · </span>
          Next: {formatCountdown(countdown)}
        </span>
        {monitor?.status === "running" && (
          <button
            type="button"
            className="footer-text-action"
            disabled={busy}
            onClick={() =>
              void runAction({ type: "monitor:pause", tabId: tab.id })
            }
          >
            Pause
          </button>
        )}
      </div>
      <div className="footer-actions">
        {!monitor || ["stopped", "completed", "error"].includes(monitor.status) ? (
          <>
            <button
              type="button"
              className="primary-button"
              disabled={
                busy ||
                !support?.supported ||
                !intervalValidation.valid ||
                maximumValidation !== null ||
                keywordValidation !== null
              }
              onClick={() => void start()}
            >
              {busy ? "Starting…" : monitor ? "Start new run" : "Start"}
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={busy || monitor?.status === "completed"}
              title="Reload immediately. A running countdown restarts."
              onClick={() =>
                void runAction({ type: "monitor:reload-now", tabId: tab.id })
              }
            >
              Reload now
            </button>
          </>
        ) : monitor.status === "paused" ? (
          <>
            <button
              type="button"
              className="primary-button"
              disabled={busy || keywordConfigurationDirty}
              title={
                keywordConfigurationDirty
                  ? "Save keyword settings before resuming."
                  : undefined
              }
              onClick={() =>
                void runAction({ type: "monitor:resume", tabId: tab.id })
              }
            >
              Resume
            </button>
            <button
              type="button"
              className="stop-button"
              disabled={busy}
              onClick={() =>
                void runAction({ type: "monitor:stop", tabId: tab.id })
              }
            >
              Stop
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="stop-button"
              disabled={busy}
              onClick={() =>
                void runAction({ type: "monitor:stop", tabId: tab.id })
              }
            >
              Stop
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              title="Reload immediately. A running countdown restarts."
              onClick={() =>
                void runAction({ type: "monitor:reload-now", tabId: tab.id })
              }
            >
              Reload now
            </button>
          </>
        )}
      </div>
    </footer>
  ) : recoveryFooter;

  if (phase === "loading") {
    return (
      <AppShell
        header={header}
        tabs={tabs}
        footer={recoveryFooter}
        variant="loading-state recovery-popup"
      >
        <section className="recovery-card" aria-live="polite">
          <div className="loading-spinner" aria-hidden="true" />
          <h2>Loading current tab…</h2>
          <p>This will stop automatically if Chromium does not respond.</p>
        </section>
      </AppShell>
    );
  }

  if (phase === "error") {
    return (
      <AppShell
        header={header}
        tabs={tabs}
        footer={recoveryFooter}
        variant="recovery-popup"
      >
        {tab && (
          <section className="page-card">
            <span className="section-kicker">Current page</span>
            <div className="page-title">{tab.title}</div>
            <div className="page-url">{tab.url}</div>
          </section>
        )}
        <section className="recovery-card error-recovery" role="alert">
          <span className="recovery-icon" aria-hidden="true">!</span>
          <h2>Lucky Fetch couldn’t initialize</h2>
          <p>{error ?? "The extension background worker did not respond."}</p>
          <div className="recovery-actions">
            <button
              type="button"
              className="primary-button"
              disabled={busy}
              onClick={() => void initializePopup()}
            >
              Retry
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={busy || !tab || !monitor}
              onClick={() => void resetCurrent()}
            >
              Reset this tab
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => void reconcileExtensionState()}
            >
              Reload extension state
            </button>
            <button
              type="button"
              className="ghost-button"
              disabled={busy}
              onClick={() => void showDiagnostics()}
            >
              Show diagnostics
            </button>
          </div>
          <button
            type="button"
            className="text-button"
            onClick={() => chrome.runtime.reload()}
          >
            Restart extension worker
          </button>
        </section>
        {diagnosticText && (
          <section className="diagnostics-panel">
            <label htmlFor="diagnostic-details">Diagnostic details</label>
            <textarea
              id="diagnostic-details"
              readOnly
              value={diagnosticText}
            />
            <div className="diagnostic-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => void copyDiagnostics()}
              >
                Copy details
              </button>
              <button
                type="button"
                className="text-button danger-text"
                disabled={busy}
                onClick={() => void resetAll()}
              >
                Reset all monitors
              </button>
            </div>
          </section>
        )}
        {diagnosticMessage && (
          <p className="diagnostic-message" aria-live="polite">
            {diagnosticMessage}
          </p>
        )}
      </AppShell>
    );
  }

  if (phase === "unsupported" && tab) {
    return (
      <AppShell
        header={header}
        tabs={tabs}
        footer={recoveryFooter}
        variant="recovery-popup"
      >
        <section className="page-card">
          <span className="section-kicker">Current page</span>
          <div className="page-title">{tab.title}</div>
          <div className="page-url">{tab.url}</div>
        </section>
        <section className="recovery-card unsupported-card">
          <span className="recovery-icon" aria-hidden="true">×</span>
          <h2>This page cannot be monitored by browser extensions.</h2>
          <p>{inspectUrl(tab.url).reason}</p>
          {monitor && (
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => void resetCurrent()}
            >
              Reset stale monitor for this tab
            </button>
          )}
          <button
            type="button"
            className="ghost-button"
            disabled={busy}
            onClick={() => void showDiagnostics()}
          >
            Show diagnostics
          </button>
        </section>
        {diagnosticText && (
          <section className="diagnostics-panel">
            <label htmlFor="unsupported-diagnostics">Diagnostic details</label>
            <textarea
              id="unsupported-diagnostics"
              readOnly
              value={diagnosticText}
            />
            <button
              type="button"
              className="secondary-button"
              onClick={() => void copyDiagnostics()}
            >
              Copy details
            </button>
          </section>
        )}
      </AppShell>
    );
  }

  if (!tab) {
    return (
      <AppShell
        header={header}
        tabs={tabs}
        footer={recoveryFooter}
        variant="recovery-popup"
      >
        <section className="recovery-card error-recovery">
          <h2>No active tab is available</h2>
          <button
            type="button"
            className="primary-button"
            onClick={() => void initializePopup()}
          >
            Retry
          </button>
        </section>
      </AppShell>
    );
  }

  return (
    <AppShell header={header} tabs={tabs} footer={readyFooter}>
      {settingsOpen && (
        <section className="settings-panel" id="popup-settings" aria-label="Settings">
          <div className="settings-panel-heading">
            <strong>Settings</strong>
            <button
              type="button"
              className="icon-button"
              aria-label="Close settings"
              onClick={() => setSettingsOpen(false)}
            >
              ×
            </button>
          </div>

          <div className="settings-group">
            <span className="field-label">Theme</span>
            <div className="segmented-control" aria-label="Theme">
              {(["system", "light", "dark"] as const).map((option) => (
                <button
                  type="button"
                  key={option}
                  className={theme === option ? "selected" : ""}
                  aria-pressed={theme === option}
                  onClick={() => chooseTheme(option)}
                >
                  {option.charAt(0).toUpperCase() + option.slice(1)}
                </button>
              ))}
            </div>
          </div>

          <div className="settings-group permission-settings">
            <button
              type="button"
              className="settings-disclosure"
              aria-expanded={permissionsOpen}
              aria-controls="permission-settings"
              onClick={() => setPermissionsOpen((open) => !open)}
            >
              <span>
                <strong>Permissions</strong>
                <small>
                  {siteAccessState === "granted-all"
                    ? "All websites"
                    : siteAccessState === "granted-site"
                      ? "This website"
                      : "Access required"}
                </small>
              </span>
              <span aria-hidden="true">{permissionsOpen ? "−" : "+"}</span>
            </button>
            {permissionsOpen && (
              <div id="permission-settings" className="permission-details">
                <label className="access-choice">
                  <input
                    type="radio"
                    name="site-access-menu"
                    checked={siteAccessPreference === "site"}
                    onChange={() => setSiteAccessPreference("site")}
                  />
                  <span>
                    <b>This website only</b>
                    <small>{support?.permissionPattern}</small>
                  </span>
                </label>
                <label className="access-choice">
                  <input
                    type="radio"
                    name="site-access-menu"
                    checked={siteAccessPreference === "all"}
                    disabled={tab.url.startsWith("file:")}
                    onChange={() => setSiteAccessPreference("all")}
                  />
                  <span>
                    <b>All websites</b>
                    <small>Only tabs with an active monitor are scanned.</small>
                  </span>
                </label>
                {!["granted-site", "granted-all"].includes(siteAccessState) && (
                  <button
                    type="button"
                    className="secondary-button compact-button"
                    disabled={busy}
                    onClick={() => void grantSiteAccess()}
                  >
                    Grant selected access
                  </button>
                )}
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setShowAccessHelp((visible) => !visible)}
                >
                  Manage in browser
                </button>
                {showAccessHelp && (
                  <p className="access-help">
                    Open Extensions, choose Lucky Fetch, then Details and Site
                    access to review or revoke access.
                  </p>
                )}
              </div>
            )}
          </div>

          <div className="settings-links">
            {monitor && (
              <button
                type="button"
                className="text-button danger-text"
                disabled={busy}
                onClick={() => void resetCurrent()}
              >
                Reset this tab
              </button>
            )}
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() => void showDiagnostics()}
            >
              {diagnosticText ? "Refresh diagnostics" : "Diagnostics"}
            </button>
            <button
              type="button"
              className="text-button danger-text"
              disabled={busy}
              onClick={() => void resetAll()}
            >
              Reset all
            </button>
          </div>
        </section>
      )}



      {activeTab === "interval" &&
        !["granted-site", "granted-all"].includes(siteAccessState) && (
        <section className="permission-banner" role="status">
          <span className="permission-icon" aria-hidden="true">!</span>
          <div>
            <strong>Site access required</strong>
            <small>Allow Lucky Fetch to reload {pageHost(tab.url)}.</small>
          </div>
          <button
            type="button"
            className="secondary-button compact-button"
            disabled={busy}
            onClick={() => void grantSiteAccess()}
          >
            Grant access
          </button>
        </section>
      )}

      <div
        id="interval-panel"
        className="tab-panel interval-panel"
        role="tabpanel"
        aria-labelledby="interval-tab"
        hidden={activeTab !== "interval"}
      >
      <section className="configuration" aria-labelledby="configuration-heading">
        <div className="section-heading-row">
          <div>
            <span className="section-kicker">Refresh interval</span>
            <h2 id="configuration-heading">Choose how often to reload</h2>
          </div>
          {configLocked && <span className="locked-pill">Locked while active</span>}
        </div>

        <fieldset disabled={configLocked || busy}>
          <legend className="sr-only">Reload interval</legend>
          <div className="interval-card-heading">
            <label htmlFor="interval-value">Interval</label>
            <select
              className="interval-unit-select"
              aria-label="Interval unit"
              value={intervalUnit}
              onChange={(event) =>
                setIntervalUnit(event.target.value as IntervalUnit)
              }
            >
              <option value="seconds">Seconds</option>
              <option value="minutes">Minutes</option>
              <option value="hours">Hours</option>
            </select>
          </div>
          <div className="interval-stepper">
            <button
              type="button"
              className="stepper-button"
              aria-label={`Decrease interval in ${intervalUnit}`}
              onClick={() => adjustInterval(-1)}
            >
              −
            </button>
            <input
              id="interval-value"
              className="interval-value"
              type="number"
              min="0"
              step="any"
              inputMode="decimal"
              value={intervalValue}
              aria-describedby="interval-help interval-error"
              onChange={(event) => setIntervalValue(event.target.value)}
            />
            <button
              type="button"
              className="stepper-button"
              aria-label={`Increase interval in ${intervalUnit}`}
              onClick={() => adjustInterval(1)}
            >
              +
            </button>
          </div>
          {!intervalValidation.valid && (
            <p className="field-error" id="interval-error">
              {intervalValidation.error}
            </p>
          )}

          <div className="preset-row" aria-label="Interval presets">
            {PRESETS.map((preset) => (
              <button
                type="button"
                className={`preset-button ${
                  intervalValidation.valid &&
                  intervalValidation.intervalMs ===
                    preset.value *
                      (preset.unit === "seconds" ? 1_000 : 60_000)
                    ? "active"
                    : ""
                }`}
                key={preset.label}
                aria-pressed={
                  intervalValidation.valid &&
                  intervalValidation.intervalMs ===
                    preset.value *
                      (preset.unit === "seconds" ? 1_000 : 60_000)
                }
                onClick={() => {
                  setIntervalValue(String(preset.value));
                  setIntervalUnit(preset.unit);
                }}
              >
                {preset.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            className="accordion-trigger"
            aria-expanded={reloadOptionsOpen}
            aria-controls="reload-options-panel"
            onClick={() => setReloadOptionsOpen((open) => !open)}
          >
            <span className="accordion-chevron" aria-hidden="true">
              {reloadOptionsOpen ? "▾" : "▸"}
            </span>
            <span className="accordion-copy">
              <strong>Reload options</strong>
              <small>
                {interactionSummary(
                  interactionBehavior,
                  protectActiveTyping,
                  bypassCache,
                  limitEnabled,
                  maximumReloads
                )}
              </small>
            </span>
          </button>

          {reloadOptionsOpen && (
          <div className="accordion-panel" id="reload-options-panel">
          <div className="setting-row">
            <div>
              <label htmlFor="bypass-cache">Force reload without cache</label>
              <p>May use more bandwidth and load pages more slowly.</p>
            </div>
            <input
              id="bypass-cache"
              className="switch"
              type="checkbox"
              checked={bypassCache}
              onChange={(event) => setBypassCache(event.target.checked)}
            />
          </div>

          <div className="setting-row setting-row-stack">
            <div className="setting-row-inline">
              <label htmlFor="limit-reloads">
                Stop after a maximum number of reloads
              </label>
              <input
                id="limit-reloads"
                className="switch"
                type="checkbox"
                checked={limitEnabled}
                onChange={(event) => setLimitEnabled(event.target.checked)}
              />
            </div>
            {limitEnabled && (
              <>
                <input
                  className="count-input"
                  type="number"
                  min="1"
                  max="1000000"
                  step="1"
                  value={maximumReloads}
                  aria-label="Maximum reload count"
                  onChange={(event) => setMaximumReloads(event.target.value)}
                />
                {maximumValidation && (
                  <p className="field-error">{maximumValidation}</p>
                )}
              </>
            )}
          </div>

          <label className="field-label" htmlFor="interaction-behavior">
            When I interact with the page
          </label>
          <select
            id="interaction-behavior"
            className="full-select"
            value={interactionBehavior}
            onChange={(event) =>
              setInteractionBehavior(
                event.target.value as InteractionBehavior
              )
            }
          >
            <option value="ignore">Ignore — keep counting down</option>
            <option value="delay">Delay — restart countdown</option>
            <option value="pause">Pause — resume manually</option>
            <option value="stop">Stop — end monitoring</option>
          </select>
          <p className="field-help">{describeBehavior(interactionBehavior)}</p>

          <div className="setting-row typing-setting">
            <div>
              <label htmlFor="typing-protection">
                Never reload while I’m actively typing
              </label>
              <p>Waits until keyboard or form input has been idle for 5 seconds.</p>
            </div>
            <input
              id="typing-protection"
              className="switch"
              type="checkbox"
              checked={protectActiveTyping}
              onChange={(event) => setProtectActiveTyping(event.target.checked)}
            />
          </div>
          </div>
          )}
        </fieldset>
      </section>

      </div>

      <section
        id="monitor-panel"
        role="tabpanel"
        aria-labelledby="monitor-tab"
        hidden={activeTab !== "monitor"}
        className="configuration keyword-monitoring tab-panel"
      >
        <div className="feature-header">
          <div className="feature-disclosure">
            <span className="accordion-copy">
              <span className="section-kicker">Page monitor</span>
              <strong id="keyword-monitoring-heading">Keyword monitoring</strong>
              <small>{keywordSummary(keywordEnabled, keywords, keywordMode)}</small>
            </span>
          </div>
          <label className="toggle-only">
            <span className="sr-only">Enable keyword monitoring</span>
            <input
              id="keyword-enabled"
              className="switch"
              type="checkbox"
              checked={keywordEnabled}
              disabled={keywordConfigLocked || busy}
              onChange={(event) => {
                const enabled = event.target.checked;
                setKeywordEnabled(enabled);
                if (!enabled) {
                  setKeywords((current) =>
                    current.filter((keyword) => keyword.value.trim())
                  );
                }
              }}
            />
          </label>
        </div>
        {keywordConfigLocked && (
          <span className="locked-pill keyword-lock">Pause to edit</span>
        )}

        {keywordEnabled && (
        <div className="feature-panel" id="keyword-monitoring-panel">
        <fieldset disabled={keywordConfigLocked || busy}>
          <span className="field-label">Detection mode</span>
          <div className="mode-segments" role="group" aria-label="Detection mode">
            <button
              type="button"
              className={keywordMode === "found" ? "selected" : ""}
              aria-pressed={keywordMode === "found"}
              onClick={() => setKeywordMode("found")}
            >
              <span className="mode-icon" aria-hidden="true">✓</span>
              <span><b>Found</b><small>When a phrase appears</small></span>
            </button>
            <button
              type="button"
              className={keywordMode === "lost" ? "selected" : ""}
              aria-pressed={keywordMode === "lost"}
              onClick={() => setKeywordMode("lost")}
            >
              <span className="mode-icon" aria-hidden="true">−</span>
              <span><b>Lost</b><small>When a phrase disappears</small></span>
            </button>
          </div>

          <span className="field-label keyword-field-label">
            Keywords or phrases
          </span>
          <div className="keyword-compose">
            <label className="sr-only" htmlFor="keyword-draft">Add a keyword or phrase</label>
            <input
              id="keyword-draft"
              className="text-input"
              type="text"
              value={keywordDraft}
              maxLength={200}
              placeholder="Enter a keyword or phrase"
              autoComplete="off"
              onChange={(event) => setKeywordDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && keywordDraft.trim()) {
                  event.preventDefault();
                  addKeyword();
                }
              }}
            />
            <button
              type="button"
              className="primary-button keyword-add-button"
              disabled={!keywordDraft.trim() || keywords.length >= MAX_KEYWORDS_PER_MONITOR}
              onClick={addKeyword}
            >
              Add
            </button>
          </div>
          <div className="keyword-list" role="group" aria-label="Keywords or phrases">
            {keywords.length === 0 && (
              <div className="empty-keywords">
                <span aria-hidden="true">⌁</span>
                <strong>No keywords yet</strong>
                <p>Add a phrase above to begin monitoring this page.</p>
              </div>
            )}
            {keywords.map((keyword, index) => (
              <div className="keyword-row" key={keyword.id}>
                <label className="sr-only" htmlFor={`keyword-${keyword.id}`}>
                  Keyword or phrase {index + 1}
                </label>
                <input
                  id={`keyword-${keyword.id}`}
                  className="text-input"
                  type="text"
                  value={keyword.value}
                  maxLength={200}
                  placeholder={index === 0 ? "New Ticket" : "Another phrase"}
                  autoComplete="off"
                  onChange={(event) =>
                    updateKeyword(keyword.id, event.target.value)
                  }
                />
                <button
                  type="button"
                  className="keyword-remove"
                  aria-label={`Remove keyword ${index + 1}`}
                  onClick={() => removeKeyword(keyword.id)}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
          <p className="field-help">
            The condition is considered present when any configured keyword is found.
          </p>

          <div className="monitor-section">
          <button
            type="button"
            className="monitor-section-header"
            aria-expanded={alertSettingsOpen}
            aria-controls="alert-settings-panel"
            onClick={() => setAlertSettingsOpen((open) => !open)}
          >
            <span className="section-icon custom-section-icon" aria-hidden="true">
              <img src="/icons/settings/alert.png" alt="" />
            </span>
            <span><b>Alert settings</b><small>Notification label</small></span>
            <span className="section-chevron" aria-hidden="true">{alertSettingsOpen ? "▾" : "▸"}</span>
          </button>
          {alertSettingsOpen && (
          <div className="monitor-section-body" id="alert-settings-panel">
          <label
            className="field-label keyword-field-label"
            htmlFor="notification-message"
          >
            Monitor name (optional)
          </label>
          <input
            id="notification-message"
            className="text-input"
            type="text"
            value={notificationMessage}
            placeholder="New ticket"
            autoComplete="off"
            onChange={(event) => setNotificationMessage(event.target.value)}
          />
          <p className="field-help">
            When set, this name is used as the browser notification title.
          </p>
          </div>
          )}
          </div>

          <div className="monitor-section">
          <button
            type="button"
            className="monitor-section-header"
            aria-expanded={monitorAreaOpen}
            aria-controls="monitored-area-panel"
            onClick={() => setMonitorAreaOpen((open) => !open)}
          >
            <span className="section-icon custom-section-icon" aria-hidden="true">
              <img src="/icons/settings/monitor.png" alt="" />
            </span>
            <span><b>Monitored area</b><small>Matching and page highlights</small></span>
            <span className="section-chevron" aria-hidden="true">{monitorAreaOpen ? "▾" : "▸"}</span>
          </button>
          {monitorAreaOpen && (
          <div className="monitor-section-body" id="monitored-area-panel">
          <div className="setting-row">
            <div>
              <label htmlFor="case-sensitive">Case-sensitive match</label>
              <p>Matching is a substring search and ignores case by default.</p>
            </div>
            <input
              id="case-sensitive"
              className="switch"
              type="checkbox"
              checked={caseSensitive}
              onChange={(event) => setCaseSensitive(event.target.checked)}
            />
          </div>

          <div className="setting-row">
            <div>
              <label htmlFor="highlight-matches">
                Highlight matches on the page
              </label>
              <p>Highlights refresh after each successful scan.</p>
            </div>
            <input
              id="highlight-matches"
              className="switch"
              type="checkbox"
              checked={highlightMatches}
              onChange={(event) => setHighlightMatches(event.target.checked)}
            />
          </div>
          </div>
          )}
          </div>

          <div className="monitor-section">
          <button
            type="button"
            className="monitor-section-header"
            aria-expanded={triggerActionsOpen}
            aria-controls="trigger-actions-panel"
            onClick={() => setTriggerActionsOpen((open) => !open)}
          >
            <span className="section-icon custom-section-icon" aria-hidden="true">
              <img src="/icons/settings/action.png" alt="" />
            </span>
            <span><b>Trigger actions</b><small>Focus or open a detected result</small></span>
            <span className="section-chevron" aria-hidden="true">{triggerActionsOpen ? "▾" : "▸"}</span>
          </button>
          {triggerActionsOpen && (
          <div className="monitor-section-body" id="trigger-actions-panel">
          <label
            className="field-label keyword-field-label"
            htmlFor="bring-to-front"
          >
            Bring tab to front when triggered
          </label>
          <select
            id="bring-to-front"
            className="full-select"
            value={bringToFront}
            onChange={(event) =>
              setBringToFront(event.target.value as BringToFrontMode)
            }
          >
            <option value="never">Never</option>
            <option value="found">Found triggers only</option>
            <option value="missing">Missing triggers only</option>
            <option value="all">All triggers</option>
          </select>
          <p className="field-help">
            Automatically activates the monitored tab when a found or missing
            trigger changes state.
          </p>

          <label
            className="field-label keyword-field-label"
            htmlFor="auto-open-result"
          >
            Auto-open detected result
          </label>
          <select
            id="auto-open-result"
            className="full-select"
            value={autoOpenResult}
            onChange={(event) =>
              setAutoOpenResult(event.target.value as AutoOpenResultMode)
            }
          >
            <option value="off">Off</option>
            <option value="scroll-highlight">Scroll and highlight only</option>
            <option value="click">Click detected result</option>
            <option value="click-and-focus">
              Click detected result and bring tab to front
            </option>
          </select>
          <p className="field-help">
            Scrolls to, highlights, or clicks the result associated with a
            newly detected keyword.
          </p>
          {(autoOpenResult === "click" ||
            autoOpenResult === "click-and-focus") && (
            <p className="inline-warning" role="note">
              Automatic clicking works best when a monitor produces one clear
              matching result. Lucky Fetch will skip ambiguous or unsafe targets.
            </p>
          )}
          </div>
          )}
          </div>

          <div className="monitor-section">
          <button
            type="button"
            className="monitor-section-header"
            aria-expanded={advancedSettingsOpen}
            aria-controls="advanced-settings-panel"
            onClick={() => setAdvancedSettingsOpen((open) => !open)}
          >
            <span className="section-icon custom-section-icon" aria-hidden="true">
              <img src="/icons/settings/advanced.png" alt="" />
            </span>
            <span><b>Advanced settings</b><small>Scan timing and detection behavior</small></span>
            <span className="section-chevron" aria-hidden="true">{advancedSettingsOpen ? "▾" : "▸"}</span>
          </button>
          {advancedSettingsOpen && (
          <div className="monitor-section-body" id="advanced-settings-panel">
          <label className="field-label" htmlFor="scan-delay">
            Scan delay after load (seconds)
          </label>
          <input
            id="scan-delay"
            className="count-input"
            type="number"
            min="0"
            max="60"
            step="0.1"
            value={scanDelaySeconds}
            onChange={(event) => setScanDelaySeconds(event.target.value)}
          />
          <p className="field-help">
            Some pages load their visible content after the browser reports
            that navigation is complete.
          </p>

          <label
            className="field-label keyword-field-label"
            htmlFor="detection-action"
          >
            After detection
          </label>
          <select
            id="detection-action"
            className="full-select"
            value={actionOnDetection}
            onChange={(event) =>
              setActionOnDetection(event.target.value as DetectionAction)
            }
          >
            <option value="continue">Continue reloading</option>
            <option value="pause">Pause the full monitor</option>
            <option value="stop">Stop the full monitor</option>
          </select>
          </div>
          )}
          </div>

          {keywordValidation && (
            <p className="field-error">{keywordValidation}</p>
          )}
        </fieldset>

        <div className="keyword-config-actions">
          <button
            type="button"
            className="text-button"
            disabled={busy || keywordValidation !== null}
            onClick={() => void testKeywords()}
          >
            Test keywords on current page
          </button>
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={() => void clearPageHighlights()}
          >
            Clear highlights
          </button>
        </div>
        {keywordTestResult && (
          <p className="field-help" role="status">
            Test: {keywordTestResult.status === "match"
              ? "Match"
              : keywordTestResult.status === "partial"
                ? "Partial"
                : "No match"}
            {" · "}{keywordTestResult.keywordsTested} tested
            {" · "}{keywordTestResult.matchedKeywords.length} matched
            {" · "}{keywordTestResult.matchingFrameCount} matching frame
            {keywordTestResult.matchingFrameCount === 1 ? "" : "s"}
            {highlightMatches
              ? ` · ${keywordTestResult.highlightedOccurrenceCount}${
                  keywordTestResult.highlightTruncated ? "+" : ""
                } highlighted`
              : ""}
            {keywordTestResult.highlightErrors.length > 0
              ? ` · ${keywordTestResult.highlightErrors.length} nonfatal highlight issue(s)`
              : ""}
          </p>
        )}

        <div className="keyword-notes">
          <p>A confirmed Present result alerts once, including the first scan.</p>
          <p>Alerts occur only when the condition changes, not on every reload.</p>
        </div>

        {monitor && (
          <div className="monitor-section activity-section">
            <button
              type="button"
              className="monitor-section-header"
              aria-expanded={monitorActivityOpen}
              aria-controls="monitor-activity-panel"
              onClick={() => setMonitorActivityOpen((open) => !open)}
            >
              <span className="section-icon" aria-hidden="true">≡</span>
              <span><b>Monitor activity</b><small>Status, diagnostics, and recent detections</small></span>
              <span className="section-chevron" aria-hidden="true">{monitorActivityOpen ? "▾" : "▸"}</span>
            </button>
            {monitorActivityOpen && (
            <div className="monitor-section-body" id="monitor-activity-panel">
            <dl className="keyword-status-grid">
              <div>
                <dt>Last scan</dt>
                <dd>{formatTimestamp(monitor.keywordRuntime.lastScanAt)}</dd>
              </div>
              <div>
                <dt>Current state</dt>
                <dd>
                  {matchStateLabel(monitor.keywordRuntime.lastMatchState)}
                </dd>
              </div>
              <div>
                <dt>Scan status</dt>
                <dd>
                  {describeScanStatus(monitor.keywordRuntime)}
                </dd>
              </div>
              <div>
                <dt>Last confirmed detection</dt>
                <dd>
                  {formatTimestamp(monitor.keywordRuntime.lastConfirmedAt)}
                </dd>
              </div>
              <div>
                <dt>Confirmed matched keywords</dt>
                <dd>{monitor.keywordRuntime.lastMatchedKeywords.length}</dd>
              </div>
              <div>
                <dt>Confirmed matching frames</dt>
                <dd>{monitor.keywordRuntime.matchingFrameCount}</dd>
              </div>
              {monitor.keywordMonitoring.highlightMatches && (
                <div>
                  <dt>Highlighted occurrences</dt>
                  <dd>
                    {monitor.keywordRuntime.highlightedOccurrenceCount}
                    {monitor.keywordRuntime.highlightTruncated ? "+" : ""}
                  </dd>
                </div>
              )}
            </dl>
            {monitor.keywordRuntime.lastHighlightError &&
              monitor.keywordRuntime.lastHighlightError.code !==
                "HIGHLIGHT_LIMIT_REACHED" && (
                <p className="keyword-error" role="status">
                  Matched, but highlighting could not be applied.{" "}
                  {monitor.keywordRuntime.lastHighlightError.message}
                </p>
              )}
            {monitor.keywordRuntime.lastError && (
              <>
                <p
                  className={
                    monitor.keywordRuntime.lastError.code ===
                    "FRAME_SCAN_PARTIAL"
                      ? "inline-warning"
                      : "keyword-error"
                  }
                  role="status"
                >
                  {monitor.keywordRuntime.lastError.message}
                </p>
                {tab &&
                  monitor.status === "running" &&
                  monitor.keywordMonitoring.enabled &&
                  (monitor.keywordRuntime.lastError.code ===
                    "NO_CONTENT_ACCESS" ||
                    monitor.keywordRuntime.lastError.code ===
                      "CONTENT_SCRIPT_UNAVAILABLE") && (
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={busy}
                      onClick={() =>
                        monitor.keywordRuntime.lastError?.code ===
                        "NO_CONTENT_ACCESS"
                          ? void grantAccessAndRetryScan()
                          : void runAction({
                              type: "monitor:retry-scan",
                              tabId: tab.id
                            })
                      }
                    >
                      {monitor.keywordRuntime.lastError.code ===
                      "NO_CONTENT_ACCESS"
                        ? "Allow access to this site"
                        : "Retry scanner"}
                    </button>
                  )}
              </>
            )}
            {!keywordConfigLocked && (
              <div className="keyword-config-actions">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={
                    busy ||
                    keywordValidation !== null ||
                    !keywordConfigurationDirty
                  }
                  onClick={() => void saveKeywordConfiguration()}
                >
                  Save keyword settings
                </button>
                <button
                  type="button"
                  className="text-button"
                  disabled={busy}
                  onClick={() => void resetBaseline()}
                >
                  Reset baseline
                </button>
              </div>
            )}

            <div className="history-heading">
              <h3>Recent detections</h3>
              <button
                type="button"
                className="text-button"
                disabled={busy || monitor.detectionHistory.length === 0}
                onClick={() => void clearHistory()}
              >
                Clear history
              </button>
            </div>
            {monitor.detectionHistory.length === 0 ? (
              <p className="empty-history">No detections recorded for this tab.</p>
            ) : (
              <ol className="history-list">
                {monitor.detectionHistory
                  .slice(0, POPUP_HISTORY_LIMIT)
                  .map((entry) => (
                    <li key={entry.id}>
                      <div>
                        <b>{entry.mode === "found" ? "Found" : "Lost"}</b>
                        <span>
                          {entry.matchedKeywords?.map((keyword) => keyword.value)
                            .join(", ") || entry.keyword}
                        </span>
                      </div>
                      <small>
                        {formatTimestamp(entry.detectedAt)} ·{" "}
                        {entry.actionApplied}
                      </small>
                    </li>
                  ))}
              </ol>
            )}
            </div>
            )}
          </div>
        )}
        </div>
        )}
      </section>

      {error && (
        <div className="error-banner" role="alert">
          <span aria-hidden="true">!</span>
          <p>{error}</p>
          <button type="button" aria-label="Dismiss error" onClick={() => setError(null)}>
            ×
          </button>
        </div>
      )}

      <div className="utility-actions">
        {monitor && (
          <button
            type="button"
            className="text-button danger-text"
            disabled={busy}
            onClick={() => void resetCurrent()}
          >
            Reset monitor for this tab
          </button>
        )}
        <button
          type="button"
          className="text-button"
          disabled={busy}
          onClick={() => void showDiagnostics()}
        >
          {diagnosticText ? "Refresh diagnostics" : "Show diagnostics"}
        </button>
      </div>

      {diagnosticText && (
        <section className="diagnostics-panel">
          <label htmlFor="ready-diagnostics">Diagnostic details</label>
          <textarea
            id="ready-diagnostics"
            readOnly
            value={diagnosticText}
          />
          <div className="diagnostic-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={() => void copyDiagnostics()}
            >
              Copy details
            </button>
            <button
              type="button"
              className="text-button danger-text"
              disabled={busy}
              onClick={() => void resetAll()}
            >
              Reset all monitors
            </button>
          </div>
        </section>
      )}

      {diagnosticMessage && (
        <p className="diagnostic-message" aria-live="polite">
          {diagnosticMessage}
        </p>
      )}

    </AppShell>
  );
}
