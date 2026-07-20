# Scheduled Review — Daily Inbox Reminder

**Status:** Approved design · **Date:** 2026-07-17 · **Branch:** `inbox-review-reminder`

## Overview

An optional daily reminder that nudges the user to process the day's captures in one
calm pass. At a user-set local time (default 18:00), each running device checks its
inbox and, if there are items to review, fires a single desktop notification. The
schedule (on/off + time) is configured from **Settings → Inbox** and syncs across
devices. Each device watches independently and notifies at most once per day.

## Goals

- Optional (default OFF), user-set daily local time to be reminded.
- Fire an OS desktop notification **only if** the inbox has items to review.
- Schedule (enabled + time) **syncs** across devices; each device honors it locally.
- Configured from a new **Settings → Inbox** section.
- At most one notification per device per day; calm, not naggy.

## Non-Goals

- No cross-device notification de-duplication (each open device may notify).
- No re-nudging within the same day.
- No control over OS-level Do Not Disturb / notification permission (OS owns that).
- No new dock/app badge (the sidebar badge already exists; unchanged).
- No per-item or multi-time reminders — a single daily review nudge only.

## User-Facing Behavior

Settings → Inbox shows a "Daily review reminder" group:

- **Toggle** — enable/disable the reminder (default OFF).
- **Time picker** — local time to be reminded (default 18:00, shown only when enabled).

When enabled, on each device that is running with the vault open: at (or, if the app
was closed at) the chosen local time, if the inbox has reviewable items, the OS shows
a notification such as _"Time to review — you have 4 items in your inbox."_ Clicking it
focuses the app and opens the Inbox. It fires once per day per device.

## Decisions (locked)

| Question                                           | Decision                                                                       |
| -------------------------------------------------- | ------------------------------------------------------------------------------ |
| App closed at target, opened later same day        | **Catch up** — notify once, any time before local midnight                     |
| Cross-midnight catch-up (missed late-night target) | **No** — same calendar day only                                                |
| Multiple devices open at target                    | **Each device fires** (per-device last-fired)                                  |
| What counts as "inbox has items"                   | **Match the sidebar badge** — unfiled − snoozed − viewed-reminders             |
| Re-nudge after firing                              | **No** — once per day                                                          |
| Default state / time                               | **OFF** / **18:00** local                                                      |
| Time semantics                                     | **Local wall-clock**; enabled+time sync, each device reads in its own timezone |
| Sync mechanism                                     | Reuse the **settings-sync singleton** (per-field vector clocks, LWW)           |

## Data Model

**Synced** — new `inbox` settings group (persisted in the SQLite `settings` table,
included in the synced-settings payload):

```ts
InboxSettings = {
  reviewReminderEnabled: boolean   // default false
  reviewReminderTime: string       // "HH:MM" 24h, default "18:00"
}
```

**Local, not synced** — active-vault SQLite `settings` table, a device-local key:

```ts
reviewLastNotifiedDate: string | null // local "YYYY-MM-DD"; null = never
```

`reviewLastNotifiedDate` is deliberately **excluded** from the synced set. Keeping it
device-local is what makes "each device fires once/day" work; syncing it would let one
device suppress another. It is stored per vault, so switching vaults uses that vault's
own last-fired state.

## Architecture / Components

Each unit has one purpose and is independently testable.

1. **Contract** (`packages/contracts`, `packages/rpc`)
   - `settings-schemas.ts`: `InboxSettingsSchema` + `INBOX_SETTINGS_DEFAULTS`.
   - `settings-sync.ts`: add `inbox` group to `SyncedSettingsSchema`.
   - `ipc-channels.ts`: `SettingsChannels.invoke.GET_INBOX_SETTINGS` / `SET_INBOX_SETTINGS`.
   - `packages/rpc/src/settings.ts`: `getInboxSettings` / `setInboxSettings` methods
     (regenerates preload DTO via `pnpm ipc:generate`; verify with `pnpm ipc:check`).

2. **Main persistence + sync** (`apps/desktop/src/main`)
   - `ipc/settings-handlers.ts`: get/set handlers via
     `readGroupSettings('inbox', INBOX_SETTINGS_DEFAULTS)` /
     `writeGroupSettings('inbox', …)`. Set path also drives the sync manager.
   - `sync/item-handlers/settings-handler.ts`: `propagateMergedSettings` and
     `broadcastSettingsChanged` learn the `inbox` group so remote merges write back
     and broadcast a `settings:changed` for `key === 'inbox'`.

3. **Count helper** (`apps/desktop/src/main/inbox/stats.ts`)
   - `countReviewableInboxItems(): number` — a main-side mirror of the sidebar badge
     (`app-sidebar.tsx`): unfiled inbox items, excluding snoozed and reminders that
     have a `viewedAt`. Modeled on existing `countStaleItems()`. The exact SQL
     predicates are verified against `inboxItems` during implementation so the count
     equals the badge.

4. **Review scheduler** (new `apps/desktop/src/main/inbox/review-scheduler.ts`)
   - `startInboxReviewScheduler()` / `stopInboxReviewScheduler()` / `isRunning()`.
   - 60s interval, run-immediately on start (startup catch-up), plus
     `powerMonitor.on('resume', …)` catch-up after machine wake. `stop` clears the
     interval and removes the resume listener.
   - Pure decision core (no timers, no I/O):

     ```ts
     decideReviewNotification(input: {
       enabled: boolean
       target: string            // "HH:MM"
       now: Date                 // local
       lastNotifiedDate: string | null
       inboxCount: number
     }): { notify: boolean; nextLastNotifiedDate: string | null }
     ```

   - `runReviewTick(nowOverride?)`: reads `inbox` settings + `reviewLastNotifiedDate`,
     computes `inboxCount` via the helper, calls `decideReviewNotification`, and on
     `notify` shows the notification and persists `nextLastNotifiedDate`. Guarded by
     vault-open status. Exposed for a test-only IPC to force a tick in E2E.

5. **Notification** (reuse `apps/desktop/src/main/lib/reminders.ts:showDesktopNotification`,
   extracted to a shared helper if needed)
   - Title/body via `getMainI18n()` (`notification.inboxReview.*`), pluralized on count.
   - `Notification.isSupported()` false → log warn + skip.
   - On click: restore/focus main window, then `webContents.send` a channel the
     renderer routes to the Inbox.

6. **Renderer** (`apps/desktop/src/renderer`)
   - New `pages/settings/inbox-section.tsx`; nav item + `activeSection === 'inbox'`
     branch in `pages/settings.tsx`; `'inbox'` added to the settings-modal-context
     section union.
   - `hooks/use-inbox-preferences.ts`: `window.api.settings.getInboxSettings()` /
     `setInboxSettings(updates)` + live merge on `onSettingsChanged(e => e.key === 'inbox')`.
     Modeled on `use-task-preferences.ts`.
   - UI: `SettingsGroup` with a toggle and a time input (RTL-safe logical classes).

7. **Lifecycle** (`apps/desktop/src/main/index.ts`)
   - `startInboxReviewScheduler()` in the `whenReady` arming block (near the existing
     `startReminderScheduler()`), guarded by `isAppShuttingDown()`.
   - `stopInboxReviewScheduler()` in the `before-quit` shutdown chain (near
     `stopReminderScheduler()`).

## Data Flow

**Configure:** Settings → Inbox → `setInboxSettings({enabled, time})` →
`writeGroupSettings('inbox')` persists to SQLite + `SettingsSyncManager.updateField('inbox.…')`
enqueues sync + broadcasts `settings:changed`. Renderer hook merges the change. The
scheduler reads settings live on its next tick — no explicit re-arm needed.

**Remote change:** device receives the settings payload → `SettingsHandler` merges
(per-field LWW) → `propagateMergedSettings` writes SQLite + broadcasts
`settings:changed` → that device's scheduler reads the new values on its next tick.

**Fire:** scheduler tick → `decideReviewNotification` → notification → click →
focus + navigate to Inbox.

## Fire Rule (per tick)

Notify iff, in order: vault open → `enabled` → `nowLocal ≥ target` (same calendar day)
→ `lastNotifiedDate ≠ todayLocal` → `inboxCount > 0`. On fire, set
`lastNotifiedDate = todayLocal`. The date guard makes the tick idempotent, so the
interval and the `resume` catch-up cannot double-fire.

## Sync & Backward Compatibility

Production has real users on older app versions; the change must not corrupt their data.

- The `inbox` group is added to `SyncedSettingsSchema` and merged with per-field
  vector clocks (same path as `tasks`/`calendar`).
- **Must-verify during implementation:** an older client that receives a settings
  payload containing the unknown `inbox` group must **preserve** it (or at least not
  clobber it on its own re-emit). Confirm the settings-sync serialization preserves
  unknown/extra fields; if it strips them, the field only propagates among updated
  clients, which is acceptable, but old clients must never zero it out for newer ones.
  Covered by an explicit settings-sync unit test.
- No DB schema migration is required — both fields live in the existing `settings`
  table as JSON group values; the local last-fired key is additive. No data-DB
  migration, no reset.

## Error Handling

- Notifications unsupported → warn + skip (no throw).
- DB/count error inside a tick → caught, logged, tick skipped; the interval survives.
- Missing/corrupt `inbox` settings → `readGroupSettings` returns defaults (feature OFF).
- Invalid `reviewReminderTime` → schema-validated on write; the UI uses a constrained
  time input; a malformed persisted value falls back to the default at read.

## Edge Case Matrix

| #   | Scenario                                                       | Behavior                                                   |
| --- | -------------------------------------------------------------- | ---------------------------------------------------------- |
| 1   | App closed at target, opened later same day, items present     | Catch up — notify once on first tick                       |
| 2   | Missed late-night target, app opened next day                  | No catch-up (same calendar day only)                       |
| 3   | Inbox empty at target, item added later same day               | Fires on the next tick after items exist (one nudge)       |
| 4   | 2+ devices open at target                                      | Each fires (per-device last-fired)                         |
| 5   | Time changed after already firing today                        | No refire today                                            |
| 6   | Time changed to an earlier, already-passed time, not yet fired | Fires on next tick                                         |
| 7   | Enabled after target already passed, items present             | Catch up on next tick                                      |
| 8   | Disabled                                                       | Never fires                                                |
| 9   | DST spring-forward across target                               | Target counts as passed → fires (catch-up)                 |
| 10  | Clock moved backward                                           | No double-fire (date guard); fires when target reached     |
| 11  | Timezone travel                                                | Wall-clock local time — "18:00" wherever you are           |
| 12  | No vault open                                                  | Scheduler idle; startup/resume catch-up when a vault opens |
| 13  | Vault switch                                                   | Reads active vault's inbox + its own last-fired            |
| 14  | OS notification permission denied                              | Silent OS no-op; cannot detect (noted)                     |
| 15  | Interval tick + resume tick in same minute                     | Idempotent via date guard                                  |
| 16  | Backward compat: old client sees `inbox` group                 | Must not clobber (unit-tested)                             |
| 17  | Inbox holds only viewed reminders                              | Count 0 → silent                                           |
| 18  | Inbox holds only snoozed items                                 | Count 0 → silent; recounts when snooze expires             |
| 19  | App runs across midnight                                       | Re-eligible at today's target after date rolls             |
| 20  | Laptop suspended past target, resumes same day                 | `resume` catch-up fires                                    |

## Testing Plan

**Unit (Vitest, main):**

- `decideReviewNotification` — table-driven over edges #1–#20 (inject `now`, no fake
  clock). The primary correctness surface.
- `countReviewableInboxItems` — seeded DB with unfiled / snoozed / viewed-reminder /
  filed rows → count equals the badge definition.
- `inbox` settings group — read/write round-trip, defaults, corruption recovery.
- settings-sync — `updateField('inbox.…')` local merge, remote merge LWW on concurrent
  edits, and old-client-preserve of the unknown group.
- Notification builder — title/body i18n and pluralization for count 1 vs N.

**E2E (Playwright / Electron):**

- Settings → Inbox: set time + enable; seed an inbox item; force a tick via a
  test-only IPC (avoid the 60s wait); assert a `REVIEW_DUE` event (thin observable
  seam, mirroring how reminders emit an in-app event) and the notification path.
- Empty inbox → no fire.
- Disabled → no fire.
- Once per day → after a fire, another forced tick same day does not refire.
- Persistence → set time, reload app, setting persists.
- Sync → set time on `dev:a`, assert it propagates to `dev:b`.

**Test seam:** the scheduler exposes `runReviewTick(nowOverride?)` and emits a
`REVIEW_DUE` event; the OS notification is a thin wrapper over that event, so tests
assert on the event without depending on real OS notification delivery.

## Rollout / Docs

- Desktop change → run the docs gate (`pnpm docs:ai-update --base <base>` or update
  `apps/docs/src` manually, then `pnpm docs:impact --base <base> --strict` and
  `pnpm docs:build`).
- After RPC edits: `pnpm ipc:generate` then `pnpm ipc:check`.
- Verify with `pnpm lint`, `pnpm typecheck`, `pnpm test:desktop`, `pnpm test:e2e`.
