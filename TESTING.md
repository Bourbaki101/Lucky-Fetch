# Testing

## Automated checks

Run:

```bash
npm run lint
npm run typecheck
npm run test
npm run build
npm run package
```

The unit and mocked-Chromium suites cover interval conversion/validation, bounded-operation timeouts, remaining-time calculation, badge formatting, deterministic reload/scan alarm creation, matching and whitespace normalization, Found/Lost transition semantics, detection actions/history, state migration/corruption repair, maximum-count completion, lifecycle transitions, Reload Now semantics, all interaction decisions, typing protection, recovery planning, delayed scan generation handling, duplicate completion suppression, scan cancellation, detection notification suppression/focus, missing-alarm restoration, alarm execution, reload rejection, tab-specific badge clearing, Pause/Resume/Stop alarm behavior, and monitor reset.

## Load the extension

1. Run `npm run build`.
2. Load `dist/` as an unpacked extension in Chrome or Edge.
3. After rebuilding, use the extension page's Reload action before retesting.

## Interaction test page

1. Run `npm run dev`.
2. Open `http://localhost:5173/test-page/`.
3. Start a 10-second LuckyFetch monitor for that tab.
4. The page shows a per-tab load counter and load time.
5. Enter distinctive unsaved text before testing protection.

The page includes regular text, a scroll box, text input, textarea, select, contenteditable region, button, and visible event log.

## Manual verification matrix

### Basic lifecycle

- Start: status becomes Running and countdown begins near the configured interval.
- Pause: countdown becomes unavailable and no reload occurs.
- Resume: a fresh full countdown starts.
- Stop: future reloads remain canceled after popup closure.
- Reload Now while Running: page reloads, count increments, full countdown restarts.
- Reload Now while Paused: page reloads, count increments, state remains Paused.

### Intervals and limits

- Reject blank, zero, negative, non-numeric, under-10-second, and over-30-day values.
- With Reload and Monitor enabled together, accept a monitor delay equal to half the reload interval and reject anything above it.
- Verify all four presets.
- With maximum 2, confirm the second accepted reload sets Completed, preserves count 2, and cancels the alarm.
- Verify Unlimited continues.

### Cache

- Confirm bypass cache defaults off.
- Test both settings in DevTools Network; Chromium may still use service-worker/application caches controlled by the page.

### Interaction

For each behavior, interact using pointer, keyboard, scrolling, form input, and editable focus:

- Ignore keeps the original deadline.
- Delay restarts a full interval.
- Pause enters Paused and can be manually resumed.
- Stop enters Stopped.

With typing protection enabled, type through a reload deadline and confirm the unsaved text remains until at least five seconds after the final typing/input event. A merely focused input must not block forever.

### Tab and navigation lifecycle

- Close a monitored tab and confirm its alarm/state are removed.
- Reload normally and confirm monitoring continues.
- Navigate within the granted origin and confirm title/URL update.
- Navigate to another origin and confirm Error rather than repeated reload failures.
- Navigate to `chrome://settings` or `edge://settings` and confirm Error.
- Restart the extension service worker from the extensions page; confirm the alarm is restored once.
- Restart the browser with a monitored tab and confirm safe recovery.
- Reload/update the unpacked extension and check that stale alarms are reconciled.

### Badge and accessibility

- Switch between monitored and unmonitored tabs; the unmonitored badge must clear.
- Verify Running, Paused, Completed, and Error markers.
- Navigate the popup with keyboard only.
- Confirm visible focus, logical tab order, labeled controls, readable contrast, and live status/error announcements.

### Worker failure and recovery

- Temporarily make the background worker unavailable and open the popup. Within four seconds it must show Recoverable Error, never permanent Loading.
- Confirm Retry does not launch overlapping requests.
- Confirm Reset this tab clears `luckyfetch:reload:<tabId>`, local monitor state, session identity, and the tab badge.
- On a Running monitor, manually remove its alarm in the worker console and reopen the popup. The missing alarm must be recreated and verified.
- Save an overdue `nextReloadAt`, restart the worker, and confirm recovery persists a near-immediate deadline and reloads once.
- Use Show diagnostics and verify it reports storage, matching alarm, tab existence, worker initialization, and any schedule-health notes.
- Switch to an unrelated tab and verify every badge call for tab state uses that tab's ID and clears its text.

### Phase 2A + Phase 2B.1 keyword monitoring

- Enable Found mode with a keyword absent from the first completed load; confirm the baseline is Absent and no notification appears.
- Make the keyword appear on the next load; confirm exactly one notification/history entry. Keep it present through another load and confirm there is no repeat. Remove and re-add it to confirm rearming.
- Repeat the inverse sequence in Lost mode.
- Add several keywords and verify any one can make the tab Present; several simultaneous matches must still create only one transition notification/history entry.
- Verify case-insensitive/case-sensitive behavior, Unicode, multi-word phrases, whitespace trimming, duplicate rejection, 20-rule limit, and 200-character limit.
- Verify delay values 0, 2, and 60 seconds; reject blank, negative, non-numeric, and over-60 values.
- Trigger Reload Now and confirm the scan follows completion without incrementing the count a second time or changing the resulting reload deadline.
- Verify Continue keeps Running, while Pause and Stop cancel both reload and scan alarms.
- Confirm keyword settings are locked while Running; pause and add/remove/edit/reorder a keyword or change mode/case, save, and confirm the baseline becomes Unknown without clearing history.
- Change only monitor name, delay, after-detection action, or highlighting and confirm the baseline is preserved.
- Upgrade a saved single-keyword monitor and confirm it becomes one stable-ID rule, retains a safe baseline/history, and defaults highlighting off.
- Enable highlighting and verify matches in the main document and Autotask iframe are marked without changing inputs, selection, focus, contenteditable values, or page event handlers.
- Verify `New Ticket` wins over overlapping `Ticket`, no nested marks are created, matching remains case-consistent, and 500+ is reported when the limit is reached.
- Confirm Pause preserves highlights, Resume refreshes them after the next scan, and Stop/reset/disable/Absent/keyword change/Clear highlights remove them.
- Force one matching frame to disappear or reject highlighting; Present and transition behavior must remain correct while the popup reports a nonfatal highlight issue.
- Run Test keywords and verify Match/No match/Partial, tested/matched counts, matching frames, highlight counts/truncation/errors, and no baseline/history/notification/reload-schedule changes.
- Clear history and confirm the current match baseline remains unchanged.
- Navigate during a delayed scan and confirm the old generation never scans the new document.
- Restart the worker with a pending scan and confirm the stale scan is discarded, the prior baseline is preserved, and no notification is fabricated.
- Click a notification and confirm the associated existing tab/window focuses. Close the tab first and confirm clicking is harmless.
- On a protected/unsupported page or after content-script failure, confirm a typed scan error appears while reload monitoring continues.

## Packaging check

Run `npm run package`, extract the ZIP from `package-output/`, and load the extracted directory as an unpacked extension. `manifest.json` must be at the ZIP root.
