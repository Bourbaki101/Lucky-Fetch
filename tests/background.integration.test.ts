/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from "vitest";
import type {
  ExtensionRequest,
  ExtensionResponse
} from "../src/messaging/contracts";
import {
  alarmName,
  scanAlarmName,
  scanIdentityFromAlarm
} from "../src/scheduling/alarms";
import { STORAGE_KEY } from "../src/shared/constants";
import { createRunningMonitor } from "../src/shared/stateMachine";
import type {
  DetectionAction,
  KeywordMonitoringRuntime,
  PersistedState,
  TabMonitor
} from "../src/types/monitor";

function createEvent<T extends (...args: any[]) => void>() {
  let listener: T | null = null;
  return {
    addListener: vi.fn((next: T) => {
      listener = next;
    }),
    emit: (...args: Parameters<T>) => {
      listener?.(...args);
    },
    get listener(): T {
      if (!listener) throw new Error("Listener was not registered.");
      return listener;
    }
  };
}

interface MockEnvironment {
  alarms: Map<string, chrome.alarms.Alarm>;
  tabs: Map<number, chrome.tabs.Tab>;
  state: PersistedState;
  runtimeMessage: ReturnType<
    typeof createEvent<
      (
        request: ExtensionRequest,
        sender: chrome.runtime.MessageSender,
        sendResponse: (response: ExtensionResponse) => void
      ) => boolean
    >
  >;
  alarmEvent: ReturnType<
    typeof createEvent<(alarm: chrome.alarms.Alarm) => void>
  >;
  activatedEvent: ReturnType<
    typeof createEvent<(activeInfo: chrome.tabs.TabActiveInfo) => void>
  >;
  updatedEvent: ReturnType<
    typeof createEvent<
      (
        tabId: number,
        changeInfo: chrome.tabs.TabChangeInfo,
        tab: chrome.tabs.Tab
      ) => void
    >
  >;
  removedEvent: ReturnType<
    typeof createEvent<
      (tabId: number, removeInfo: chrome.tabs.TabRemoveInfo) => void
    >
  >;
  notificationClicked: ReturnType<
    typeof createEvent<(notificationId: string) => void>
  >;
  notificationClosed: ReturnType<
    typeof createEvent<
      (notificationId: string, byUser: boolean) => void
    >
  >;
  reload: ReturnType<typeof vi.fn>;
  sendTabMessage: ReturnType<typeof vi.fn>;
  executeScript: ReturnType<typeof vi.fn>;
  getAllFrames: ReturnType<typeof vi.fn>;
  frameScan: ReturnType<typeof vi.fn>;
  frames: chrome.webNavigation.GetAllFrameResultDetails[];
  containsPermission: ReturnType<typeof vi.fn>;
  createNotification: ReturnType<typeof vi.fn>;
  updateTab: ReturnType<typeof vi.fn>;
  updateWindow: ReturnType<typeof vi.fn>;
  setBadgeText: ReturnType<typeof vi.fn>;
}

type MockPageRequest =
  | { type: "content:ping" }
  | { type: "content:scan-page"; generation: number };

function successfulPageResponse(
  request: MockPageRequest,
  matched = false,
  pageTitle = "Monitored"
) {
  if (request.type === "content:ping") {
    return {
      ok: true,
      ready: true,
      pageUrl: "https://example.com/"
    };
  }
  return {
    ok: true,
    generation: request.generation,
    result: {
      matched,
      scannedAt: Date.now(),
      pageTitle,
      pageUrl: "https://example.com/",
      textLength: 10
    }
  };
}

function scanMessageCalls(environment: MockEnvironment) {
  return environment.sendTabMessage.mock.calls.filter(
    ([, request]) => request?.type === "content:scan-page"
  );
}

function makeMonitor(
  overrides: Partial<TabMonitor> = {}
): TabMonitor {
  return {
    ...createRunningMonitor(
      { id: 1, title: "Monitored", url: "https://example.com/" },
      {
        intervalMs: 30_000,
        bypassCache: false,
        maximumReloads: null,
        interactionBehavior: "ignore",
        protectActiveTyping: true
      },
      Date.now(),
      "instance-1"
    ),
    ...overrides
  };
}

function makeKeywordMonitor(
  actionOnDetection: DetectionAction = "continue",
  runtime: Partial<KeywordMonitoringRuntime> = {},
  overrides: Partial<TabMonitor> = {}
): TabMonitor {
  const base = makeMonitor();
  return {
    ...base,
    keywordMonitoring: {
      enabled: true,
      keywords: [{ id: "keyword-1", value: "New Ticket" }],
      mode: "found",
      caseSensitive: false,
      scanDelayMs: 2_000,
      actionOnDetection,
      highlightMatches: false,
      notificationMessage: "",
      bringToFront: "never",
      autoOpenResult: "off"
    },
    keywordRuntime: {
      ...base.keywordRuntime,
      ...runtime
    },
    ...overrides
  };
}

function scanAlarmNames(environment: MockEnvironment): string[] {
  return [...environment.alarms.keys()].filter(
    (name) => scanIdentityFromAlarm(name) !== null
  );
}

function childFrame(
  frameId: number,
  url = "https://example.com/widget"
): chrome.webNavigation.GetAllFrameResultDetails {
  return {
    frameId,
    parentFrameId: 0,
    url,
    documentId: `document-${frameId}`,
    documentLifecycle: "active",
    processId: 1,
    errorOccurred: false,
    frameType: "sub_frame",
    parentDocumentId: "document-0"
  };
}

function installChromeMock(monitor: TabMonitor | null): MockEnvironment {
  const alarms = new Map<string, chrome.alarms.Alarm>();
  const tabs = new Map<number, chrome.tabs.Tab>([
    [
      1,
      {
        id: 1,
        active: true,
        title: "Monitored",
        url: "https://example.com/",
        windowId: 1,
        index: 0,
        pinned: false,
        highlighted: true,
        incognito: false,
        selected: true,
        discarded: false,
        autoDiscardable: true,
        groupId: -1,
        frozen: false
      }
    ],
    [
      2,
      {
        id: 2,
        active: false,
        title: "Unmonitored",
        url: "https://example.org/",
        windowId: 1,
        index: 1,
        pinned: false,
        highlighted: false,
        incognito: false,
        selected: false,
        discarded: false,
        autoDiscardable: true,
        groupId: -1,
        frozen: false
      }
    ]
  ]);
  const state: PersistedState = {
    version: 3,
    monitors: monitor ? { "1": monitor } : {}
  };
  const session: Record<string, unknown> = monitor
    ? { "luckyfetch:tab-instance:1": monitor.tabInstanceId }
    : {};

  const runtimeMessage = createEvent<
    (
      request: ExtensionRequest,
      sender: chrome.runtime.MessageSender,
      sendResponse: (response: ExtensionResponse) => void
    ) => boolean
  >();
  const runtimeStartup = createEvent<() => void>();
  const runtimeInstalled = createEvent<() => void>();
  const alarmEvent = createEvent<(alarm: chrome.alarms.Alarm) => void>();
  const activatedEvent =
    createEvent<(activeInfo: chrome.tabs.TabActiveInfo) => void>();
  const updatedEvent =
    createEvent<
      (
        tabId: number,
        changeInfo: chrome.tabs.TabChangeInfo,
        tab: chrome.tabs.Tab
      ) => void
    >();
  const removedEvent =
    createEvent<(tabId: number, removeInfo: chrome.tabs.TabRemoveInfo) => void>();
  const replacedEvent =
    createEvent<(addedTabId: number, removedTabId: number) => void>();
  const focusEvent = createEvent<(windowId: number) => void>();
  const notificationClicked =
    createEvent<(notificationId: string) => void>();
  const notificationClosed =
    createEvent<(notificationId: string, byUser: boolean) => void>();
  const reload = vi.fn(async () => undefined);
  const sendTabMessage = vi.fn(
    async (_tabId: number, request: MockPageRequest) =>
      successfulPageResponse(request)
  );
  const updateTab = vi.fn(
    async (tabId: number, _properties: chrome.tabs.UpdateProperties) =>
      tabs.get(tabId)
  );
  const updateWindow = vi.fn(async () => ({}));
  const createNotification = vi.fn(
    (
      notificationId: string,
      _options: chrome.notifications.NotificationCreateOptions,
      callback?: (notificationId: string) => void
    ) => {
      callback?.(notificationId);
    }
  );
  const setBadgeText = vi.fn(async () => undefined);
  const frames: chrome.webNavigation.GetAllFrameResultDetails[] = [
    {
      frameId: 0,
      parentFrameId: -1,
      url: "https://example.com/",
      documentId: "document-0",
      documentLifecycle: "active",
      processId: 1,
      errorOccurred: false,
      frameType: "outermost_frame"
    }
  ];
  const frameScan = vi.fn(
    (_frameId: number, _generation: number) => false
  );
  const getAllFrames = vi.fn(async () => structuredClone(frames));
  const executeScript = vi.fn(
    async (details: any) => {
      const frameId = details.target.frameIds?.[0];
      if (
        frameId === undefined ||
        !details.args ||
        details.args.length < 4
      ) {
        return [];
      }
      const frame = frames.find((candidate) => candidate.frameId === frameId);
      if (!frame) throw new Error(`No frame with id: ${frameId}`);
      const scanRequestId = String(details.args[2]);
      const generation = Number(details.args[3]);
      const keywords = details.args[0] as Array<{ id: string; value: string }>;
      const matched = Boolean(frameScan(frameId, generation));
      return [
        {
          frameId,
          documentId: frame.documentId,
          result: {
            ok: true,
            scanRequestId,
            generation,
            matched,
            matches: keywords.map((keyword) => ({
              keywordId: keyword.id,
              keyword: keyword.value,
              matched,
              occurrenceCount: matched ? 1 : 0
            })),
            scannedAt: Date.now(),
            pageUrl: frame.url,
            pageTitle: "Monitored",
            textLength: 10
          }
        }
      ];
    }
  );
  const containsPermission = vi.fn(async () => true);

  const chromeMock = {
    runtime: {
      lastError: undefined,
      getURL: vi.fn(
        (path: string) => `chrome-extension://luckyfetch-test/${path}`
      ),
      onMessage: runtimeMessage,
      onStartup: runtimeStartup,
      onInstalled: runtimeInstalled
    },
    storage: {
      local: {
        get: vi.fn(async () => ({ [STORAGE_KEY]: state })),
        set: vi.fn(async (value: Record<string, PersistedState>) => {
          const next = value[STORAGE_KEY];
          if (next) {
            state.version = next.version;
            state.monitors = structuredClone(next.monitors);
          }
        })
      },
      session: {
        get: vi.fn(async () => ({ ...session })),
        set: vi.fn(async (value: Record<string, unknown>) => {
          Object.assign(session, value);
        }),
        remove: vi.fn(async (key: string) => {
          delete session[key];
        })
      }
    },
    tabs: {
      query: vi.fn(async (query: chrome.tabs.QueryInfo) =>
        [...tabs.values()].filter((tab) =>
          query.active ? tab.active : true
        )
      ),
      get: vi.fn(async (tabId: number) => {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error(`No tab with id: ${tabId}`);
        return tab;
      }),
      reload,
      sendMessage: sendTabMessage,
      update: updateTab,
      onActivated: activatedEvent,
      onUpdated: updatedEvent,
      onRemoved: removedEvent,
      onReplaced: replacedEvent
    },
    windows: {
      update: updateWindow,
      onFocusChanged: focusEvent
    },
    alarms: {
      create: vi.fn(
        async (name: string, info: chrome.alarms.AlarmCreateInfo) => {
          alarms.set(name, {
            name,
            scheduledTime:
              info.when ??
              Date.now() + (info.delayInMinutes ?? 0) * 60_000,
            periodInMinutes: info.periodInMinutes
          });
        }
      ),
      get: vi.fn(async (name: string) => alarms.get(name)),
      getAll: vi.fn(async () => [...alarms.values()]),
      clear: vi.fn(async (name: string) => alarms.delete(name)),
      onAlarm: alarmEvent
    },
    action: {
      setBadgeText,
      setBadgeBackgroundColor: vi.fn(async () => undefined),
      setTitle: vi.fn(async () => undefined)
    },
    permissions: {
      contains: containsPermission
    },
    scripting: {
      executeScript
    },
    webNavigation: {
      getAllFrames
    },
    notifications: {
      create: createNotification,
      clear: vi.fn(async () => true),
      onClicked: notificationClicked,
      onClosed: notificationClosed
    }
  };

  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: chromeMock
  });
  return {
    alarms,
    tabs,
    state,
    runtimeMessage,
    alarmEvent,
    activatedEvent,
    updatedEvent,
    removedEvent,
    notificationClicked,
    notificationClosed,
    reload,
    sendTabMessage,
    executeScript,
    getAllFrames,
    frameScan,
    frames,
    containsPermission,
    createNotification,
    updateTab,
    updateWindow,
    setBadgeText
  };
}

async function importBackground(): Promise<void> {
  await import("../src/background/index");
  await vi.waitFor(() => {
    expect(chrome.runtime.onMessage.addListener).toHaveBeenCalledOnce();
  });
}

async function sendMessage(
  environment: MockEnvironment,
  request: ExtensionRequest
): Promise<ExtensionResponse> {
  return new Promise((resolve) => {
    const keepOpen = environment.runtimeMessage.listener(
      request,
      {},
      resolve
    );
    expect(keepOpen).toBe(true);
  });
}

describe("background runtime recovery", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    const { stopBadgeCountdown } = await import("../src/background/index");
    await stopBadgeCountdown(false);
    vi.restoreAllMocks();
  });

  it("restores one global countdown for the nearest running monitor", async () => {
    const environment = installChromeMock(makeMonitor());
    environment.state.monitors["2"] = makeMonitor({
      tabId: 2,
      tabInstanceId: "instance-2",
      pageTitle: "Second monitor",
      pageUrl: "https://example.org/",
      nextReloadAt: Date.now() + 7_000
    });
    const intervalSpy = vi.spyOn(globalThis, "setInterval");
    await importBackground();

    await vi.waitFor(() => {
      expect(environment.alarms.has(alarmName(1))).toBe(true);
      expect(environment.alarms.has(alarmName(2))).toBe(true);
    });

    await vi.waitFor(() => {
      expect(environment.setBadgeText).toHaveBeenCalledWith({
        text: expect.stringMatching(/^[1-7]$/)
      });
    });
    expect(
      environment.setBadgeText.mock.calls
        .filter(([details]) => details.tabId === undefined)
        .some(([details]) => details.text !== "")
    ).toBe(true);

    const { startBadgeCountdown } = await import("../src/background/index");
    const countdownTimers = () =>
      intervalSpy.mock.calls.filter(([, delay]) => delay === 1_000);
    expect(countdownTimers()).toHaveLength(1);
    startBadgeCountdown();
    startBadgeCountdown();
    expect(countdownTimers()).toHaveLength(1);
  });

  it("turns an overdue restored deadline into a near-immediate verified alarm", async () => {
    const before = Date.now();
    const environment = installChromeMock(
      makeMonitor({ nextReloadAt: before - 5_000 })
    );
    await importBackground();

    await vi.waitFor(() => {
      const restored = environment.state.monitors["1"];
      expect(restored?.nextReloadAt).toBeGreaterThan(before);
      expect(restored?.nextReloadAt).toBeLessThanOrEqual(before + 5_000);
      expect(environment.alarms.get(alarmName(1))?.scheduledTime).toBe(
        restored?.nextReloadAt
      );
    });
  });

  it("executes an alarm from latest storage and reschedules after reload", async () => {
    const environment = installChromeMock(makeMonitor());
    await importBackground();
    await vi.waitFor(() => expect(environment.alarms.has(alarmName(1))).toBe(true));

    environment.state.monitors["1"] = {
      ...environment.state.monitors["1"]!,
      nextReloadAt: Date.now() - 1
    };
    environment.alarmEvent.emit({
      name: alarmName(1),
      scheduledTime: Date.now() - 1
    });

    await vi.waitFor(() => expect(environment.reload).toHaveBeenCalledWith(1, {
      bypassCache: false
    }));
    await vi.waitFor(() => {
      expect(environment.state.monitors["1"]?.reloadCount).toBe(1);
      expect(environment.state.monitors["1"]?.status).toBe("running");
      expect(environment.alarms.has(alarmName(1))).toBe(true);
    });
  });

  it("completes at the maximum count and cancels the alarm", async () => {
    const environment = installChromeMock(
      makeMonitor({ maximumReloads: 1 })
    );
    await importBackground();
    await vi.waitFor(() => expect(environment.alarms.has(alarmName(1))).toBe(true));
    environment.state.monitors["1"] = {
      ...environment.state.monitors["1"]!,
      nextReloadAt: Date.now() - 1
    };

    environment.alarmEvent.emit({
      name: alarmName(1),
      scheduledTime: Date.now() - 1
    });

    await vi.waitFor(() => {
      expect(environment.state.monitors["1"]?.status).toBe("completed");
      expect(environment.state.monitors["1"]?.reloadCount).toBe(1);
      expect(environment.alarms.has(alarmName(1))).toBe(false);
    });
  });

  it("pause, resume, stop, and reset affect only the tab alarm", async () => {
    const environment = installChromeMock(makeMonitor());
    await importBackground();
    await vi.waitFor(() => expect(environment.alarms.has(alarmName(1))).toBe(true));

    await sendMessage(environment, { type: "monitor:pause", tabId: 1 });
    expect(environment.alarms.has(alarmName(1))).toBe(false);

    await sendMessage(environment, { type: "monitor:resume", tabId: 1 });
    expect(environment.alarms.has(alarmName(1))).toBe(true);

    await sendMessage(environment, { type: "monitor:stop", tabId: 1 });
    expect(environment.alarms.has(alarmName(1))).toBe(false);

    await sendMessage(environment, { type: "monitor:reset", tabId: 1 });
    expect(environment.state.monitors["1"]).toBeUndefined();
    expect(environment.alarms.has(alarmName(1))).toBe(false);
    expect(environment.setBadgeText).toHaveBeenCalledWith({ text: "" });
  });

  it("turns reload rejection into a persisted error without another alarm", async () => {
    const environment = installChromeMock(makeMonitor());
    environment.reload.mockRejectedValueOnce(new Error("Reload rejected"));
    await importBackground();
    await vi.waitFor(() => expect(environment.alarms.has(alarmName(1))).toBe(true));
    environment.state.monitors["1"] = {
      ...environment.state.monitors["1"]!,
      nextReloadAt: Date.now() - 1
    };

    environment.alarmEvent.emit({
      name: alarmName(1),
      scheduledTime: Date.now() - 1
    });

    await vi.waitFor(() => {
      expect(environment.state.monitors["1"]?.status).toBe("error");
      expect(environment.alarms.has(alarmName(1))).toBe(false);
    });
  });

  it("schedules one delayed scan after completion and ignores duplicate completion events", async () => {
    const environment = installChromeMock(makeKeywordMonitor());
    await importBackground();
    const tab = environment.tabs.get(1)!;

    environment.updatedEvent.emit(1, { status: "complete" }, tab);
    environment.updatedEvent.emit(1, { status: "complete" }, tab);

    await vi.waitFor(() => {
      expect(scanAlarmNames(environment)).toEqual([scanAlarmName(1, 0)]);
      expect(
        environment.state.monitors["1"]?.keywordRuntime.lastScanStatus
      ).toBe("waiting-for-delay");
    });
  });

  it("does not scan when keyword monitoring is disabled or invalid", async () => {
    const disabledEnvironment = installChromeMock(makeMonitor());
    await importBackground();
    disabledEnvironment.updatedEvent.emit(
      1,
      { status: "complete" },
      disabledEnvironment.tabs.get(1)!
    );
    await sendMessage(disabledEnvironment, {
      type: "monitor:get-current",
      tabId: 1
    });
    expect(scanAlarmNames(disabledEnvironment)).toHaveLength(0);
    expect(scanMessageCalls(disabledEnvironment)).toHaveLength(0);
    expect(disabledEnvironment.createNotification).not.toHaveBeenCalled();
  });

  it("discards an old navigation generation without scanning the new page", async () => {
    const environment = installChromeMock(makeKeywordMonitor());
    await importBackground();
    const tab = environment.tabs.get(1)!;
    environment.updatedEvent.emit(1, { status: "complete" }, tab);
    await vi.waitFor(() =>
      expect(environment.alarms.has(scanAlarmName(1, 0))).toBe(true)
    );

    environment.updatedEvent.emit(1, { status: "loading" }, tab);
    await vi.waitFor(() =>
      expect(environment.alarms.has(scanAlarmName(1, 0))).toBe(false)
    );
    environment.alarmEvent.emit({
      name: scanAlarmName(1, 0),
      scheduledTime: Date.now()
    });
    await sendMessage(environment, {
      type: "monitor:get-current",
      tabId: 1
    });
    expect(scanMessageCalls(environment)).toHaveLength(0);
  });

  it("keeps an initial Missing scan silent, ignores unchanged state, and rearms after reset", async () => {
    const environment = installChromeMock(makeKeywordMonitor());
    environment.frameScan.mockImplementation(
      (_frameId: number, generation: number) =>
        generation !== 0 && generation !== 3
    );
    environment.tabs.get(1)!.title = "Autotask";
    await importBackground();
    const tab = environment.tabs.get(1)!;

    const completeAndScan = async (generation: number): Promise<void> => {
      if (generation > 0) {
        environment.updatedEvent.emit(1, { status: "loading" }, tab);
      }
      environment.updatedEvent.emit(1, { status: "complete" }, tab);
      const name = scanAlarmName(1, generation);
      await vi.waitFor(() => expect(environment.alarms.has(name)).toBe(true));
      environment.alarms.delete(name);
      environment.alarmEvent.emit({ name, scheduledTime: Date.now() });
      await vi.waitFor(() =>
        expect(
          environment.state.monitors["1"]?.keywordRuntime.lastScannedGeneration
        ).toBe(generation)
      );
    };

    await completeAndScan(0);
    expect(environment.createNotification).not.toHaveBeenCalled();
    expect(environment.state.monitors["1"]?.detectionHistory).toHaveLength(0);

    await completeAndScan(1);
    expect(environment.createNotification).toHaveBeenCalledTimes(1);
    expect(
      environment.createNotification.mock.calls[0]?.[1]?.message
    ).toBe("“New Ticket” appeared on Autotask");
    expect(environment.state.monitors["1"]?.detectionHistory).toHaveLength(1);

    await completeAndScan(2);
    expect(environment.createNotification).toHaveBeenCalledTimes(1);
    expect(environment.state.monitors["1"]?.detectionHistory).toHaveLength(1);

    await completeAndScan(3);
    expect(environment.createNotification).toHaveBeenCalledTimes(1);

    await completeAndScan(4);
    expect(environment.createNotification).toHaveBeenCalledTimes(2);
    expect(environment.state.monitors["1"]?.detectionHistory).toHaveLength(2);
  });

  it("focuses the monitored tab and its window only for a configured state transition", async () => {
    const monitor = makeKeywordMonitor("continue", { lastMatchState: false });
    monitor.keywordMonitoring.bringToFront = "found";
    const environment = installChromeMock(monitor);
    environment.frameScan.mockReturnValue(true);
    await importBackground();

    environment.updatedEvent.emit(
      1,
      { status: "complete" },
      environment.tabs.get(1)!
    );
    await vi.waitFor(() =>
      expect(environment.alarms.has(scanAlarmName(1, 0))).toBe(true)
    );
    environment.alarms.delete(scanAlarmName(1, 0));
    environment.alarmEvent.emit({
      name: scanAlarmName(1, 0),
      scheduledTime: Date.now()
    });

    await vi.waitFor(() => {
      expect(environment.updateTab).toHaveBeenCalledOnce();
      expect(
        environment.state.monitors["1"]?.keywordRuntime.lastFocusAt
      ).not.toBeNull();
    });
    expect(environment.updateTab).toHaveBeenCalledWith(1, { active: true });
    expect(environment.updateWindow).toHaveBeenCalledWith(1, { focused: true });
  });

  it("resolves, scrolls, highlights, and clicks one safe found result without forcing focus", async () => {
    const monitor = makeKeywordMonitor("continue", { lastMatchState: false });
    monitor.keywordMonitoring.autoOpenResult = "click";
    const environment = installChromeMock(monitor);
    environment.frames.push(childFrame(7));
    environment.frameScan.mockImplementation((frameId: number) => frameId === 7);
    const defaultExecuteScript =
      environment.executeScript.getMockImplementation();
    if (!defaultExecuteScript) {
      throw new Error("Expected the default executeScript implementation.");
    }
    environment.executeScript.mockImplementation(async (details: any) => {
      if (details.func?.name === "resolveMatchedElement") {
        const frameId = details.target.frameIds[0];
        return [{
          frameId,
          documentId: `document-${frameId}`,
          result: {
            ok: true,
            pageUrl: details.args[2],
            truncated: false,
            matches: [{
              matchToken: "event-0",
              clickableToken: "event-0",
              keywordId: "keyword-1",
              matchedText: "New Ticket",
              frameUrl: details.args[2],
              resultIdentifierHash: "ticket-1",
              rowTextHash: "row-1",
              linkUrl: "https://example.com/tickets/1",
              clickable: true,
              clickSkipReason: null
            }]
          }
        }];
      }
      if (details.func?.name === "scrollAndHighlightMatch") {
        const frameId = details.target.frameIds[0];
        return [{
          frameId,
          documentId: `document-${frameId}`,
          result: {
            ok: true,
            pageUrl: details.args[0],
            scrolled: true,
            highlighted: true,
            clicked: true
          }
        }];
      }
      if (details.func?.name === "clearResolvedMatchTokens") return [];
      return defaultExecuteScript(details);
    });
    await importBackground();

    environment.updatedEvent.emit(
      1,
      { status: "complete" },
      environment.tabs.get(1)!
    );
    await vi.waitFor(() =>
      expect(environment.alarms.has(scanAlarmName(1, 0))).toBe(true)
    );
    environment.alarms.delete(scanAlarmName(1, 0));
    environment.alarmEvent.emit({
      name: scanAlarmName(1, 0),
      scheduledTime: Date.now()
    });

    await vi.waitFor(() =>
      expect(
        environment.state.monitors["1"]?.keywordRuntime.lastClickAt
      ).not.toBeNull()
    );
    expect(
      environment.state.monitors["1"]?.keywordRuntime.lastActionResultSignature
    ).toMatch(/^result-/u);
    expect(environment.updateTab).not.toHaveBeenCalled();
    expect(environment.createNotification).toHaveBeenCalledOnce();
    expect(
      environment.executeScript.mock.calls.some(
        ([details]) =>
          details.func?.name === "scrollAndHighlightMatch" &&
          details.target.frameIds[0] === 7
      )
    ).toBe(true);
  });

  it("establishes a present baseline from an already-loaded child iframe", async () => {
    const monitor = makeKeywordMonitor();
    monitor.keywordMonitoring.keywords = [
      { id: "keyword-1", value: "No items to display" }
    ];
    const environment = installChromeMock(monitor);
    environment.frames.push(
      childFrame(
        7,
        "https://example.com/Mvc/ServiceDesk/TicketGridWidgetDrilldown.mvc/PrimaryStandardDrilldown"
      )
    );
    environment.frameScan.mockImplementation(
      (frameId: number) => frameId === 7
    );
    await importBackground();

    environment.updatedEvent.emit(
      1,
      { status: "complete" },
      environment.tabs.get(1)!
    );
    await vi.waitFor(() =>
      expect(environment.alarms.has(scanAlarmName(1, 0))).toBe(true)
    );
    environment.alarms.delete(scanAlarmName(1, 0));
    environment.alarmEvent.emit({
      name: scanAlarmName(1, 0),
      scheduledTime: Date.now()
    });

    await vi.waitFor(() => {
      const runtime =
        environment.state.monitors["1"]?.keywordRuntime;
      expect(runtime?.lastScannedGeneration).toBe(0);
      expect(runtime?.lastMatchState).toBe(true);
      expect(runtime?.lastScanStatus).toBe("complete");
      expect(runtime?.lastError).toBeNull();
    });
    const targetedFrameIds = environment.executeScript.mock.calls
      .map(([details]) => details.target?.frameIds?.[0])
      .filter((frameId) => frameId !== undefined);
    expect(targetedFrameIds).toEqual(expect.arrayContaining([0, 7]));
    expect(environment.createNotification).toHaveBeenCalledOnce();
  });

  it("evaluates Lost once after the aggregated child-frame state disappears", async () => {
    const monitor = makeKeywordMonitor();
    monitor.keywordMonitoring.keywords = [
      { id: "keyword-1", value: "No items to display" }
    ];
    monitor.keywordMonitoring.mode = "lost";
    const environment = installChromeMock(monitor);
    environment.frames.push(childFrame(7));
    environment.frameScan.mockImplementation(
      (frameId: number, generation: number) =>
        generation === 0 && frameId === 7
    );
    await importBackground();
    const tab = environment.tabs.get(1)!;

    const completeAndScan = async (generation: number): Promise<void> => {
      if (generation > 0) {
        environment.updatedEvent.emit(1, { status: "loading" }, tab);
      }
      environment.updatedEvent.emit(1, { status: "complete" }, tab);
      const name = scanAlarmName(1, generation);
      await vi.waitFor(() => expect(environment.alarms.has(name)).toBe(true));
      environment.alarms.delete(name);
      environment.alarmEvent.emit({ name, scheduledTime: Date.now() });
      await vi.waitFor(() =>
        expect(
          environment.state.monitors["1"]?.keywordRuntime.lastScannedGeneration
        ).toBe(generation)
      );
    };

    await completeAndScan(0);
    expect(
      environment.state.monitors["1"]?.keywordRuntime.lastMatchState
    ).toBe(true);
    expect(environment.createNotification).not.toHaveBeenCalled();

    await completeAndScan(1);
    expect(
      environment.state.monitors["1"]?.keywordRuntime.lastMatchState
    ).toBe(false);
    expect(environment.createNotification).toHaveBeenCalledOnce();
    expect(environment.state.monitors["1"]?.detectionHistory).toHaveLength(1);
  });

  it("preserves a present baseline when a child frame is destroyed during scanning", async () => {
    const monitor = makeKeywordMonitor("continue", {
      lastMatchState: true
    });
    monitor.keywordMonitoring.mode = "lost";
    const environment = installChromeMock(monitor);
    environment.frames.push(childFrame(7));
    const defaultExecuteScript =
      environment.executeScript.getMockImplementation();
    if (!defaultExecuteScript) {
      throw new Error("Expected the default executeScript implementation.");
    }
    environment.executeScript.mockImplementation(async (details: any) => {
      if (details.target?.frameIds?.[0] === 7) {
        throw new Error("Frame was removed.");
      }
      return defaultExecuteScript(details);
    });
    await importBackground();

    environment.updatedEvent.emit(
      1,
      { status: "complete" },
      environment.tabs.get(1)!
    );
    await vi.waitFor(() =>
      expect(environment.alarms.has(scanAlarmName(1, 0))).toBe(true)
    );
    environment.alarms.delete(scanAlarmName(1, 0));
    environment.alarmEvent.emit({
      name: scanAlarmName(1, 0),
      scheduledTime: Date.now()
    });

    await vi.waitFor(() => {
      const runtime =
        environment.state.monitors["1"]?.keywordRuntime;
      expect(runtime?.lastScannedGeneration).toBe(0);
      expect(runtime?.lastScanStatus).toBe("retrying");
      expect(runtime?.lastError?.code).toBe("FRAME_SCAN_PARTIAL");
      expect(runtime?.lastMatchState).toBe(true);
    });
    expect(environment.createNotification).not.toHaveBeenCalled();
    expect(environment.state.monitors["1"]?.detectionHistory).toHaveLength(0);
  });

  it("confirms Lost when permitted frames are clear and restricted frames are skipped", async () => {
    const monitor = makeKeywordMonitor("continue", {
      lastMatchState: true
    });
    monitor.keywordMonitoring.mode = "lost";
    const environment = installChromeMock(monitor);
    const scannableDescendant = childFrame(
      11,
      "https://example.com/Mvc/ServiceDesk/TicketGrid"
    );
    scannableDescendant.parentFrameId = 10;
    scannableDescendant.parentDocumentId = "document-10";
    environment.frames.push(
      childFrame(9, "https://walkme.psa.datto.com/widget"),
      childFrame(10, "about:blank"),
      scannableDescendant
    );
    environment.containsPermission.mockImplementation(
      async ({ origins }: chrome.permissions.Permissions) => {
        if (
          origins?.includes("http://*/*") ||
          origins?.includes("https://*/*")
        ) {
          return false;
        }
        return origins?.includes("https://example.com/*") ?? false;
      }
    );
    await importBackground();

    environment.updatedEvent.emit(
      1,
      { status: "complete" },
      environment.tabs.get(1)!
    );
    await vi.waitFor(() =>
      expect(environment.alarms.has(scanAlarmName(1, 0))).toBe(true)
    );
    environment.alarms.delete(scanAlarmName(1, 0));
    environment.alarmEvent.emit({
      name: scanAlarmName(1, 0),
      scheduledTime: Date.now()
    });

    await vi.waitFor(() => {
      const runtime =
        environment.state.monitors["1"]?.keywordRuntime;
      expect(runtime?.lastScanStatus).toBe("complete");
      expect(runtime?.lastMatchState).toBe(false);
      expect(runtime?.pendingScan).toBeNull();
      expect(runtime?.scanProgress).toMatchObject({
        pendingFrameCount: 0,
        restrictedFrameCount: 2,
        scannedFrameCount: 2,
        conclusive: true
      });
      expect(environment.createNotification).toHaveBeenCalledOnce();
    });
    expect(environment.frameScan).toHaveBeenCalledWith(0, 0);
    expect(environment.frameScan).toHaveBeenCalledWith(11, 0);
    expect(environment.frameScan).not.toHaveBeenCalledWith(9, 0);
    expect(environment.frameScan).not.toHaveBeenCalledWith(10, 0);
    expect(environment.state.monitors["1"]?.detectionHistory).toHaveLength(1);
    expect(environment.alarms.has(scanAlarmName(1, 0))).toBe(false);
  });

  it("retries an incomplete scan at most three times without confirming Missing", async () => {
    const monitor = makeKeywordMonitor("continue", {
      lastMatchState: true,
      lastConfirmedAt: 500
    });
    monitor.keywordMonitoring.mode = "lost";
    const environment = installChromeMock(monitor);
    environment.frames.push(childFrame(7));
    const defaultExecuteScript =
      environment.executeScript.getMockImplementation();
    if (!defaultExecuteScript) {
      throw new Error("Expected the default executeScript implementation.");
    }
    environment.executeScript.mockImplementation(async (details: any) => {
      if (details.target?.frameIds?.[0] === 7) {
        throw new Error("Frame is still navigating.");
      }
      return defaultExecuteScript(details);
    });
    await importBackground();

    environment.updatedEvent.emit(
      1,
      { status: "complete" },
      environment.tabs.get(1)!
    );
    const name = scanAlarmName(1, 0);
    for (let attempt = 0; attempt <= 3; attempt += 1) {
      await vi.waitFor(() => expect(environment.alarms.has(name)).toBe(true));
      environment.alarms.delete(name);
      environment.alarmEvent.emit({ name, scheduledTime: Date.now() });
      if (attempt < 3) {
        await vi.waitFor(() => {
          const runtime = environment.state.monitors["1"]?.keywordRuntime;
          expect(runtime?.lastScanStatus).toBe("retrying");
          expect(runtime?.pendingScan?.retryNumber).toBe(attempt + 1);
        });
      }
    }

    await vi.waitFor(() => {
      const runtime = environment.state.monitors["1"]?.keywordRuntime;
      expect(runtime?.lastScanStatus).toBe("incomplete");
      expect(runtime?.pendingScan).toBeNull();
      expect(runtime?.scanProgress?.retryNumber).toBe(3);
      expect(runtime?.lastMatchState).toBe(true);
      expect(runtime?.lastConfirmedAt).toBe(500);
      expect(runtime?.lastError?.message).not.toContain("no match found");
    });
    expect(environment.createNotification).not.toHaveBeenCalled();
    expect(environment.state.monitors["1"]?.detectionHistory).toHaveLength(0);
  });

  it("confirms a delayed iframe match once and cancels the retry sequence", async () => {
    const monitor = makeKeywordMonitor("continue", { lastMatchState: false });
    const environment = installChromeMock(monitor);
    environment.frames.push(childFrame(7));
    environment.frameScan.mockImplementation((frameId: number) => frameId === 7);
    const defaultExecuteScript =
      environment.executeScript.getMockImplementation();
    if (!defaultExecuteScript) {
      throw new Error("Expected the default executeScript implementation.");
    }
    let childAttempts = 0;
    environment.executeScript.mockImplementation(async (details: any) => {
      if (details.target?.frameIds?.[0] === 7 && childAttempts++ === 0) {
        throw new Error("Frame is not ready yet.");
      }
      return defaultExecuteScript(details);
    });
    await importBackground();

    environment.updatedEvent.emit(
      1,
      { status: "complete" },
      environment.tabs.get(1)!
    );
    const name = scanAlarmName(1, 0);
    await vi.waitFor(() => expect(environment.alarms.has(name)).toBe(true));
    environment.alarms.delete(name);
    environment.alarmEvent.emit({ name, scheduledTime: Date.now() });
    await vi.waitFor(() =>
      expect(
        environment.state.monitors["1"]?.keywordRuntime.pendingScan?.retryNumber
      ).toBe(1)
    );
    environment.alarms.delete(name);
    environment.alarmEvent.emit({ name, scheduledTime: Date.now() });

    await vi.waitFor(() => {
      const runtime = environment.state.monitors["1"]?.keywordRuntime;
      expect(runtime?.lastMatchState).toBe(true);
      expect(runtime?.lastScanStatus).toBe("complete");
      expect(runtime?.pendingScan).toBeNull();
      expect(environment.createNotification).toHaveBeenCalledOnce();
    });
    environment.alarmEvent.emit({ name, scheduledTime: Date.now() });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(environment.createNotification).toHaveBeenCalledOnce();
    expect(environment.state.monitors["1"]?.detectionHistory).toHaveLength(1);
  });

  it("discards an older scan when navigation starts while a frame result is pending", async () => {
    const monitor = makeKeywordMonitor("continue", { lastMatchState: false });
    const environment = installChromeMock(monitor);
    environment.frameScan.mockReturnValue(true);
    const defaultExecuteScript =
      environment.executeScript.getMockImplementation();
    if (!defaultExecuteScript) {
      throw new Error("Expected the default executeScript implementation.");
    }
    let releaseScan!: () => void;
    const scanGate = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    environment.executeScript.mockImplementation(async (details: any) => {
      if (details.target?.frameIds?.[0] === 0 && details.args?.length === 4) {
        await scanGate;
      }
      return defaultExecuteScript(details);
    });
    await importBackground();

    const tab = environment.tabs.get(1)!;
    environment.updatedEvent.emit(1, { status: "complete" }, tab);
    const name = scanAlarmName(1, 0);
    await vi.waitFor(() => expect(environment.alarms.has(name)).toBe(true));
    environment.alarms.delete(name);
    environment.alarmEvent.emit({ name, scheduledTime: Date.now() });
    await vi.waitFor(() =>
      expect(
        environment.state.monitors["1"]?.keywordRuntime.lastScanStatus
      ).toBe("scanning")
    );
    tab.status = "loading";
    environment.updatedEvent.emit(1, { status: "loading" }, tab);
    releaseScan();

    await vi.waitFor(() =>
      expect(
        environment.state.monitors["1"]?.keywordRuntime.navigationGeneration
      ).toBe(1)
    );
    const runtime = environment.state.monitors["1"]?.keywordRuntime;
    expect(runtime?.lastMatchState).toBe(false);
    expect(runtime?.lastScanStatus).toBe("waiting-for-load");
    expect(environment.createNotification).not.toHaveBeenCalled();
  });

  it("uses the optional monitor message in detection notifications", async () => {
    const monitor = makeKeywordMonitor("continue", {
      lastMatchState: false
    });
    monitor.keywordMonitoring.notificationMessage =
      "There is a new ticket!";
    const environment = installChromeMock(monitor);
    environment.frameScan.mockReturnValue(true);
    await importBackground();
    environment.updatedEvent.emit(
      1,
      { status: "complete" },
      environment.tabs.get(1)!
    );
    await vi.waitFor(() =>
      expect(environment.alarms.has(scanAlarmName(1, 0))).toBe(true)
    );
    environment.alarms.delete(scanAlarmName(1, 0));
    environment.alarmEvent.emit({
      name: scanAlarmName(1, 0),
      scheduledTime: Date.now()
    });

    await vi.waitFor(() =>
      expect(environment.createNotification).toHaveBeenCalledOnce()
    );
    expect(
      environment.createNotification.mock.calls[0]?.[1]?.title
    ).toBe("There is a new ticket!");
    expect(
      environment.createNotification.mock.calls[0]?.[1]?.message
    ).toBe("“New Ticket” appeared on Monitored");
  });

  it("uses the callback notification API, runtime icon URL, and complete flow logs", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const monitor = makeKeywordMonitor("continue", {
      lastMatchState: false
    });
    const environment = installChromeMock(monitor);
    environment.frameScan.mockReturnValue(true);
    await importBackground();
    environment.updatedEvent.emit(
      1,
      { status: "complete" },
      environment.tabs.get(1)!
    );
    await vi.waitFor(() =>
      expect(environment.alarms.has(scanAlarmName(1, 0))).toBe(true)
    );
    environment.alarms.delete(scanAlarmName(1, 0));
    environment.alarmEvent.emit({
      name: scanAlarmName(1, 0),
      scheduledTime: Date.now()
    });

    await vi.waitFor(() =>
      expect(environment.createNotification).toHaveBeenCalledOnce()
    );
    const [, options, callback] =
      environment.createNotification.mock.calls[0] ?? [];
    expect(typeof callback).toBe("function");
    expect(options).toMatchObject({
      type: "basic",
      iconUrl: "chrome-extension://luckyfetch-test/icons/icon-128.png",
      title: "Keyword found",
      message: "“New Ticket” appeared on Monitored"
    });

    const expectedStages = [
      "[LuckyFetch] Detection state changed:",
      "[LuckyFetch] Notification conditions evaluated:",
      "[LuckyFetch] Notification function invoked:",
      "[LuckyFetch] Notification options constructed:",
      "[LuckyFetch] chrome.notifications.create called:",
      "[LuckyFetch] Notification successfully created:"
    ];
    for (const stage of expectedStages) {
      const call = info.mock.calls.find(([label]) => label === stage);
      expect(call?.[1]).toMatchObject({
        tabId: 1,
        tabInstanceId: "instance-1",
        previousState: "missing",
        currentState: "present",
        detectionMode: "found",
        notificationEnabled: true,
        title: "Keyword found",
        message: "“New Ticket” appeared on Monitored"
      });
    }
  });

  it("persists callback runtime errors without losing the recorded transition", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const environment = installChromeMock(
      makeKeywordMonitor("continue", { lastMatchState: false })
    );
    environment.frameScan.mockReturnValue(true);
    environment.createNotification.mockImplementation(
      (_notificationId, _options, callback) => {
        const runtime = chrome.runtime as unknown as {
          lastError?: { message: string };
        };
        runtime.lastError = { message: "Notification delivery rejected" };
        callback?.("");
        runtime.lastError = undefined;
      }
    );
    await importBackground();
    environment.updatedEvent.emit(
      1,
      { status: "complete" },
      environment.tabs.get(1)!
    );
    await vi.waitFor(() =>
      expect(environment.alarms.has(scanAlarmName(1, 0))).toBe(true)
    );
    environment.alarms.delete(scanAlarmName(1, 0));
    environment.alarmEvent.emit({
      name: scanAlarmName(1, 0),
      scheduledTime: Date.now()
    });

    await vi.waitFor(() =>
      expect(
        environment.state.monitors["1"]?.keywordRuntime.lastError?.code
      ).toBe("NOTIFICATION_FAILED")
    );
    expect(environment.createNotification).toHaveBeenCalledOnce();
    expect(environment.state.monitors["1"]?.detectionHistory).toHaveLength(1);
    expect(error).toHaveBeenCalledWith(
      "[LuckyFetch] Notification failed:",
      expect.objectContaining({
        tabId: 1,
        error: "Notification delivery rejected"
      })
    );
  });

  it.each(["pause", "stop"] as const)(
    "%s after detection cancels reload and scan alarms",
    async (action) => {
      const environment = installChromeMock(
        makeKeywordMonitor(action, { lastMatchState: false })
      );
      environment.frameScan.mockReturnValue(true);
      await importBackground();
      const tab = environment.tabs.get(1)!;
      environment.updatedEvent.emit(1, { status: "complete" }, tab);
      await vi.waitFor(() =>
        expect(environment.alarms.has(scanAlarmName(1, 0))).toBe(true)
      );
      environment.alarms.delete(scanAlarmName(1, 0));
      environment.alarmEvent.emit({
        name: scanAlarmName(1, 0),
        scheduledTime: Date.now()
      });

      await vi.waitFor(() => {
        expect(environment.state.monitors["1"]?.status).toBe(action === "pause" ? "paused" : "stopped");
        expect(environment.alarms.has(alarmName(1))).toBe(false);
        expect(scanAlarmNames(environment)).toHaveLength(0);
      });
    }
  );

  it("pausing, stopping, and closing a tab cancel pending scans", async () => {
    const environment = installChromeMock(makeKeywordMonitor());
    await importBackground();
    const tab = environment.tabs.get(1)!;

    environment.updatedEvent.emit(1, { status: "complete" }, tab);
    await vi.waitFor(() => expect(scanAlarmNames(environment)).toHaveLength(1));
    await sendMessage(environment, { type: "monitor:pause", tabId: 1 });
    expect(scanAlarmNames(environment)).toHaveLength(0);

    await sendMessage(environment, { type: "monitor:resume", tabId: 1 });
    environment.updatedEvent.emit(1, { status: "loading" }, tab);
    environment.updatedEvent.emit(1, { status: "complete" }, tab);
    await vi.waitFor(() => expect(scanAlarmNames(environment)).toHaveLength(1));
    await sendMessage(environment, { type: "monitor:stop", tabId: 1 });
    expect(scanAlarmNames(environment)).toHaveLength(0);

    environment.state.monitors["1"] = makeKeywordMonitor();
    environment.updatedEvent.emit(1, { status: "complete" }, tab);
    await vi.waitFor(() => expect(scanAlarmNames(environment)).toHaveLength(1));
    environment.removedEvent.emit(1, {
      windowId: 1,
      isWindowClosing: false
    });
    await vi.waitFor(() => {
      expect(environment.state.monitors["1"]).toBeUndefined();
      expect(scanAlarmNames(environment)).toHaveLength(0);
    });
  });

  it("recovery removes stale pending scans without fabricating a detection", async () => {
    const pending = makeKeywordMonitor("continue", {
      lastMatchState: false,
      lastScanStatus: "waiting-for-delay",
      pendingScan: {
        generation: 2,
        pageUrl: "https://example.com/",
        scheduledFor: Date.now() + 2_000,
        alarmName: scanAlarmName(1, 2),
        retryNumber: 0,
        reason: "initial-delay"
      },
      navigationGeneration: 2,
      lastCompletedGeneration: 2
    });
    const environment = installChromeMock(pending);
    environment.alarms.set(scanAlarmName(1, 2), {
      name: scanAlarmName(1, 2),
      scheduledTime: Date.now() + 2_000
    });
    await importBackground();

    await vi.waitFor(() => {
      expect(scanAlarmNames(environment)).toHaveLength(0);
      expect(
        environment.state.monitors["1"]?.keywordRuntime.pendingScan
      ).toBeNull();
      expect(
        environment.state.monitors["1"]?.keywordRuntime.lastMatchState
      ).toBe(false);
    });
    expect(environment.createNotification).not.toHaveBeenCalled();
  });

  it("injects and recovers when an existing tab has no receiver", async () => {
    const environment = installChromeMock(makeKeywordMonitor());
    environment.sendTabMessage.mockRejectedValueOnce(
      new Error("Could not establish connection. Receiving end does not exist.")
    );
    await importBackground();
    const tab = environment.tabs.get(1)!;
    environment.updatedEvent.emit(1, { status: "complete" }, tab);
    await vi.waitFor(() =>
      expect(environment.alarms.has(scanAlarmName(1, 0))).toBe(true)
    );
    environment.alarms.delete(scanAlarmName(1, 0));
    environment.alarmEvent.emit({
      name: scanAlarmName(1, 0),
      scheduledTime: Date.now()
    });

    await vi.waitFor(() => {
      expect(environment.state.monitors["1"]?.status).toBe("running");
      expect(
        environment.state.monitors["1"]?.keywordRuntime.lastScanStatus
      ).toBe("complete");
      expect(
        environment.state.monitors["1"]?.keywordRuntime.lastMatchState
      ).toBe(false);
      expect(
        environment.state.monitors["1"]?.keywordRuntime.lastError
      ).toBeNull();
      expect(environment.alarms.has(alarmName(1))).toBe(true);
    });
    expect(
      environment.executeScript.mock.calls.some(
        ([details]) => details.files?.includes("content.js")
      )
    ).toBe(true);
    expect(environment.createNotification).not.toHaveBeenCalled();
  });

  it("keeps reloading and records a friendly error when injection fails", async () => {
    const environment = installChromeMock(makeKeywordMonitor());
    environment.sendTabMessage.mockRejectedValue(
      new Error("Could not establish connection. Receiving end does not exist.")
    );
    environment.executeScript.mockRejectedValue(
      new Error("Cannot access contents of the page.")
    );
    await importBackground();
    const tab = environment.tabs.get(1)!;
    environment.updatedEvent.emit(1, { status: "complete" }, tab);

    await vi.waitFor(() => {
      expect(environment.state.monitors["1"]?.status).toBe("running");
      expect(
        environment.state.monitors["1"]?.keywordRuntime.lastScanStatus
      ).toBe("waiting-for-delay");
      expect(environment.alarms.has(scanAlarmName(1, 0))).toBe(true);
    });
    environment.alarms.delete(scanAlarmName(1, 0));
    environment.alarmEvent.emit({
      name: scanAlarmName(1, 0),
      scheduledTime: Date.now()
    });

    await vi.waitFor(() => {
      const error =
        environment.state.monitors["1"]?.keywordRuntime.lastError;
      expect(environment.state.monitors["1"]?.status).toBe("running");
      expect(error?.code).toBe("NO_CONTENT_ACCESS");
      expect(error?.message).toBe(
        "Page access is required to scan this site."
      );
      expect(error?.technicalMessage).toContain(
        "Cannot access contents of the page."
      );
      expect(environment.alarms.has(alarmName(1))).toBe(true);
    });
  });

  it("does not message or inject when host permission is missing", async () => {
    const environment = installChromeMock(makeKeywordMonitor());
    environment.containsPermission.mockResolvedValue(false);
    await importBackground();
    environment.updatedEvent.emit(
      1,
      { status: "complete" },
      environment.tabs.get(1)!
    );
    await vi.waitFor(() => {
      expect(environment.alarms.has(scanAlarmName(1, 0))).toBe(true);
    });
    environment.alarms.delete(scanAlarmName(1, 0));
    environment.alarmEvent.emit({
      name: scanAlarmName(1, 0),
      scheduledTime: Date.now()
    });
    await vi.waitFor(() => {
      expect(environment.state.monitors["1"]?.status).toBe("running");
      expect(
        environment.state.monitors["1"]?.keywordRuntime.lastError?.code
      ).toBe("NO_CONTENT_ACCESS");
    });
    expect(environment.executeScript).not.toHaveBeenCalled();
    expect(environment.sendTabMessage).not.toHaveBeenCalled();
  });

  it("clearing history preserves the transition baseline", async () => {
    const monitor = makeKeywordMonitor("continue", {
      lastMatchState: true,
      lastDetectionAt: 2_000
    });
    monitor.detectionHistory = [
      {
        id: "event-1",
        tabId: 1,
        mode: "found",
        keyword: "New Ticket",
        detectedAt: 2_000,
        pageTitle: "Autotask",
        pageUrl: "https://example.com/",
        actionApplied: "continue"
      }
    ];
    const environment = installChromeMock(monitor);
    await importBackground();
    await sendMessage(environment, {
      type: "monitor:clear-history",
      tabId: 1
    });
    expect(environment.state.monitors["1"]?.detectionHistory).toEqual([]);
    expect(
      environment.state.monitors["1"]?.keywordRuntime.lastMatchState
    ).toBe(true);
  });

  it("preserves the baseline for highlight-only edits and resets it for keyword-list edits", async () => {
    const monitor = makeKeywordMonitor("continue", {
      lastMatchState: true,
      lastScanStatus: "complete",
      lastScanAt: 2_000
    });
    monitor.status = "paused";
    monitor.nextReloadAt = null;
    monitor.detectionHistory = [
      {
        id: "event-1",
        tabId: 1,
        mode: "found",
        keyword: "New Ticket",
        matchedKeywords: [{ id: "keyword-1", value: "New Ticket" }],
        detectedAt: 2_000,
        pageTitle: "Autotask",
        pageUrl: "https://example.com/",
        actionApplied: "continue"
      }
    ];
    const environment = installChromeMock(monitor);
    await importBackground();

    await sendMessage(environment, {
      type: "monitor:update-keyword",
      tabId: 1,
      keywordMonitoring: {
        ...monitor.keywordMonitoring,
        highlightMatches: true
      }
    });
    expect(
      environment.state.monitors["1"]?.keywordRuntime.lastMatchState
    ).toBe(true);
    expect(
      environment.state.monitors["1"]?.keywordRuntime.lastScanStatus
    ).toBe("complete");

    await sendMessage(environment, {
      type: "monitor:update-keyword",
      tabId: 1,
      keywordMonitoring: {
        ...monitor.keywordMonitoring,
        highlightMatches: true,
        keywords: [
          ...monitor.keywordMonitoring.keywords,
          { id: "keyword-2", value: "Escalated" }
        ]
      }
    });
    expect(
      environment.state.monitors["1"]?.keywordRuntime.lastMatchState
    ).toBeNull();
    expect(
      environment.state.monitors["1"]?.keywordRuntime.lastScanStatus
    ).toBe("idle");
    expect(environment.state.monitors["1"]?.detectionHistory).toHaveLength(1);
  });

  it("aggregates multiple keyword matches into one detection notification", async () => {
    const monitor = makeKeywordMonitor("continue", {
      lastMatchState: false
    });
    monitor.keywordMonitoring.keywords = [
      { id: "urgent", value: "Urgent" },
      { id: "escalated", value: "Escalated" },
      { id: "new", value: "New Ticket" },
      { id: "vip", value: "VIP" }
    ];
    const environment = installChromeMock(monitor);
    environment.frameScan.mockReturnValue(true);
    await importBackground();
    environment.updatedEvent.emit(
      1,
      { status: "complete" },
      environment.tabs.get(1)!
    );
    await vi.waitFor(() =>
      expect(environment.alarms.has(scanAlarmName(1, 0))).toBe(true)
    );
    environment.alarms.delete(scanAlarmName(1, 0));
    environment.alarmEvent.emit({
      name: scanAlarmName(1, 0),
      scheduledTime: Date.now()
    });
    await vi.waitFor(() =>
      expect(environment.createNotification).toHaveBeenCalledTimes(1)
    );
    expect(
      environment.state.monitors["1"]?.detectionHistory[0]?.matchedKeywords
    ).toHaveLength(4);
    expect(
      environment.createNotification.mock.calls[0]?.[1]?.message
    ).toBe(
      "4 monitored phrases are present on Monitored. Matched: Urgent, Escalated, New Ticket, +1 more"
    );
  });

  it("keeps Present as source of truth when frame highlighting fails", async () => {
    const monitor = makeKeywordMonitor("continue", {
      lastMatchState: false
    });
    monitor.keywordMonitoring.highlightMatches = true;
    const environment = installChromeMock(monitor);
    environment.frameScan.mockReturnValue(true);
    const defaultExecuteScript =
      environment.executeScript.getMockImplementation();
    if (!defaultExecuteScript) {
      throw new Error("Expected the default executeScript implementation.");
    }
    environment.executeScript.mockImplementation(async (details: any) => {
      if (details.args?.length === 6) {
        throw new Error("No frame with id: 0");
      }
      return defaultExecuteScript(details);
    });
    await importBackground();
    environment.updatedEvent.emit(
      1,
      { status: "complete" },
      environment.tabs.get(1)!
    );
    await vi.waitFor(() =>
      expect(environment.alarms.has(scanAlarmName(1, 0))).toBe(true)
    );
    environment.alarms.delete(scanAlarmName(1, 0));
    environment.alarmEvent.emit({
      name: scanAlarmName(1, 0),
      scheduledTime: Date.now()
    });
    await vi.waitFor(() =>
      expect(
        environment.state.monitors["1"]?.keywordRuntime.lastScannedGeneration
      ).toBe(0)
    );
    const runtime = environment.state.monitors["1"]?.keywordRuntime;
    expect(runtime?.lastMatchState).toBe(true);
    expect(runtime?.lastScanStatus).toBe("complete");
    expect(runtime?.lastHighlightError?.code).toBe("FRAME_NO_LONGER_EXISTS");
    expect(environment.createNotification).toHaveBeenCalledTimes(1);
  });

  it("tests all keywords and clears highlights without mutating monitor behavior", async () => {
    const monitor = makeKeywordMonitor("continue", {
      lastMatchState: false,
      lastScanStatus: "complete",
      lastScanAt: 1_000
    });
    monitor.status = "paused";
    monitor.nextReloadAt = null;
    monitor.keywordMonitoring.keywords = [
      { id: "new", value: "New Ticket" },
      { id: "urgent", value: "Urgent" }
    ];
    const environment = installChromeMock(monitor);
    environment.frameScan.mockReturnValue(true);
    await importBackground();
    const alarmsBefore = [...environment.alarms.keys()].filter(
      (name) => name !== "luckyfetch:badge-refresh"
    );

    const response = await sendMessage(environment, {
      type: "monitor:test-keywords",
      tabId: 1,
      keywordMonitoring: monitor.keywordMonitoring
    });
    expect(response.ok && response.testResult).toMatchObject({
      status: "match",
      keywordsTested: 2,
      matchingFrameCount: 1
    });
    expect(response.ok && response.testResult?.matchedKeywords).toHaveLength(2);
    expect(
      environment.state.monitors["1"]?.keywordRuntime.lastMatchState
    ).toBe(false);
    expect(environment.state.monitors["1"]?.detectionHistory).toEqual([]);
    expect(environment.createNotification).not.toHaveBeenCalled();
    expect(
      [...environment.alarms.keys()].filter(
        (name) => name !== "luckyfetch:badge-refresh"
      )
    ).toEqual(alarmsBefore);

    await sendMessage(environment, {
      type: "monitor:clear-highlights",
      tabId: 1
    });
    expect(
      environment.state.monitors["1"]?.keywordRuntime.lastMatchState
    ).toBe(false);
    expect(environment.state.monitors["1"]?.status).toBe("paused");
  });

  it("Reload Now scans after completion without adding a scan reload count", async () => {
    const environment = installChromeMock(makeKeywordMonitor());
    await importBackground();
    await sendMessage(environment, {
      type: "monitor:reload-now",
      tabId: 1
    });
    const deadlineAfterReload =
      environment.state.monitors["1"]?.nextReloadAt ?? null;
    expect(environment.state.monitors["1"]?.reloadCount).toBe(1);

    const tab = environment.tabs.get(1)!;
    environment.updatedEvent.emit(1, { status: "loading" }, tab);
    environment.updatedEvent.emit(1, { status: "complete" }, tab);
    await vi.waitFor(() =>
      expect(environment.alarms.has(scanAlarmName(1, 1))).toBe(true)
    );
    environment.alarms.delete(scanAlarmName(1, 1));
    environment.alarmEvent.emit({
      name: scanAlarmName(1, 1),
      scheduledTime: Date.now()
    });
    await vi.waitFor(() =>
      expect(
        environment.state.monitors["1"]?.keywordRuntime.lastScannedGeneration
      ).toBe(1)
    );
    expect(environment.state.monitors["1"]?.reloadCount).toBe(1);
    expect(environment.state.monitors["1"]?.nextReloadAt).toBe(
      deadlineAfterReload
    );
  });

  it("notification clicks focus the associated live tab and clean metadata", async () => {
    const environment = installChromeMock(
      makeKeywordMonitor("continue", { lastMatchState: false })
    );
    environment.frameScan.mockReturnValue(true);
    await importBackground();
    const tab = environment.tabs.get(1)!;
    environment.updatedEvent.emit(1, { status: "complete" }, tab);
    await vi.waitFor(() =>
      expect(environment.alarms.has(scanAlarmName(1, 0))).toBe(true)
    );
    environment.alarms.delete(scanAlarmName(1, 0));
    environment.alarmEvent.emit({
      name: scanAlarmName(1, 0),
      scheduledTime: Date.now()
    });
    await vi.waitFor(() =>
      expect(environment.createNotification).toHaveBeenCalledOnce()
    );
    const notificationId = environment.createNotification.mock.calls[0]?.[0];
    expect(typeof notificationId).toBe("string");
    environment.notificationClicked.emit(notificationId as string);

    await vi.waitFor(() => {
      expect(environment.updateTab).toHaveBeenCalledWith(1, { active: true });
      expect(environment.updateWindow).toHaveBeenCalledWith(1, {
        focused: true
      });
      expect(chrome.storage.session.remove).toHaveBeenCalledWith(
        expect.stringContaining(notificationId as string)
      );
    });
  });

  it("a notification click is harmless when the associated tab is missing", async () => {
    const environment = installChromeMock(
      makeKeywordMonitor("continue", { lastMatchState: false })
    );
    environment.frameScan.mockReturnValue(true);
    await importBackground();
    environment.updatedEvent.emit(
      1,
      { status: "complete" },
      environment.tabs.get(1)!
    );
    await vi.waitFor(() =>
      expect(environment.alarms.has(scanAlarmName(1, 0))).toBe(true)
    );
    environment.alarms.delete(scanAlarmName(1, 0));
    environment.alarmEvent.emit({
      name: scanAlarmName(1, 0),
      scheduledTime: Date.now()
    });
    await vi.waitFor(() =>
      expect(environment.createNotification).toHaveBeenCalledOnce()
    );
    const notificationId =
      environment.createNotification.mock.calls[0]?.[0] as string;
    environment.tabs.delete(1);
    environment.notificationClicked.emit(notificationId);

    await vi.waitFor(() =>
      expect(chrome.storage.session.remove).toHaveBeenCalledWith(
        expect.stringContaining(notificationId)
      )
    );
    expect(environment.updateTab).not.toHaveBeenCalled();
    expect(environment.updateWindow).not.toHaveBeenCalled();
  });
});
