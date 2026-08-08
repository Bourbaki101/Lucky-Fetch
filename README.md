# LuckyFetch

LuckyFetch is a local-first Chromium extension that automatically reloads selected tabs on independent schedules and can watch visible page text for multiple keywords or phrases. It provides the reliable reloader foundation for Chrome and Edge; Adds local transition-based keyword monitoring, match-any keyword lists and optional safe highlighting. It has no backend, analytics, telemetry, remote code, or external services.

## Phase 1

- Independent configuration and state for every monitored tab
- Custom intervals from 30 seconds to 30 days, as if, lol. Plus 30-second, 1-minute, 5-minute, and 15-minute presets
- Start, Pause, Resume, Stop, and Reload Now controls
- Optional reload limit with a visible Completed state
- Optional cache bypass
- Countdown calculated from an absolute timestamp
- Active-tab badge with compact Running, Paused, Completed, and Error states
- Ignore, Delay, Pause, or Stop behavior after meaningful page interaction
- Five-second active-typing protection, enabled by default
- Local persistence and recovery after popup, service-worker, and browser restarts
- Safe cleanup when monitored tabs close or become stale
- Recoverable popup initialization with bounded browser API waits
- Per-tab reset and local diagnostic details when the worker is unavailable

The Phase 1 boundary and later ideas are in [PRODUCT.md](PRODUCT.md).

## Phase 2A + Phase 2B.1 keyword monitoring

- Up to 20 ordered Unicode keywords or multi-word phrases per monitored tab
- Match-any semantics: Present when any configured phrase appears in any accessible frame
- Found alerts only on an absent-to-present transition
- Lost alerts only on a present-to-absent transition
- The first successful scan establishes a baseline and never alerts
- Case-insensitive substring matching by default, with optional case sensitivity
- Visible-text scanning of the top-level document and every currently
  accessible child frame through `document.body.innerText`
- Configurable post-load scan delay from 0 to 60 seconds (2 seconds by default)
- Local browser notification with the optional monitor name, compact matching
  phrase metadata, detection type, page title, and time
- Optional text-node highlighting in only the matching frames, with safe DOM
  exclusions, longest-phrase-first overlap handling, and per-frame limits
- Optional transition-only tab/window activation with a five-minute focus cooldown
- Optional safe result scrolling, temporary highlighting, and one-time clicking
  with cross-frame ambiguity and destructive-control protection
- Baseline-safe Test keywords and Clear highlights actions
- Continue, Pause, or Stop the full tab monitor after detection
- Latest 50 compact history entries per tab; the popup shows the newest 5
- Persistent baseline, scan status, typed errors, and safe service-worker recovery

Scanning happens only after a completed load for a tab whose monitor is Running and whose keyword monitoring is enabled. Reload Now follows the same completed-load and delayed-scan lifecycle. Scanning never increments the reload count, changes the reload deadline, or creates another reload loop.

Immediately before each scan, Lucky Fetch discovers the tab's current frame tree
and runs a compact local match in each accessible frame. The tab is Present when
any frame matches. It is Absent only when every expected frame completed without
a match. If a frame disappears, cannot be injected, or lacks permission, the
popup reports a Partial scan and preserves the last known state; an uncertain
scan cannot produce a Lost alert. Frame results contain only match metadata, and
Found/Lost transitions are evaluated once at the tab level.

Keyword settings are locked while the monitor is Running. Pause or Stop to edit them. Adding, removing, reordering, or changing a keyword, changing mode, or changing case sensitivity resets the baseline; changing only the monitor name, delay, after-detection action, or highlight setting preserves it. Start always resets the baseline conservatively, while Resume preserves it and waits for the next completed load. Pause preserves the last highlights; Stop removes them.

Saved Phase 2A records migrate locally and idempotently from `keyword` to `keywords[]`. Valid running monitors retain their tab-level baseline and history; highlighting, bring-to-front, and auto-open all default off. Corrupt legacy values are disabled safely rather than interpreted as page content.

## Install in Chrome

1. Run `npm install` and `npm run build`.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked**.
5. Select the generated `dist` folder.
6. Pin LuckyFetch from the Extensions menu if desired.

## Install in Microsoft Edge

1. Run `npm install` and `npm run build`.
2. Open `edge://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked**.
5. Select the generated `dist` folder.

## Development commands

```bash
npm run dev
npm run build
npm run test
npm run lint
npm run typecheck
npm run package
```

`npm run dev` starts Vite for popup/test-page development. Browser extension APIs are available only when the built extension is loaded in Chrome or Edge, so use `npm run build` and reload the unpacked extension for end-to-end checks.

The interaction test page is available at `http://localhost:5173/test-page/` while Vite is running. It contains scrolling and editing controls whose unsaved values make unexpected reloads obvious.

## Build and package

`npm run build` produces the loadable extension in `dist/`.

`npm run package` rebuilds the extension and writes:

```text
package-output/luckyfetch-v0.2.0.zip
```

The ZIP contains the contents of `dist` at its root and can be extracted and loaded as an unpacked extension.

## Permissions

LuckyFetch requests only extension capabilities needed for the implemented phases:

- `alarms`: schedules reload deadlines without depending on a continuously running service worker.
- `storage`: stores monitor settings and essential state locally, and uses session storage to help detect reused tab IDs.
- `tabs`: reads the selected tab's title/URL, reloads it, updates lifecycle state, and cleans up closed tabs. LuckyFetch does not collect browsing history.
- `scripting`: injects the small local interaction detector and executes the
  local visible-text matcher in each accessible frame of a monitored tab.
- `webNavigation`: discovers the current frame IDs, document IDs, and frame URLs
  immediately before a scan. This is used to avoid stale iframe results and does
  not read page content or browsing history.
- `notifications`: shows a local notification only after a qualifying Found or Lost transition. Clicking it activates the related tab and focuses its browser window if the tab still exists. Detection activates a tab only when the monitor's optional bring-to-front action requests it.
- Optional host access is requested only after Start. The popup saves the
  complete validated form before opening Chromium's permission prompt, restores
  it after popup closure, denial, or an interrupted request, and removes the
  draft only after Start succeeds or the user discards it.
- Site access defaults to the current website. Users may explicitly choose
  access to all HTTP and HTTPS websites; even with that grant, LuckyFetch scans
  only tabs where a monitor was started.
- Optional `http://*/*`, `https://*/*`, and `file:///*` host access: these patterns allow LuckyFetch to ask for access to the **current site only** when Start is pressed. They are not granted at installation. Continued site access is required so interaction and typing protection can be restored after a reload. Local-file monitoring also requires enabling “Allow access to file URLs” on the extension details page.

There is no required `<all_urls>` host permission and no install-time access to every website.

## Reload Now behavior

For a running monitor, Reload Now performs an immediate reload, counts it, and resets the next deadline to one full interval from the request. For a paused or stopped monitor, it counts the reload but preserves the paused/stopped state. Reload Now uses normal caching if there is no saved monitor.

## Recovery and diagnostics

The popup never waits indefinitely for the service worker. If active-tab lookup or background communication does not settle within four seconds, LuckyFetch shows a recoverable error screen with:

- Retry
- Reset this tab
- Reload extension state
- Show/copy local diagnostic details
- Restart extension worker

**Reset monitor for this tab** removes the saved monitor, verifies that its deterministic reload and scan alarms were canceled, removes its tab-instance token, and clears that tab's badge. If the background worker cannot respond, the popup performs the same cleanup directly through extension storage and alarms.

The diagnostics panel compares popup state, local storage, Chromium alarms, the current tab, and the background worker's in-memory state. Diagnostic data stays local unless the user explicitly copies it.

For development cleanup, open **Show diagnostics** and choose **Reset all monitors**. This clears saved monitors and per-tab reload/scan alarms after confirmation.

## Known limitations

- The minimum interval is 30 seconds. Fast mode is intentionally not included in Phase 1.
- Chromium alarms are best-effort. Sleeping devices, browser suspension, heavy load, or background throttling can deliver an alarm late.
- While monitoring is active, the badge counts down every second from persisted absolute deadlines and shows whichever running tab will refresh next. It restores from the timestamp whenever the Manifest V3 worker wakes.
- Chromium does not provide a definitive “page rendered successfully” result for `tabs.reload()`. LuckyFetch reports API rejection as Error and refreshes metadata when tab loading completes.
- Browser-internal pages, extension stores, and other protected pages cannot be monitored.
- Cross-origin same-tab navigation preserves the saved monitor but enters Error until the user opens LuckyFetch and starts a new run, granting access to the new site.
- After a full browser restart, tab reuse is guarded by the saved URL because Chromium does not expose a permanent tab identity. A restored tab whose URL differs from the saved monitor is treated as stale and removed.
- Keyword monitoring scans the visible `innerText` of the top-level document and current
  child frames covered by granted host access. A cross-origin frame without
  access makes an otherwise negative result Partial; LuckyFetch does not request
  that origin or all-sites access silently. Shadow DOM, HTML source, selected
  areas, and continuous DOM observation are not scanned.
- If the worker/browser stops while a delayed scan is pending, recovery discards that stale scan. The saved baseline remains intact and scanning resumes after the next completed load; restart never fabricates a detection.
- A scan failure is recorded in the popup but does not stop the reload monitor. LuckyFetch tries again after the next successful completed load.

Future phases may add Match All, AND/OR expressions, exact/whole-word/regular-expression modes, sound, optional focus behavior, DOM-stability or continuous monitoring, selected-area/HTML/shadow-DOM scanning, Changed mode, auto-click, schedules, and explicitly authorized integrations. These are not part of Phase 2B.1.

## Reporting a bug

Please include the browser and version, extension version, page scheme/domain (omit sensitive paths), monitor settings, expected behavior, observed behavior, and reproducible steps. Do not include private form data or page content.

See [TESTING.md](TESTING.md) for the verification checklist.
