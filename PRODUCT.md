# Product

## Purpose

LuckyFetch makes periodic page reloads dependable, understandable, and independent per tab while keeping all configuration in the browser.

## Target use cases

- Refreshing operational dashboards or status pages
- Watching a queue, report, or locally served development page
- Repeating a page reload for a bounded test
- Keeping multiple tabs on different refresh schedules
- Avoiding reloads while actively editing a form

## Phase 1 features

- Per-tab monitors with persisted settings, timestamps, status, and count
- A reliable minimum interval of 30 seconds using Manifest V3 alarms
- Start, Pause, Resume, Stop, and Reload Now
- Unlimited or bounded reload count
- Optional cache bypass
- Popup countdown and active-tab action badge
- Interaction-aware Ignore, Delay, Pause, and Stop choices
- Five-second active-typing safety window
- Tab/navigation lifecycle handling and idempotent recovery
- Optional site permission requested when monitoring starts

## Phase 2A features

- One per-tab keyword or phrase matched against accessible-frame visible text
- Found and Lost transition detection with an unknown initial baseline
- Optional case sensitivity and a durable 0–60-second post-load delay
- Local Chromium notification and compact per-tab history
- Continue, Pause, or Stop the full monitor after detection
- Persistent transition state, typed scan diagnostics, and safe restart recovery

## Phase 2B.1 features

- Up to 20 ordered, stable-ID Unicode keywords or phrases with Match Any semantics
- Compact per-keyword and per-frame match metadata aggregated at tab level
- Optional safe visible-text highlighting in matching frames
- Optional transition-only tab/window activation with cooldown protection
- Optional safe scrolling and one-time result clicking with ambiguity protection
- Non-mutating multi-keyword test and baseline-safe highlight clearing
- Idempotent migration from Phase 2A single-keyword records

## Explicit non-goals for Phase 2A

- Sub-30-second Fast mode
- Cloud sync, accounts, or a backend
- Analytics, telemetry, advertising, or remote code
- Scheduled time-of-day/calendar rules
- A dashboard for every monitored tab
- Firefox or Safari support
- Match All and AND/OR expression rules
- Exact, whole-word, or regular-expression matching
- Sound, automatic tab/window focus, or auto-click
- Changed mode, DOM-stability detection, continuous MutationObserver monitoring, or selected-area monitoring
- HTML-source, cross-origin iframe, or shadow-DOM scanning
- Email, Slack, webhook, external-service, or backend integrations

## Later-phase ideas (documentation only)

- A dedicated monitor dashboard with search and bulk pause/stop
- Per-monitor labels and reusable local presets
- Optional sub-30-second Fast mode with prominent throttling warnings
- Export/import of local configuration
- More navigation policies, such as stop on cross-origin navigation
- Accessible sound cues, disabled by default
- Advanced matching, selected-area rules, and DOM-stability detection
- Optional user-authorized focus or auto-click actions
- Local completion/error notifications

## Phase 3 ideas (documentation only)

- Local page-change rules that operate on user-selected elements
- Multi-step local workflows with explicit user authorization
- Schedule windows and calendar-like recurring rules
- Optional cross-device configuration sync using browser-managed sync storage
- Firefox support and shared cross-browser packaging
- Organization policy controls for managed deployments

Future ideas are not implemented in Phase 2B.1.
