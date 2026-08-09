# Architecture

## Extension contexts

### Background service worker

`src/background/index.ts` owns monitor coordination. It validates commands, persists state, schedules reload and scan alarms, reloads tabs, evaluates keyword transitions, creates notifications, updates badges, injects the content script, handles tab/navigation events, and reconciles saved state after restarts.

The worker assumes it can stop between any two browser events. Durable behavior is based on local storage and absolute timestamps rather than a continuously running process.

Every Chromium API wait on the startup, messaging, scheduling, reload, and badge paths is bounded. A stalled API call can produce a typed error, but cannot permanently block every later popup request and alarm. Mutating operations remain serialized to prevent lost storage updates; reset and diagnostics have a bounded recovery path that does not wait behind normal work.

### Content script

`src/content/index.ts` is a small, self-contained script injected only into a monitored tab after site access is granted. It reports pointer, keyboard, scroll, form-input, and editable-focus events. For an explicit keyword scan request it reads `document.body.innerText`, performs match-any substring matching locally, and returns only compact per-keyword result metadata. Its safe highlighting helper traverses eligible text nodes and creates only extension-owned marks. It never returns or stores visible page text. A page-level guard prevents duplicate listeners.

### Popup

`src/popup/` is a React UI. It queries the active tab, renders saved monitor state, requests current-site access on Start, validates configuration, and sends typed lifecycle commands. Its countdown is derived from `nextReloadAt - Date.now()` on every render tick.

### Shared modules

- `src/types/`: persisted monitor and interaction types
- `src/messaging/`: discriminated request/response contracts
- `src/monitoring/`: pure matching, transition, history, and detection-action logic
- `src/storage/`: versioned local-storage access
- `src/scheduling/`: alarm naming and scheduling
- `src/shared/`: constants, URL policy, validation, time/badge formatting, and pure state transitions

## Scheduling strategy

Every running monitor has one one-shot alarm named `luckyfetch:reload:<tabId>`. After an accepted reload request, LuckyFetch increments the count and schedules a new one-shot alarm from the new absolute deadline. Delay behavior moves the stored deadline and recreates the alarm. Pause, Stop, Completed, and Error clear it.

Keyword monitoring does not create a reload loop. A completed load schedules at most one one-shot `luckyfetch:scan:<tabId>:<generation>` alarm after the configured delay. When it fires, the worker rechecks the tab, monitor status, keyword configuration, navigation generation, URL snapshot, and content-script response before updating the baseline. Duplicate completion events are ignored and old generations cannot scan a newer document.

Alarm creation is followed by `chrome.alarms.get(name)` verification. A Running monitor is not allowed to keep a Running badge if Chromium did not retain its alarm; scheduling failure is persisted as Error. Alarm execution reloads the latest storage snapshot before making a decision.

A singleton one-second timer updates each running monitor's per-tab badge from its own deadline. A 30-second repeating alarm remains a wake-up fallback; both paths recalculate from persisted absolute timestamps, so worker suspension or delayed delivery does not accumulate countdown drift.

Reload Now resets a running monitor's deadline. It preserves Paused/Stopped state when used there.

## Storage model

`chrome.storage.local` contains one versioned object:

```text
{
  version: 4,
  monitors: {
    "<tabId>": TabMonitor
  },
  notificationHistory: NotificationHistoryEntry[]
}
```

A monitor stores tab metadata, reload configuration/count/status, interaction timestamps, typing-protection deadline, an error message, a generated tab-instance token, separate keyword configuration/runtime, and a newest-first capped detection history. Version 1 records migrate locally with keyword monitoring disabled and an unknown baseline. Version 2 single-keyword records migrate to an ordered rule list with a deterministic stable legacy ID and `highlightMatches: false`. Version 4 adds the global notification history. The normalizer accepts versions 1–4 and always emits version 4, making migration idempotent. Valid legacy runtime baselines and detection histories are preserved.

Each configured keyword has a stable ID and trimmed value. Matching and highlighting use the same case-sensitivity setting. Tab state is Present when any configured keyword matches in any successfully scanned frame. Frame matches are aggregated before the single Found/Lost transition is evaluated. Successfully created browser alerts also append compact Found/Lost metadata to a global newest-first notification history capped at 15 entries.

Highlighting is secondary to scanning. The background targets only the matching frame/document identities from the successful scan. The DOM highlighter clears its prior marks, skips unsafe/editable elements, applies longest phrases first to prevent overlap, and stops at 500 marks or 20,000 processed text nodes per frame. Typed highlight errors and truncation never change match state or create another detection.

Optional trigger actions run only after a real tab-level state transition. For a Found action, the worker resolves compact, tokenized DOM candidates in every matching frame, builds and persists a hashed result signature, rejects ambiguous or unsafe targets, optionally activates the tab and focuses its window, then scrolls, temporarily highlights, and clicks once. Focus and click timestamps survive service-worker suspension; focus also has a five-minute cooldown. No page row text is logged or persisted.

`chrome.storage.session` maps live tab IDs to those instance tokens. It survives service-worker restarts but not a browser restart. After a full restart, saved URL equality is the conservative fallback for detecting stale/reused tab IDs.

## Message flow

```text
Popup -- typed command --> Background -- storage/alarm/tabs APIs
  ^                             |
  |------ typed response -------|

Content script -- interaction/ready event --> Background

Background -- typed compact scan request --> Content script
Background <-- matched/result metadata ----- Content script
```

The background derives the sender tab ID for content messages; page code cannot choose another monitor's tab ID.

## Badge behavior

The badge is scoped per tab:

- Running: compact remaining time such as `45s`, `3m`, or `2h`
- Tabs without a running countdown: cleared

It refreshes every second while the worker is alive and also restores on state changes, tab activation/window focus, popup polling, startup, installation, and the 30-second badge alarm. Each running monitor writes its own `tabId` action override, so switching tabs immediately reveals that tab's countdown while the global action default remains clear.

The countdown timer still runs in the background service worker without the popup. Persisted absolute deadlines and the badge alarm preserve recovery behavior across worker suspension.

## User interaction handling

The content script reports event kind, event time, and whether a keyboard/form event occurred in an editable control. The background applies one pure decision:

- Ignore: record interaction; keep deadline
- Delay: move deadline to `interaction time + interval`
- Pause: clear deadline; manual Resume creates a fresh one
- Stop: clear deadline and end monitoring

When typing protection is enabled, editable keyboard/input events set `typingProtectionUntil` to five seconds after the event. If an alarm arrives inside that window, the reload is deferred to the protection deadline. Focus alone is a meaningful interaction for behavior rules but does not block forever; only recent typing/input creates the safety window.

## Recovery

Worker startup, browser startup, and extension install/update run the same idempotent reconciliation:

1. Validate persisted monitor shape.
2. Query open tabs and all LuckyFetch alarms.
3. Remove monitors whose tabs no longer exist or whose instance evidence is stale.
4. Recreate the one correct alarm for every Running monitor.
5. Clear orphan alarms and alarms for non-running states.
6. Restore the badge refresh alarm and active-tab badge.

All pending scan alarms are treated as stale during recovery and removed. Their pending markers are cleared, but the last successful match baseline is preserved. The next completed page load schedules fresh scan work; startup itself never evaluates a transition or creates a detection.

Alarm names are deterministic, so recreation does not create duplicates.

An overdue Running deadline is moved to a near-immediate recovery deadline one second in the future, persisted, and verified. It is never left displaying an expired countdown without a real alarm.

## Popup failure states

The popup renders its shell before background communication and uses explicit `loading`, `ready`, `unsupported`, and `error` phases. Active-tab lookup, local fallback-state lookup, and typed background messaging are bounded. The `finally` path guarantees that initialization cannot remain in Loading without a transition.

When background communication fails, the popup can still inspect local storage/alarms and directly reset a known tab monitor. The Reset action cancels the alarm, removes durable state and the tab-instance token, and clears that tab's badge. A separate confirmed development action resets every monitor.

Structured diagnostic details include initialization status, durable/in-memory monitor state, matching alarm, open-tab validity, and recovery notes. They do not include page content or form values.

## Manifest V3 tradeoffs

- Service workers are suspendable; no correctness depends on in-memory timers.
- Chromium alarms have a 30-second minimum in supported browser versions and may be delayed.
- Optional per-site access is required to restore interaction detection after reloads. It cannot be requested silently after cross-origin navigation, so those monitors enter Error.
- Protected browser pages and extension stores reject script injection.
- `tabs.reload()` confirms that the browser accepted the API request, not that the final page rendered successfully.
- Tab IDs are not permanent identities across a complete browser restart; URL matching is the conservative recovery fallback when session tokens are unavailable.
