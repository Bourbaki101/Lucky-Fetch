# Privacy

LuckyFetch is local-first.

- No analytics
- No telemetry
- No advertising or tracking
- No backend or external service
- No data transmission outside the browser
- No remote code or CDN dependencies
- No browsing-history collection
- No page-content transmission outside the extension

The injected content script observes only event categories and timestamps needed for the selected interaction behavior and active-typing safety. It does **not** read or store typed values, selected values, form contents, or keystroke characters.

When the user explicitly enables keyword monitoring for a tab, LuckyFetch reads visible text using `document.body.innerText` in the top-level document and every current child frame covered by the user's granted host access. Matching happens locally inside each frame. The full page text is never returned to the service worker, sent to storage, included in diagnostics, placed in notifications, or transmitted outside the extension. Only compact per-frame metadata—match state, matching configured keyword IDs/values, scan time, page title/URL, text length, and frame/document identity—is returned and aggregated into one tab-level result.

Monitor configuration and essential state remain in local Chromium extension storage. Stored keyword data is limited to the user-configured keyword list, optional monitor name, mode/settings, current tab-level match state, compact matched-keyword/frame/highlight counts, timestamps, typed errors, and a capped detection history containing only matched configured keyword IDs/values, page title/URL, action, and detection time. Old history entries without matched-keyword metadata remain readable. A validated pending monitor draft may also be stored locally while Chromium asks for site access; it is removed after the monitor starts successfully or the user discards it. Full page text and excerpts are not stored. Live tab-instance and notification-target tokens are kept in Chromium session extension storage. Data is not synced.

Optional site access defaults to the current site and is requested only when the user starts monitoring. A user may instead explicitly choose all HTTP and HTTPS websites. LuckyFetch never expands access silently and does not scan tabs that lack an explicit per-tab monitor with keyword monitoring enabled. A cross-origin child frame without access is skipped and makes an otherwise negative scan Partial, preventing an uncertain Lost alert.

Qualifying Found/Lost transitions can create a Chromium browser notification. The notification stays local to the device and contains the optional monitor name, up to three configured matching keyword values (plus a count for any remainder), the page title, and concise result/time. Lost notifications state that no configured phrases remain. LuckyFetch does not include page excerpts. It activates the related tab only if the user clicks the notification; detection itself does not focus a tab or window.

When highlighting is enabled, LuckyFetch wraps safe visible matching text nodes in extension-owned `<mark>` elements inside only the frames that matched. Highlights exist only in the current page DOM, are not transmitted or stored as page content, and are removed on Stop, reset, disabling/changing the condition, an Absent scan, or the explicit Clear highlights action. Highlighting excludes forms, editable regions, scripts/styles, hidden content where practical, and extension UI.

The optional diagnostics panel reads extension-local monitor state, alarm metadata, and the current tab metadata. It remains inside the popup unless the user explicitly presses **Copy details**. LuckyFetch never transmits diagnostic data.

Removing the extension removes its extension storage according to browser behavior. Users can clear the current tab's detection history without resetting its match baseline, or stop individual monitors to cancel future reloads and scans.
