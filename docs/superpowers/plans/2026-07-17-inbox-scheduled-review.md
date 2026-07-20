# Scheduled Review — Daily Inbox Reminder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An optional daily reminder that fires a desktop notification at a user-set local time when the inbox has items to review, configured from Settings → Inbox, with the schedule synced across devices.

**Architecture:** Two synced preference fields (`reviewReminderEnabled`, `reviewReminderTime`) live in the local `inbox` settings group and ride the existing `synced_settings` per-field-vector-clock transport. A main-process scheduler (60s tick + startup + power-resume catch-up) reads them, counts reviewable inbox items (main-side mirror of the sidebar badge), and — via a pure `decideReviewNotification` core — fires one OS notification per device per day. The last-fired date is device-local and unsynced.

**Tech Stack:** Electron (main + preload + React renderer), better-sqlite3 + Drizzle, Zod contracts, generated RPC (`packages/rpc`), Vitest (unit), Playwright/Electron (E2E), i18next.

## Global Constraints

- **Backward compatibility MANDATORY** — no DB resets; no data-DB schema migration in this feature (both settings fields are JSON in the existing `settings` table; last-fired is an additive dotted key). Old clients must not clobber the new synced `inbox` group.
- **Logging** — always `createLogger('Scope')`; never `console.*`.
- **User-facing errors** — always `extractErrorMessage(err, fallback)` from `@/lib/ipc-error`.
- **IPC boundary** — after editing contracts/channels/RPC/preload/handlers, run `pnpm ipc:generate` **then** `pnpm ipc:check`.
- **RTL safety** — new renderer JSX uses logical Tailwind classes (`ms-*`/`me-*`/`ps-*`/`pe-*`/`start-*`/`end-*`/`text-start`), never physical.
- **Local date** — day identity uses local `getFullYear/getMonth/getDate`, never `toISOString()` (UTC).
- **i18n** — English keys gate `i18n:check`; add keys to the English locale files.
- **Git** — no `Co-Authored-By` trailer in commits. Branch is `inbox-review-reminder`.
- **Naming (verbatim):** settings group key `inbox`; synced field paths `inbox.reviewReminderEnabled`, `inbox.reviewReminderTime`; local last-fired settings key `inbox.reviewLastNotifiedDate`; default time `18:00`; default enabled `false`.

---

## File Structure

**Contracts / RPC**

- `packages/contracts/src/settings-schemas.ts` — add `InboxSettingsSchema`, `INBOX_SETTINGS_DEFAULTS`, `InboxSettings`.
- `packages/contracts/src/settings-sync.ts` — add optional `inbox` group to `SyncedSettingsSchema`.
- `packages/contracts/src/ipc-channels.ts` — add `GET_INBOX_SETTINGS`/`SET_INBOX_SETTINGS` (SettingsChannels.invoke); add `REVIEW_DUE`/`REVIEW_OPEN` (InboxChannels.events).
- `packages/rpc/src/settings.ts` — add `getInboxSettings`/`setInboxSettings` methods.

**Main**

- `apps/desktop/src/main/inbox/stats.ts` — add `countReviewableInboxItems()`.
- `apps/desktop/src/main/inbox/review-scheduler.ts` — **new.** `decideReviewNotification` (pure), `runReviewTick`, start/stop, notification, event emit.
- `apps/desktop/src/main/ipc/settings-handlers.ts` — add GET/SET handlers, export `getInboxReviewSettings()`, push synced fields, cleanup.
- `apps/desktop/src/main/sync/item-handlers/settings-handler.ts` — propagate + broadcast the `inbox` group.
- `apps/desktop/src/main/index.ts` — start (~L1308) / stop (~L1625) wiring.
- `apps/desktop/src/main/test-hooks.ts` — `forceInboxReviewTickForE2E`, `seedInboxItemForE2E`.

**Preload**

- `apps/desktop/src/preload/api/inbox.ts` (+ `index.d.ts`) — `onInboxReviewDue`, `onInboxReviewOpen`.

**Renderer**

- `apps/desktop/src/renderer/src/hooks/use-inbox-preferences.ts` — **new.**
- `apps/desktop/src/renderer/src/pages/settings/inbox-section.tsx` — **new.**
- `apps/desktop/src/renderer/src/pages/settings.tsx` — nav item + section render + import.
- `apps/desktop/src/renderer/src/contexts/settings-modal-context.tsx` — add `'inbox'` to `SettingsSection`.
- `apps/desktop/src/renderer/src/hooks/use-inbox-review-notifications.ts` — **new**; wired where `use-reminder-notifications` is used.

**i18n**

- `packages/i18n/src/locales/en/settings.json`, `.../system.json`, `.../inbox.json`.

**Docs**

- `apps/docs/src/**` via `pnpm docs:ai-update` (or manual).

---

## Task 1: Contract — inbox settings schema + synced group

**Files:**

- Modify: `packages/contracts/src/settings-schemas.ts` (after the Backup block, ~L256)
- Modify: `packages/contracts/src/settings-sync.ts:34-57` (SyncedSettingsSchema)
- Test: `packages/contracts/src/settings-schemas.test.ts` (create if absent)

**Interfaces:**

- Produces: `InboxSettingsSchema`, `INBOX_SETTINGS_DEFAULTS: InboxSettings`, `type InboxSettings = { reviewReminderEnabled: boolean; reviewReminderTime: string }`. Synced group `inbox?: { reviewReminderEnabled?: boolean; reviewReminderTime?: string }`.

- [ ] **Step 1: Write the failing test**

Create `packages/contracts/src/settings-schemas.test.ts` (or append):

```ts
import { describe, it, expect } from 'vitest'
import { InboxSettingsSchema, INBOX_SETTINGS_DEFAULTS } from './settings-schemas'

describe('InboxSettings', () => {
  it('defaults to disabled at 18:00', () => {
    expect(INBOX_SETTINGS_DEFAULTS).toEqual({
      reviewReminderEnabled: false,
      reviewReminderTime: '18:00'
    })
  })

  it('accepts a valid HH:MM time', () => {
    const parsed = InboxSettingsSchema.parse({
      reviewReminderEnabled: true,
      reviewReminderTime: '06:30'
    })
    expect(parsed.reviewReminderTime).toBe('06:30')
  })

  it('rejects a non-HH:MM time', () => {
    expect(() =>
      InboxSettingsSchema.parse({ reviewReminderEnabled: true, reviewReminderTime: '6pm' })
    ).toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/contracts test -- settings-schemas`
Expected: FAIL — `InboxSettingsSchema` is not exported.

- [ ] **Step 3: Implement the schema**

In `packages/contracts/src/settings-schemas.ts`, add after the Backup Settings block (~L256):

```ts
// ============================================================================
// Inbox Settings (daily review reminder)
// ============================================================================

export const InboxSettingsSchema = z.object({
  // Optional daily reminder to process the inbox in one calm pass.
  reviewReminderEnabled: z.boolean(),
  // Local wall-clock time, 24h "HH:MM".
  reviewReminderTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
})

export type InboxSettings = z.infer<typeof InboxSettingsSchema>

export const INBOX_SETTINGS_DEFAULTS: InboxSettings = {
  reviewReminderEnabled: false,
  reviewReminderTime: '18:00'
}
```

In `packages/contracts/src/settings-sync.ts`, add an `inbox` group inside `SyncedSettingsSchema` (after the `sync` group, before the closing `})` at L57):

```ts
  ,
  inbox: z
    .object({
      reviewReminderEnabled: z.boolean().optional(),
      reviewReminderTime: z.string().optional()
    })
    .optional()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/contracts test -- settings-schemas`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/settings-schemas.ts packages/contracts/src/settings-sync.ts packages/contracts/src/settings-schemas.test.ts
git commit -m "feat(contracts): inbox review-reminder settings schema + synced group"
```

---

## Task 2: Channels + RPC methods + preload regen

**Files:**

- Modify: `packages/contracts/src/ipc-channels.ts` (SettingsChannels.invoke ~L437; InboxChannels.events — `packages/contracts/src/inbox-channels.ts:131-151`)
- Modify: `packages/rpc/src/settings.ts` (methods ~after L306; imports L1-12)
- Verify: `pnpm ipc:generate` + `pnpm ipc:check`

**Interfaces:**

- Produces: `SettingsChannels.invoke.GET_INBOX_SETTINGS = 'settings:getInboxSettings'`, `SET_INBOX_SETTINGS = 'settings:setInboxSettings'`; `InboxChannels.events.REVIEW_DUE = 'inbox:review-due'`, `REVIEW_OPEN = 'inbox:review-open'`; `window.api.settings.getInboxSettings(): Promise<InboxSettings>`, `setInboxSettings(updates: Partial<InboxSettings>): Promise<{success; error?}>`.

- [ ] **Step 1: Add channel constants**

In `packages/contracts/src/ipc-channels.ts`, inside `SettingsChannels.invoke` (after `SET_FEATURES_SETTINGS`, ~L415):

```ts
    /** Get inbox settings (daily review reminder) */
    GET_INBOX_SETTINGS: 'settings:getInboxSettings',
    /** Update inbox settings (partial merge) */
    SET_INBOX_SETTINGS: 'settings:setInboxSettings',
```

In `packages/contracts/src/inbox-channels.ts`, inside the `events` object (~L131-151, alongside `SNOOZE_DUE`/`OPEN_ITEM`):

```ts
    /** Daily review reminder fired (payload: { count }) */
    REVIEW_DUE: 'inbox:review-due',
    /** User clicked the review notification — open the inbox */
    REVIEW_OPEN: 'inbox:review-open',
```

- [ ] **Step 2: Add RPC methods**

In `packages/rpc/src/settings.ts`, add `InboxSettings` to the type import (L1-12):

```ts
import type {
  BackupSettings,
  CalendarGoogleSettings,
  CalendarSettings,
  EditorSettings,
  FeaturesSettings,
  GeneralSettings,
  InboxSettings,
  KeyboardShortcuts,
  SyncSettings,
  TaskSettings,
  VoiceTranscriptionSettings
} from '../../contracts/src/settings-schemas.ts'
```

Add these two methods inside `methods` (after `setFeaturesSettings`, ~L306):

```ts
    getInboxSettings: defineMethod<() => Promise<InboxSettings>>({
      channel: SettingsChannels.invoke.GET_INBOX_SETTINGS
    }),
    setInboxSettings: defineMethod<(settings: Partial<InboxSettings>) => SuccessResponse>({
      channel: SettingsChannels.invoke.SET_INBOX_SETTINGS,
      params: ['settings']
    }),
```

- [ ] **Step 3: Regenerate + verify the IPC contract**

Run: `pnpm ipc:generate && pnpm ipc:check`
Expected: exits 0; `apps/desktop/src/preload/generated-rpc.ts` and `index.d.ts` now include `getInboxSettings`/`setInboxSettings`.

- [ ] **Step 4: Typecheck the contract packages**

Run: `pnpm --filter @memry/contracts typecheck && pnpm --filter @memry/rpc typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/ipc-channels.ts packages/contracts/src/inbox-channels.ts packages/rpc/src/settings.ts apps/desktop/src/preload/generated-rpc.ts apps/desktop/src/preload/index.d.ts
git commit -m "feat(ipc): inbox settings channels + review-due/open events"
```

---

## Task 3: Reviewable inbox count (main-side badge mirror)

**Files:**

- Modify: `apps/desktop/src/main/inbox/stats.ts` (imports L13; add fn after `countStaleItems`, ~L134)
- Test: `apps/desktop/src/main/inbox/stats.test.ts` (create if absent; mirror existing main DB-test setup)

**Interfaces:**

- Produces: `countReviewableInboxItems(): number` — unfiled AND not-snoozed AND not-archived, excluding reminders that have `viewedAt` (equals the sidebar badge at `app-sidebar.tsx:156`).

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/main/inbox/stats.test.ts` (use the repo's in-memory data-DB test helper; check a sibling main test such as `apps/desktop/src/main/inbox/*.test.ts` for the exact `getDatabase` mock/seed helper and reuse it):

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { inboxItems, inboxItemType } from '@memry/db-schema/schema/inbox'
import { getDatabase } from '../database'
import { countReviewableInboxItems } from './stats'

// Assumes the shared main test harness provides an initialized in-memory data DB
// via getDatabase(). See existing main *.test.ts for the setup import to copy.

function seed(row: Partial<typeof inboxItems.$inferInsert> & { id: string }) {
  getDatabase()
    .insert(inboxItems)
    .values({
      type: inboxItemType.NOTE,
      title: row.id,
      createdAt: '2026-01-01T00:00:00.000Z',
      modifiedAt: '2026-01-01T00:00:00.000Z',
      ...row
    })
    .run()
}

describe('countReviewableInboxItems', () => {
  beforeEach(() => {
    getDatabase().delete(inboxItems).run()
  })

  it('counts an unfiled item', () => {
    seed({ id: 'a' })
    expect(countReviewableInboxItems()).toBe(1)
  })

  it('excludes filed, archived, and snoozed items', () => {
    seed({ id: 'filed', filedAt: '2026-01-02T00:00:00.000Z' })
    seed({ id: 'archived', archivedAt: '2026-01-02T00:00:00.000Z' })
    seed({ id: 'snoozed', snoozedUntil: '2099-01-01T00:00:00.000Z' })
    expect(countReviewableInboxItems()).toBe(0)
  })

  it('excludes viewed reminders but counts unviewed reminders', () => {
    seed({ id: 'viewed-rem', type: inboxItemType.REMINDER, viewedAt: '2026-01-02T00:00:00.000Z' })
    seed({ id: 'unviewed-rem', type: inboxItemType.REMINDER })
    expect(countReviewableInboxItems()).toBe(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:main -- inbox/stats`
Expected: FAIL — `countReviewableInboxItems` is not exported.

- [ ] **Step 3: Implement the count**

In `apps/desktop/src/main/inbox/stats.ts`, extend the drizzle import (L13) to add `ne` and `or`:

```ts
import { eq, and, isNull, sql, lt, gte, desc, asc, ne, or } from 'drizzle-orm'
```

Add after `countStaleItems` (~L134):

```ts
/**
 * Count inbox items eligible for the daily review nudge.
 * Mirrors the sidebar badge (app-sidebar.tsx): unfiled, not snoozed, not
 * archived, and excluding reminders that have already been viewed.
 */
export function countReviewableInboxItems(): number {
  try {
    const db = getDatabase()
    const result = db
      .select({ count: sql<number>`count(*)` })
      .from(inboxItems)
      .where(
        and(
          isNull(inboxItems.filedAt),
          isNull(inboxItems.snoozedUntil),
          isNull(inboxItems.archivedAt),
          or(ne(inboxItems.type, inboxItemType.REMINDER), isNull(inboxItems.viewedAt))
        )
      )
      .get()

    return result?.count || 0
  } catch {
    return 0
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop test:main -- inbox/stats`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/inbox/stats.ts apps/desktop/src/main/inbox/stats.test.ts
git commit -m "feat(inbox): count reviewable items for review nudge"
```

---

## Task 4: Pure notification decision core

**Files:**

- Create: `apps/desktop/src/main/inbox/review-scheduler.ts` (decision core only in this task)
- Test: `apps/desktop/src/main/inbox/review-scheduler.decide.test.ts`

**Interfaces:**

- Produces:

  ```ts
  decideReviewNotification(input: {
    enabled: boolean
    target: string            // "HH:MM"
    now: Date                 // local
    lastNotifiedDate: string | null   // local "YYYY-MM-DD"
    inboxCount: number
  }): { notify: boolean; nextLastNotifiedDate: string | null }
  ```

  Also exports helpers `localDateString(d: Date): string` and `parseTargetMinutes(target: string): number | null`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/main/inbox/review-scheduler.decide.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { decideReviewNotification, localDateString } from './review-scheduler'

// Local Date built from local Y/M/D h:m — no UTC parsing.
const at = (y: number, mo: number, d: number, h: number, mi: number) =>
  new Date(y, mo - 1, d, h, mi, 0, 0)

const base = {
  enabled: true,
  target: '18:00',
  now: at(2026, 7, 17, 18, 0),
  lastNotifiedDate: null as string | null,
  inboxCount: 3
}

describe('decideReviewNotification', () => {
  it('fires exactly at target when eligible', () => {
    const r = decideReviewNotification(base)
    expect(r.notify).toBe(true)
    expect(r.nextLastNotifiedDate).toBe('2026-07-17')
  })

  it('catches up when opened after target same day (#1)', () => {
    const r = decideReviewNotification({ ...base, now: at(2026, 7, 17, 21, 0) })
    expect(r.notify).toBe(true)
  })

  it('does not fire before target (#exact-time)', () => {
    const r = decideReviewNotification({ ...base, now: at(2026, 7, 17, 17, 59) })
    expect(r.notify).toBe(false)
    expect(r.nextLastNotifiedDate).toBeNull()
  })

  it('does not catch up across midnight for a late-night target (#2)', () => {
    const r = decideReviewNotification({
      ...base,
      target: '23:00',
      now: at(2026, 7, 18, 8, 0)
    })
    expect(r.notify).toBe(false)
  })

  it('is silent when already fired today (#5, once/day)', () => {
    const r = decideReviewNotification({ ...base, lastNotifiedDate: '2026-07-17' })
    expect(r.notify).toBe(false)
    expect(r.nextLastNotifiedDate).toBe('2026-07-17')
  })

  it('fires next tick when items appear after target (#3)', () => {
    const r = decideReviewNotification({
      ...base,
      now: at(2026, 7, 17, 19, 3),
      lastNotifiedDate: null,
      inboxCount: 2
    })
    expect(r.notify).toBe(true)
  })

  it('fires for an earlier already-passed time not yet fired (#6)', () => {
    const r = decideReviewNotification({
      ...base,
      target: '16:00',
      now: at(2026, 7, 17, 17, 0)
    })
    expect(r.notify).toBe(true)
  })

  it('is silent when disabled (#8)', () => {
    expect(decideReviewNotification({ ...base, enabled: false }).notify).toBe(false)
  })

  it('is silent when inbox is empty (#17/#18)', () => {
    expect(decideReviewNotification({ ...base, inboxCount: 0 }).notify).toBe(false)
  })

  it('is silent for an invalid target', () => {
    expect(decideReviewNotification({ ...base, target: '6pm' }).notify).toBe(false)
  })

  it('re-eligible the next day (#19)', () => {
    const r = decideReviewNotification({
      ...base,
      now: at(2026, 7, 18, 18, 0),
      lastNotifiedDate: '2026-07-17'
    })
    expect(r.notify).toBe(true)
    expect(r.nextLastNotifiedDate).toBe('2026-07-18')
  })

  it('localDateString uses local Y/M/D (not UTC)', () => {
    expect(localDateString(at(2026, 7, 17, 23, 30))).toBe('2026-07-17')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:main -- review-scheduler.decide`
Expected: FAIL — module/exports missing.

- [ ] **Step 3: Implement the decision core**

Create `apps/desktop/src/main/inbox/review-scheduler.ts`:

```ts
/**
 * Inbox Review Scheduler
 *
 * Fires an optional daily desktop notification nudging the user to process
 * the inbox, at a user-set local time, when there are reviewable items.
 *
 * @module main/inbox/review-scheduler
 */

export interface ReviewDecisionInput {
  enabled: boolean
  target: string
  now: Date
  lastNotifiedDate: string | null
  inboxCount: number
}

export interface ReviewDecision {
  notify: boolean
  nextLastNotifiedDate: string | null
}

/** Local calendar day as YYYY-MM-DD (NOT UTC). */
export function localDateString(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Parse "HH:MM" (24h) to minutes-of-day, or null if malformed. */
export function parseTargetMinutes(target: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(target)
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

/**
 * Pure decision: should the review notification fire on this tick?
 * Idempotent via the local-day guard, so interval + resume ticks can't double-fire.
 */
export function decideReviewNotification(input: ReviewDecisionInput): ReviewDecision {
  const { enabled, target, now, lastNotifiedDate, inboxCount } = input
  const noFire: ReviewDecision = { notify: false, nextLastNotifiedDate: lastNotifiedDate }

  if (!enabled || inboxCount <= 0) return noFire

  const targetMinutes = parseTargetMinutes(target)
  if (targetMinutes === null) return noFire

  const today = localDateString(now)
  if (lastNotifiedDate === today) return noFire

  const nowMinutes = now.getHours() * 60 + now.getMinutes()
  if (nowMinutes < targetMinutes) return noFire

  return { notify: true, nextLastNotifiedDate: today }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop test:main -- review-scheduler.decide`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/inbox/review-scheduler.ts apps/desktop/src/main/inbox/review-scheduler.decide.test.ts
git commit -m "feat(inbox): pure review-notification decision core"
```

---

## Task 5: Settings handlers — GET/SET inbox + synced-field push + reader export

**Files:**

- Modify: `apps/desktop/src/main/ipc/settings-handlers.ts` (imports; handlers after Features ~L860; cleanup ~L1022; export a reader)
- Test: `apps/desktop/src/main/ipc/settings-handlers.inbox.test.ts`

**Interfaces:**

- Consumes: `readGroupSettings`/`writeGroupSettings` (private, in-file), `INBOX_SETTINGS_DEFAULTS` (Task 1), `syncSettingsFieldUpdate` (`sync/local-mutations.ts:325`).
- Produces: IPC handlers for `GET_INBOX_SETTINGS`/`SET_INBOX_SETTINGS`; exported `getInboxReviewSettings(): InboxSettings` for the scheduler.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/main/ipc/settings-handlers.inbox.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const updateField = vi.fn()
vi.mock('../sync/local-mutations', () => ({
  syncSettingsFieldUpdate: (path: string, value: unknown) => updateField(path, value)
}))

import { getSetting } from '../database/queries/settings'
import { getDatabase } from '../database'
import { getInboxReviewSettings, writeInboxReviewSettings } from './settings-handlers'

// writeInboxReviewSettings is the shared SET path (writeGroupSettings('inbox', ...)
// + sync-field push) the IPC handler delegates to, so this unit test avoids
// ipcMain plumbing.
// (If the harness prefers exercising the ipcMain handler directly, register
// handlers and invoke the channel instead — same assertions.)

describe('inbox settings handler', () => {
  beforeEach(() => {
    updateField.mockClear()
    getDatabase().delete(/* settings */ undefined as never) // replace with settings table delete per harness
  })

  it('round-trips and defaults', () => {
    expect(getInboxReviewSettings()).toEqual({
      reviewReminderEnabled: false,
      reviewReminderTime: '18:00'
    })
  })

  it('persists updates and pushes changed fields to sync', () => {
    writeInboxReviewSettings({ reviewReminderEnabled: true, reviewReminderTime: '06:30' })
    expect(getInboxReviewSettings()).toEqual({
      reviewReminderEnabled: true,
      reviewReminderTime: '06:30'
    })
    expect(getSetting(getDatabase(), 'inbox')).toContain('06:30')
    expect(updateField).toHaveBeenCalledWith('inbox.reviewReminderEnabled', true)
    expect(updateField).toHaveBeenCalledWith('inbox.reviewReminderTime', '06:30')
  })

  it('only pushes the fields present in the update', () => {
    writeInboxReviewSettings({ reviewReminderTime: '09:00' })
    expect(updateField).toHaveBeenCalledWith('inbox.reviewReminderTime', '09:00')
    expect(updateField).not.toHaveBeenCalledWith('inbox.reviewReminderEnabled', expect.anything())
  })
})
```

> Note for the implementer: replace the `beforeEach` settings-table reset with the harness's standard reset (see how sibling main tests clear the `settings` table). The point of the test is the three assertions.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:main -- settings-handlers.inbox`
Expected: FAIL — `getInboxReviewSettings` / `writeInboxReviewSettings` not exported.

- [ ] **Step 3: Implement handlers + reader**

In `apps/desktop/src/main/ipc/settings-handlers.ts`:

Add to the contracts import group (where `TASK_SETTINGS_DEFAULTS` etc. are imported):

```ts
import { INBOX_SETTINGS_DEFAULTS, type InboxSettings } from '@memry/contracts/settings-schemas'
```

Add near the other imports:

```ts
import { syncSettingsFieldUpdate } from '../sync/local-mutations'
```

Export a reader for the scheduler (next to `getCalendarSettings`, ~L213):

```ts
/** Synchronous read of inbox review settings for the scheduler (non-IPC caller). */
export function getInboxReviewSettings(): InboxSettings {
  return readGroupSettings('inbox', INBOX_SETTINGS_DEFAULTS)
}

/** Write inbox settings + push changed fields to sync. Test seam + used by the SET handler. */
export function writeInboxReviewSettings(updates: Partial<InboxSettings>): {
  success: boolean
  error?: string
} {
  const result = writeGroupSettings('inbox', INBOX_SETTINGS_DEFAULTS, updates)
  if (result.success) {
    if ('reviewReminderEnabled' in updates) {
      syncSettingsFieldUpdate('inbox.reviewReminderEnabled', updates.reviewReminderEnabled)
    }
    if ('reviewReminderTime' in updates) {
      syncSettingsFieldUpdate('inbox.reviewReminderTime', updates.reviewReminderTime)
    }
  }
  return result
}
```

Register the IPC handlers inside `registerSettingsHandlers()`, after the Features handlers (~L860):

```ts
ipcMain.handle(SettingsChannels.invoke.GET_INBOX_SETTINGS, () =>
  readGroupSettings('inbox', INBOX_SETTINGS_DEFAULTS)
)
ipcMain.handle(
  SettingsChannels.invoke.SET_INBOX_SETTINGS,
  (_event, updates: Partial<InboxSettings>) => writeInboxReviewSettings(updates)
)
```

Add cleanup removers where the other `removeHandler` calls live (~L1022):

```ts
ipcMain.removeHandler(SettingsChannels.invoke.GET_INBOX_SETTINGS)
ipcMain.removeHandler(SettingsChannels.invoke.SET_INBOX_SETTINGS)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop test:main -- settings-handlers.inbox`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/ipc/settings-handlers.ts apps/desktop/src/main/ipc/settings-handlers.inbox.test.ts
git commit -m "feat(settings): inbox review settings get/set + sync-field push"
```

---

## Task 6: Sync propagation + backward-compat regression

**Files:**

- Modify: `apps/desktop/src/main/sync/item-handlers/settings-handler.ts` (imports L12-13; `propagateMergedSettings` ~L88; `broadcastSettingsChanged` ~L126)
- Test: `apps/desktop/src/main/sync/settings-sync.inbox.test.ts`

**Interfaces:**

- Consumes: `getSettingsSyncManager()` / `mergeRemote` (Task's context), `getSetting`/`setSetting`.
- Produces: on remote settings merge, the merged `inbox` group is written to the local `inbox` settings group and broadcast as `settings:changed` with `key: 'inbox'`.

- [ ] **Step 1: Write the failing test (value-preservation regression + propagation)**

Create `apps/desktop/src/main/sync/settings-sync.inbox.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { getDatabase } from '../../database'
import { settings } from '@memry/db-schema/schema/settings'
import { initSettingsSyncManager, resetSettingsSyncManager } from './settings-sync'
import { SyncQueueManager } from './queue'

describe('settings sync — inbox group', () => {
  beforeEach(() => {
    getDatabase().delete(settings).run()
    resetSettingsSyncManager()
  })

  it('merges a remote inbox time change (new client → new client)', () => {
    const mgr = initSettingsSyncManager({
      db: getDatabase() as never,
      queue: new SyncQueueManager(getDatabase() as never),
      getDeviceId: () => 'B'
    })
    mgr.mergeRemote({
      settings: { inbox: { reviewReminderTime: '07:00', reviewReminderEnabled: true } },
      fieldClocks: {
        'inbox.reviewReminderTime': { A: 1 },
        'inbox.reviewReminderEnabled': { A: 1 }
      }
    })
    expect(mgr.getSettings().inbox?.reviewReminderTime).toBe('07:00')
  })

  it('does NOT clobber a local inbox value when an old client omits it (#16)', () => {
    const mgr = initSettingsSyncManager({
      db: getDatabase() as never,
      queue: new SyncQueueManager(getDatabase() as never),
      getDeviceId: () => 'B'
    })
    // Local device set its own time.
    mgr.updateField('inbox.reviewReminderTime', '06:30', 'B')
    // Old client re-emits: has the clock, but its schema stripped the value.
    mgr.mergeRemote({
      settings: {},
      fieldClocks: { 'inbox.reviewReminderTime': { B: 1 } }
    })
    expect(mgr.getSettings().inbox?.reviewReminderTime).toBe('06:30')
  })
})
```

> Note: match the exact `SyncQueueManager` constructor + `initSettingsSyncManager` deps to the current signatures (see `settings-sync.ts:23-34` and the queue module). Adjust the harness reset to the standard settings-table clear.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:main -- settings-sync.inbox`
Expected: the propagation test may pass (merge already generic), but this task's **implementation** (write-back + broadcast) is verified in Step 4 with the propagate assertions; run to establish the baseline first.

- [ ] **Step 3: Implement propagation + broadcast**

In `apps/desktop/src/main/sync/item-handlers/settings-handler.ts`, extend the imports (L12-13):

```ts
import { getDatabase } from '../../database'
import { getSetting, setSetting } from '../../database/queries/settings'
```

In `propagateMergedSettings`, after the `editor` write-back block (~L86, before `if (Object.keys(prefsUpdate).length > 0)`), add an inbox write-back to the local group (inside the `if (vaultPath)` try):

```ts
if (merged.inbox) {
  try {
    const db = getDatabase()
    const raw = getSetting(db, 'inbox')
    const current = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
    setSetting(db, 'inbox', JSON.stringify({ ...current, ...merged.inbox }))
  } catch (err) {
    log.warn('Failed to propagate merged inbox settings:', err)
  }
}
```

In `broadcastSettingsChanged`, after the `editor` block (~L133), add:

```ts
if (merged.inbox) {
  for (const win of windows) {
    win.webContents.send(SettingsChannels.events.CHANGED, {
      key: 'inbox',
      value: merged.inbox
    })
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop test:main -- settings-sync.inbox`
Expected: PASS (2 tests), including the backward-compat regression.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/sync/item-handlers/settings-handler.ts apps/desktop/src/main/sync/settings-sync.inbox.test.ts
git commit -m "feat(sync): propagate + broadcast merged inbox review settings"
```

---

## Task 7: Scheduler runtime — tick, notification, event, start/stop

**Files:**

- Modify: `apps/desktop/src/main/inbox/review-scheduler.ts` (add runtime below the decision core)
- Test: `apps/desktop/src/main/inbox/review-scheduler.tick.test.ts`

**Interfaces:**

- Consumes: `getStatus` (`../vault`), `getInboxReviewSettings` (Task 5), `countReviewableInboxItems` (Task 3), `decideReviewNotification` (Task 4), `getSetting`/`setSetting`, Electron `Notification`/`BrowserWindow`/`powerMonitor`, `getMainI18n`, `InboxChannels`.
- Produces: `runReviewTick(now?: Date): { notified: boolean; count: number }`, `startInboxReviewScheduler()`, `stopInboxReviewScheduler()`, `isReviewSchedulerRunning(): boolean`, `getLastReviewFireForTest(): { date: string; count: number } | null`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/main/inbox/review-scheduler.tick.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const show = vi.fn()
const send = vi.fn()
vi.mock('electron', () => ({
  Notification: Object.assign(
    vi.fn().mockImplementation(() => ({ on: vi.fn(), show })),
    { isSupported: () => true }
  ),
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send } }] },
  powerMonitor: { on: vi.fn(), removeListener: vi.fn() }
}))
vi.mock('../vault', () => ({ getStatus: () => ({ isOpen: true }) }))
vi.mock('../lib/main-i18n', () => ({
  getMainI18n: () => ({
    getFixedT: () => (k: string, o?: { count?: number }) => `${k}:${o?.count ?? ''}`
  })
}))

let enabled = true
let time = '18:00'
let count = 3
vi.mock('../ipc/settings-handlers', () => ({
  getInboxReviewSettings: () => ({ reviewReminderEnabled: enabled, reviewReminderTime: time })
}))
vi.mock('./stats', () => ({ countReviewableInboxItems: () => count }))

const store = new Map<string, string>()
vi.mock('../database', () => ({ getDatabase: () => ({}) }))
vi.mock('../database/queries/settings', () => ({
  getSetting: (_db: unknown, k: string) => store.get(k) ?? null,
  setSetting: (_db: unknown, k: string, v: string) => void store.set(k, v)
}))

import { runReviewTick, getLastReviewFireForTest } from './review-scheduler'

const at = (h: number, mi: number) => new Date(2026, 6, 17, h, mi, 0, 0)

describe('runReviewTick', () => {
  beforeEach(() => {
    show.mockClear()
    send.mockClear()
    store.clear()
    enabled = true
    time = '18:00'
    count = 3
  })

  it('notifies once and persists the local date', () => {
    const r = runReviewTick(at(18, 0))
    expect(r).toEqual({ notified: true, count: 3 })
    expect(show).toHaveBeenCalledTimes(1)
    expect(store.get('inbox.reviewLastNotifiedDate')).toBe('2026-07-17')
    expect(getLastReviewFireForTest()).toEqual({ date: '2026-07-17', count: 3 })
  })

  it('emits the REVIEW_DUE event with the count', () => {
    runReviewTick(at(18, 0))
    expect(send).toHaveBeenCalledWith('inbox:review-due', { count: 3 })
  })

  it('is idempotent on a second tick the same day', () => {
    runReviewTick(at(18, 0))
    show.mockClear()
    const r = runReviewTick(at(18, 30))
    expect(r.notified).toBe(false)
    expect(show).not.toHaveBeenCalled()
  })

  it('does not notify when disabled', () => {
    enabled = false
    expect(runReviewTick(at(18, 0)).notified).toBe(false)
  })

  it('does not notify with an empty inbox', () => {
    count = 0
    expect(runReviewTick(at(18, 0)).notified).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:main -- review-scheduler.tick`
Expected: FAIL — `runReviewTick` not exported.

- [ ] **Step 3: Implement the runtime**

Append to `apps/desktop/src/main/inbox/review-scheduler.ts`:

```ts
import { BrowserWindow, Notification, powerMonitor } from 'electron'
import { getStatus } from '../vault'
import { getDatabase } from '../database'
import { getSetting, setSetting } from '../database/queries/settings'
import { getInboxReviewSettings } from '../ipc/settings-handlers'
import { countReviewableInboxItems } from './stats'
import { getMainI18n } from '../lib/main-i18n'
import { InboxChannels } from '@memry/contracts/inbox-channels'
import { createLogger } from '../lib/logger'

const logger = createLogger('InboxReview')
const SCHEDULER_INTERVAL_MS = 60 * 1000
const LAST_NOTIFIED_KEY = 'inbox.reviewLastNotifiedDate'

let schedulerInterval: ReturnType<typeof setInterval> | null = null
let resumeHandler: (() => void) | null = null
let lastFire: { date: string; count: number } | null = null

function readLastNotifiedDate(): string | null {
  try {
    return getSetting(getDatabase(), LAST_NOTIFIED_KEY)
  } catch {
    return null
  }
}

function writeLastNotifiedDate(date: string): void {
  try {
    setSetting(getDatabase(), LAST_NOTIFIED_KEY, date)
  } catch (err) {
    logger.warn('Failed to persist last-notified date:', err)
  }
}

function emitReviewDue(count: number): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(InboxChannels.events.REVIEW_DUE, { count })
  }
}

function showReviewNotification(count: number): void {
  if (!Notification.isSupported()) {
    logger.warn('Desktop notifications not supported')
    return
  }
  const t = getMainI18n().getFixedT(null, 'system')
  try {
    const notification = new Notification({
      title: t('notification.inboxReview.title'),
      body: t('notification.inboxReview.body', { count }),
      silent: false
    })
    notification.on('click', () => {
      const windows = BrowserWindow.getAllWindows()
      if (windows.length > 0) {
        const win = windows[0]
        if (win.isMinimized()) win.restore()
        win.focus()
        win.webContents.send(InboxChannels.events.REVIEW_OPEN, {})
      }
    })
    notification.show()
  } catch (err) {
    logger.error('Failed to show review notification:', err)
  }
}

/** Run one scheduler tick. Exposed for the interval, startup, resume, and E2E. */
export function runReviewTick(now: Date = new Date()): { notified: boolean; count: number } {
  if (!getStatus().isOpen) return { notified: false, count: 0 }

  const settings = getInboxReviewSettings()
  const inboxCount = countReviewableInboxItems()

  const decision = decideReviewNotification({
    enabled: settings.reviewReminderEnabled,
    target: settings.reviewReminderTime,
    now,
    lastNotifiedDate: readLastNotifiedDate(),
    inboxCount
  })

  if (!decision.notify || decision.nextLastNotifiedDate === null) {
    return { notified: false, count: inboxCount }
  }

  showReviewNotification(inboxCount)
  emitReviewDue(inboxCount)
  writeLastNotifiedDate(decision.nextLastNotifiedDate)
  lastFire = { date: decision.nextLastNotifiedDate, count: inboxCount }
  logger.info(`Review nudge fired for ${inboxCount} item(s)`)
  return { notified: true, count: inboxCount }
}

function safeTick(): void {
  try {
    runReviewTick()
  } catch (err) {
    logger.error('Review tick failed:', err)
  }
}

export function startInboxReviewScheduler(): void {
  if (schedulerInterval) {
    logger.warn('Review scheduler already running')
    return
  }
  safeTick() // startup catch-up
  schedulerInterval = setInterval(safeTick, SCHEDULER_INTERVAL_MS)
  resumeHandler = () => safeTick()
  powerMonitor.on('resume', resumeHandler)
}

export function stopInboxReviewScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval)
    schedulerInterval = null
  }
  if (resumeHandler) {
    powerMonitor.removeListener('resume', resumeHandler)
    resumeHandler = null
  }
}

export function isReviewSchedulerRunning(): boolean {
  return schedulerInterval !== null
}

export function getLastReviewFireForTest(): { date: string; count: number } | null {
  return lastFire
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop test:main -- review-scheduler.tick`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/inbox/review-scheduler.ts apps/desktop/src/main/inbox/review-scheduler.tick.test.ts
git commit -m "feat(inbox): review scheduler runtime — tick, notification, start/stop"
```

---

## Task 8: Lifecycle wiring in main

**Files:**

- Modify: `apps/desktop/src/main/index.ts` (import ~L41; start ~L1307-1316; stop ~L1624-1625)

**Interfaces:**

- Consumes: `startInboxReviewScheduler`/`stopInboxReviewScheduler` (Task 7).

- [ ] **Step 1: Add the import**

In `apps/desktop/src/main/index.ts`, after the reminders import (L41):

```ts
import { startInboxReviewScheduler, stopInboxReviewScheduler } from './inbox/review-scheduler'
```

- [ ] **Step 2: Wire startup (after the reminder-scheduler try/catch, ~L1316)**

Insert after the `startReminderScheduler()` try/catch block (before `void startGoogleCalendarSyncRunner()`):

```ts
try {
  startInboxReviewScheduler()
} catch (error) {
  mainLog.warn('inbox review scheduler failed to start:', error)
  trackMainLog('warn', {
    scope: 'Startup',
    action: 'inbox_review_scheduler_start_failed',
    errorCode: error instanceof Error ? error.name : 'UnknownError'
  })
}
```

- [ ] **Step 3: Wire shutdown (after `stopReminderScheduler()`, ~L1625)**

```ts
shutdownLog.info('stopping inbox review scheduler...')
stopInboxReviewScheduler()
```

- [ ] **Step 4: Typecheck main**

Run: `pnpm --filter @memry/desktop typecheck:node`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/index.ts
git commit -m "feat(main): start/stop inbox review scheduler in app lifecycle"
```

---

## Task 9: Preload — review event subscriptions

**Files:**

- Modify: `apps/desktop/src/preload/api/inbox.ts` (mirror `preload/api/reminders.ts:89-90`)
- Modify: `apps/desktop/src/preload/index.d.ts` (add method decls near `onReminderClicked`, ~L1849)
- Test: extend `apps/desktop/src/preload/api/preload-api.test.ts` (mirror the reminder subscribe test ~L959)

**Interfaces:**

- Produces: `window.api.onInboxReviewDue(cb: (e: { count: number }) => void): () => void`; `window.api.onInboxReviewOpen(cb: () => void): () => void`.

- [ ] **Step 1: Write the failing test**

In `apps/desktop/src/preload/api/preload-api.test.ts`, add (mirroring the existing reminder subscribe assertion):

```ts
it('onInboxReviewDue subscribes to the review-due channel', () => {
  const callback = vi.fn()
  assertSubscribes(() => inboxEvents.onInboxReviewDue(callback), InboxChannels.events.REVIEW_DUE)
})
```

> Use the same `assertSubscribes` helper / `inboxEvents` import shape the file already uses for reminders; if inbox events aren't imported there yet, import from `./inbox`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- preload-api`
Expected: FAIL — `onInboxReviewDue` undefined.

- [ ] **Step 3: Implement the subscriptions**

In `apps/desktop/src/preload/api/inbox.ts`, add to the exported API object (mirroring `reminders.ts`):

```ts
  onInboxReviewDue: (callback: (event: { count: number }) => void): (() => void) =>
    subscribe<{ count: number }>(InboxChannels.events.REVIEW_DUE, callback),
  onInboxReviewOpen: (callback: () => void): (() => void) =>
    subscribe<unknown>(InboxChannels.events.REVIEW_OPEN, () => callback()),
```

Ensure `InboxChannels` and `subscribe` are imported in that file (they are, for existing inbox events). In `apps/desktop/src/preload/index.d.ts`, add near `onReminderClicked` (~L1849):

```ts
  onInboxReviewDue: (callback: (event: { count: number }) => void) => () => void
  onInboxReviewOpen: (callback: () => void) => () => void
```

- [ ] **Step 4: Run test to verify it passes + ipc:check**

Run: `pnpm --filter @memry/desktop test:renderer -- preload-api && pnpm ipc:check`
Expected: PASS; ipc:check exits 0.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/preload/api/inbox.ts apps/desktop/src/preload/index.d.ts apps/desktop/src/preload/api/preload-api.test.ts
git commit -m "feat(preload): inbox review-due/open event subscriptions"
```

---

## Task 10: Renderer — inbox preferences hook

**Files:**

- Create: `apps/desktop/src/renderer/src/hooks/use-inbox-preferences.ts` (mirror `use-task-preferences.ts`)
- Test: `apps/desktop/src/renderer/src/hooks/use-inbox-preferences.test.tsx`

**Interfaces:**

- Consumes: `window.api.settings.getInboxSettings/setInboxSettings`, `window.api.onSettingsChanged`.
- Produces: `useInboxPreferences(): { settings: InboxSettingsDTO; isLoading; error; updateSettings(updates): Promise<boolean> }`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/renderer/src/hooks/use-inbox-preferences.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useInboxPreferences } from './use-inbox-preferences'

describe('useInboxPreferences', () => {
  beforeEach(() => {
    window.api = {
      settings: {
        getInboxSettings: vi.fn().mockResolvedValue({
          reviewReminderEnabled: true,
          reviewReminderTime: '18:00'
        }),
        setInboxSettings: vi.fn().mockResolvedValue({ success: true })
      },
      onSettingsChanged: vi.fn(() => () => {})
    } as never
  })

  it('loads settings', async () => {
    const { result } = renderHook(() => useInboxPreferences())
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.settings.reviewReminderTime).toBe('18:00')
  })

  it('updates optimistically on success', async () => {
    const { result } = renderHook(() => useInboxPreferences())
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    await act(async () => {
      await result.current.updateSettings({ reviewReminderTime: '06:30' })
    })
    expect(window.api.settings.setInboxSettings).toHaveBeenCalledWith({
      reviewReminderTime: '06:30'
    })
    expect(result.current.settings.reviewReminderTime).toBe('06:30')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- use-inbox-preferences`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the hook**

Create `apps/desktop/src/renderer/src/hooks/use-inbox-preferences.ts`:

```ts
import { useState, useEffect, useCallback } from 'react'
import { extractErrorMessage } from '@/lib/ipc-error'
import type { InboxSettingsDTO } from '../../../preload/index.d'
import { getI18n } from 'react-i18next'

const DEFAULTS: InboxSettingsDTO = {
  reviewReminderEnabled: false,
  reviewReminderTime: '18:00'
}

interface UseInboxPreferencesReturn {
  settings: InboxSettingsDTO
  isLoading: boolean
  error: string | null
  updateSettings: (updates: Partial<InboxSettingsDTO>) => Promise<boolean>
}

export function useInboxPreferences(): UseInboxPreferencesReturn {
  const [settings, setSettings] = useState<InboxSettingsDTO>(DEFAULTS)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true
    const load = async (): Promise<void> => {
      try {
        const result = await window.api.settings.getInboxSettings()
        if (mounted) setSettings(result)
      } catch (err) {
        if (mounted)
          setError(
            extractErrorMessage(
              err,
              getI18n().getFixedT(null, 'settings')('inbox.errors.failedToLoad')
            )
          )
      } finally {
        if (mounted) setIsLoading(false)
      }
    }
    void load()
    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    const unsubscribe = window.api.onSettingsChanged((event) => {
      if (event.key === 'inbox') {
        setSettings((prev) => ({ ...prev, ...(event.value as Partial<InboxSettingsDTO>) }))
      }
    })
    return unsubscribe
  }, [])

  const updateSettings = useCallback(
    async (updates: Partial<InboxSettingsDTO>): Promise<boolean> => {
      try {
        const result = await window.api.settings.setInboxSettings(updates)
        if (result.success) {
          setSettings((prev) => ({ ...prev, ...updates }))
          return true
        }
        setError(result.error ?? 'Update failed')
        return false
      } catch (err) {
        setError(
          extractErrorMessage(
            err,
            getI18n().getFixedT(null, 'settings')('inbox.errors.failedToUpdate')
          )
        )
        return false
      }
    },
    []
  )

  return { settings, isLoading, error, updateSettings }
}
```

> `InboxSettingsDTO` is emitted into `preload/index.d.ts` by `ipc:generate` from the RPC return type. If the generated name differs, import the actual generated DTO name; run `pnpm ipc:generate` first.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop test:renderer -- use-inbox-preferences`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/hooks/use-inbox-preferences.ts apps/desktop/src/renderer/src/hooks/use-inbox-preferences.test.tsx
git commit -m "feat(renderer): useInboxPreferences hook"
```

---

## Task 11: Renderer — Settings → Inbox section + nav

**Files:**

- Create: `apps/desktop/src/renderer/src/pages/settings/inbox-section.tsx`
- Modify: `apps/desktop/src/renderer/src/contexts/settings-modal-context.tsx:3-22` (union)
- Modify: `apps/desktop/src/renderer/src/pages/settings.tsx` (import; nav item ~L104; render ~L198)
- Test: `apps/desktop/src/renderer/src/pages/settings/inbox-section.test.tsx`

**Interfaces:**

- Consumes: `useInboxPreferences` (Task 10), `Switch` (`@/components/ui/switch`), `Input` (`@/components/ui/input`), settings primitives.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/renderer/src/pages/settings/inbox-section.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { InboxSettings } from './inbox-section'

const updateSettings = vi.fn().mockResolvedValue(true)
vi.mock('@/hooks/use-inbox-preferences', () => ({
  useInboxPreferences: () => ({
    settings: { reviewReminderEnabled: true, reviewReminderTime: '18:00' },
    isLoading: false,
    error: null,
    updateSettings
  })
}))

describe('InboxSettings section', () => {
  it('renders the review-reminder controls', () => {
    render(<InboxSettings />)
    expect(screen.getByTestId('inbox-review-toggle')).toBeInTheDocument()
    expect(screen.getByTestId('inbox-review-time')).toHaveValue('18:00')
  })

  it('persists a time change', () => {
    render(<InboxSettings />)
    fireEvent.change(screen.getByTestId('inbox-review-time'), { target: { value: '06:30' } })
    expect(updateSettings).toHaveBeenCalledWith({ reviewReminderTime: '06:30' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- inbox-section`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the section**

Create `apps/desktop/src/renderer/src/pages/settings/inbox-section.tsx`:

```tsx
import { useCallback } from 'react'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { useInboxPreferences } from '@/hooks/use-inbox-preferences'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import {
  SettingsHeader,
  SettingsGroup,
  SettingRow,
  ACCENT_SWITCH
} from '@/components/settings/settings-primitives'

export function InboxSettings() {
  const { t } = useT('settings')
  const { settings, isLoading, updateSettings } = useInboxPreferences()

  const handleToggle = useCallback(
    async (checked: boolean) => {
      const ok = await updateSettings({ reviewReminderEnabled: checked })
      if (!ok) toast.error(t('inbox.reviewReminder.error'))
    },
    [t, updateSettings]
  )

  const handleTimeChange = useCallback(
    async (value: string) => {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return
      const ok = await updateSettings({ reviewReminderTime: value })
      if (!ok) toast.error(t('inbox.reviewReminder.error'))
    },
    [t, updateSettings]
  )

  if (isLoading) {
    return (
      <div className="flex flex-col">
        <SettingsHeader title={t('inbox.header.title')} subtitle={t('inbox.header.loading')} />
      </div>
    )
  }

  return (
    <div className="flex flex-col text-xs/4">
      <SettingsHeader title={t('inbox.header.title')} subtitle={t('inbox.header.subtitle')} />

      <SettingsGroup label={t('inbox.reviewReminder.group')}>
        <SettingRow
          label={t('inbox.reviewReminder.enabled.label')}
          description={t('inbox.reviewReminder.enabled.description')}
        >
          <Switch
            data-testid="inbox-review-toggle"
            checked={settings.reviewReminderEnabled}
            onCheckedChange={(c) => void handleToggle(c)}
            className={ACCENT_SWITCH}
          />
        </SettingRow>

        {settings.reviewReminderEnabled && (
          <SettingRow
            label={t('inbox.reviewReminder.time.label')}
            description={t('inbox.reviewReminder.time.description')}
          >
            <Input
              data-testid="inbox-review-time"
              type="time"
              value={settings.reviewReminderTime}
              onChange={(e) => void handleTimeChange(e.target.value)}
              className="w-28 h-7 text-center text-xs/4 px-2"
            />
          </SettingRow>
        )}
      </SettingsGroup>
    </div>
  )
}
```

In `settings-modal-context.tsx`, add `'inbox'` to the `SettingsSection` union (after `'tasks'`, L8):

```ts
  | 'tasks'
  | 'inbox'
```

In `pages/settings.tsx`: add the import (near the tasks import, L32):

```ts
import { InboxSettings } from './settings/inbox-section'
```

Add a nav item after the Tasks nav item (~L90-96) — mirror the existing `<SettingsNavItem>` shape:

```tsx
<SettingsNavItem section="inbox" isActive={activeSection === 'inbox'} onSelect={setActiveSection}>
  {t('nav.inbox')}
</SettingsNavItem>
```

> Match the exact `SettingsNavItem` props/label pattern used by the sibling items in this file (icon, label source). Reuse the same `t(...)` namespace the file already uses for nav labels.

Add the section render after the Tasks render (L180):

```tsx
{
  activeSection === 'inbox' && <InboxSettings />
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop test:renderer -- inbox-section`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/pages/settings/inbox-section.tsx apps/desktop/src/renderer/src/pages/settings/inbox-section.test.tsx apps/desktop/src/renderer/src/contexts/settings-modal-context.tsx apps/desktop/src/renderer/src/pages/settings.tsx
git commit -m "feat(settings): Settings > Inbox review-reminder section"
```

---

## Task 12: Renderer — review notification hook (toast + open inbox)

**Files:**

- Create: `apps/desktop/src/renderer/src/hooks/use-inbox-review-notifications.ts`
- Modify: wire it where `use-reminder-notifications` is consumed (search: `useReminderNotifications(` in `apps/desktop/src/renderer/src`; add the new hook call in the same component)
- Test: `apps/desktop/src/renderer/src/hooks/use-inbox-review-notifications.test.tsx`

**Interfaces:**

- Consumes: `window.api.onInboxReviewDue`, `window.api.onInboxReviewOpen` (Task 9); the tabs context `openTab`/navigation used by the sidebar inbox entry (`app-sidebar.tsx:522`, path `'/inbox'`), and `sonner` `toast`.
- Produces: `useInboxReviewNotifications(): void` — shows a calm toast on `REVIEW_DUE` (with an "Open inbox" action) and opens the inbox tab on `REVIEW_OPEN`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/renderer/src/hooks/use-inbox-review-notifications.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useInboxReviewNotifications } from './use-inbox-review-notifications'

const toastFn = vi.fn()
vi.mock('sonner', () => ({ toast: (...a: unknown[]) => toastFn(...a) }))

const openInbox = vi.fn()
vi.mock('@/contexts/tabs', () => ({ useTabs: () => ({ openInboxTab: openInbox }) }))

let dueCb: ((e: { count: number }) => void) | null = null
let openCb: (() => void) | null = null

describe('useInboxReviewNotifications', () => {
  beforeEach(() => {
    toastFn.mockClear()
    openInbox.mockClear()
    window.api = {
      onInboxReviewDue: vi.fn((cb) => {
        dueCb = cb
        return () => {}
      }),
      onInboxReviewOpen: vi.fn((cb) => {
        openCb = cb
        return () => {}
      })
    } as never
  })

  it('toasts on review-due', () => {
    renderHook(() => useInboxReviewNotifications())
    dueCb?.({ count: 4 })
    expect(toastFn).toHaveBeenCalled()
  })

  it('opens the inbox on review-open', () => {
    renderHook(() => useInboxReviewNotifications())
    openCb?.()
    expect(openInbox).toHaveBeenCalled()
  })
})
```

> Adjust the tabs-context mock (`useTabs`/`openInboxTab`) to the real API the sidebar uses to open the `/inbox` tab. Read `app-sidebar.tsx` around L522 and the tabs context to use the exact call.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- use-inbox-review-notifications`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the hook**

Create `apps/desktop/src/renderer/src/hooks/use-inbox-review-notifications.ts`:

```ts
import { useEffect } from 'react'
import { toast } from 'sonner'
import { getI18n } from 'react-i18next'
import { useTabs } from '@/contexts/tabs'

/**
 * Surfaces the daily review nudge in-app: a calm toast when the OS notification
 * fires, and opens the Inbox when the user clicks the OS notification.
 */
export function useInboxReviewNotifications(): void {
  const tabs = useTabs()

  useEffect(() => {
    const openInbox = (): void => {
      // Mirror the sidebar inbox entry (app-sidebar.tsx) — open the '/inbox' tab.
      tabs.openInboxTab()
    }

    const unsubscribeDue = window.api.onInboxReviewDue(({ count }) => {
      const t = getI18n().getFixedT(null, 'inbox')
      toast(t('reviewNudge.title', { count }), {
        description: t('reviewNudge.description'),
        action: { label: t('reviewNudge.action'), onClick: openInbox }
      })
    })

    const unsubscribeOpen = window.api.onInboxReviewOpen(openInbox)

    return () => {
      unsubscribeDue()
      unsubscribeOpen()
    }
  }, [tabs])
}
```

> Replace `tabs.openInboxTab()` and the `useTabs` import with the real tabs API used at `app-sidebar.tsx:522` to open `path: '/inbox'` (e.g. an `openTab({ type: 'inbox', path: '/inbox' })` call). Keep the toast text/action.

Wire it into the component that already calls `useReminderNotifications()` (add `useInboxReviewNotifications()` next to it).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop test:renderer -- use-inbox-review-notifications`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/hooks/use-inbox-review-notifications.ts apps/desktop/src/renderer/src/hooks/use-inbox-review-notifications.test.tsx
git commit -m "feat(renderer): in-app review nudge toast + open-inbox on click"
```

---

## Task 13: i18n keys

**Files:**

- Modify: `packages/i18n/src/locales/en/settings.json` (inbox section + nav label)
- Modify: `packages/i18n/src/locales/en/inbox.json` (reviewNudge toast)
- Modify: `packages/i18n/src/locales/en/system.json` (notification strings)

**Interfaces:**

- Produces: the i18n keys referenced in Tasks 10-12 and the notification builder (Task 7).

- [ ] **Step 1: Add settings keys**

In `packages/i18n/src/locales/en/settings.json`, add (merge into existing structure; add `nav.inbox` to the existing `nav` object):

```json
"inbox": {
  "header": {
    "title": "Inbox",
    "subtitle": "Daily review reminder and inbox preferences.",
    "loading": "Loading…"
  },
  "reviewReminder": {
    "group": "Daily review reminder",
    "enabled": {
      "label": "Remind me to review my inbox",
      "description": "A gentle daily nudge when your inbox has items."
    },
    "time": {
      "label": "Reminder time",
      "description": "Local time, on each device."
    },
    "error": "Could not update the reminder."
  },
  "errors": {
    "failedToLoad": "Failed to load inbox settings.",
    "failedToUpdate": "Failed to update inbox settings."
  }
}
```

- [ ] **Step 2: Add inbox toast keys**

In `packages/i18n/src/locales/en/inbox.json`:

```json
"reviewNudge": {
  "title": "Time to review your inbox",
  "description": "Process today's captures in one calm pass.",
  "action": "Open inbox"
}
```

- [ ] **Step 3: Add notification keys (verify plural style first)**

Run: `grep -n "plural" packages/i18n/src/locales/en/system.json` to confirm whether the repo uses ICU (`{count, plural, ...}`) or i18next suffix plurals.

If ICU (single-brace), add to `packages/i18n/src/locales/en/system.json` under `notification`:

```json
"inboxReview": {
  "title": "Time to review your inbox",
  "body": "You have {count, plural, one {# item} other {# items}} to review."
}
```

If i18next suffix plurals, instead add:

```json
"inboxReview": {
  "title": "Time to review your inbox",
  "body_one": "You have {{count}} item to review.",
  "body_other": "You have {{count}} items to review."
}
```

- [ ] **Step 4: Run the i18n gate + typecheck**

Run: `pnpm --filter @memry/desktop i18n:check`
Expected: PASS (no missing English keys).

- [ ] **Step 5: Commit**

```bash
git add packages/i18n/src/locales/en/settings.json packages/i18n/src/locales/en/inbox.json packages/i18n/src/locales/en/system.json
git commit -m "i18n: inbox review reminder + notification strings"
```

---

## Task 14: E2E test hooks

**Files:**

- Modify: `apps/desktop/src/main/test-hooks.ts` (interface ~L130-165; implementation inside `registerTestHooks()` ~after L243)

**Interfaces:**

- Consumes: `runReviewTick` (Task 7), `inboxItems` insert, `writeInboxReviewSettings` (Task 5).
- Produces (test-hooks surface, gated by `NODE_ENV === 'test'`):
  - `seedInboxItemForE2E(input: { title: string }): Promise<string>`
  - `setInboxReviewSettingsForE2E(input: { enabled: boolean; time: string }): Promise<void>`
  - `forceInboxReviewTickForE2E(input: { nowIso: string }): Promise<{ notified: boolean; count: number }>`

- [ ] **Step 1: Add the hook type declarations**

In `apps/desktop/src/main/test-hooks.ts`, add to the test-hooks interface (~L130-165):

```ts
  seedInboxItemForE2E(input: { title: string }): Promise<string>
  setInboxReviewSettingsForE2E(input: { enabled: boolean; time: string }): Promise<void>
  forceInboxReviewTickForE2E(input: {
    nowIso: string
  }): Promise<{ notified: boolean; count: number }>
```

- [ ] **Step 2: Implement the hooks**

Add imports at the top of `test-hooks.ts`:

```ts
import { inboxItems, inboxItemType } from '@memry/db-schema/schema/inbox'
import { runReviewTick } from './inbox/review-scheduler'
import { writeInboxReviewSettings } from './ipc/settings-handlers'
import { generateId } from './lib/id'
```

Add inside the object returned/registered by `registerTestHooks()` (alongside the other `*ForE2E` methods):

```ts
    async seedInboxItemForE2E(input: { title: string }): Promise<string> {
      const db = getDatabase()
      const id = `inbox_e2e_${generateId()}`
      const ts = '2026-07-17T00:00:00.000Z'
      db.insert(inboxItems)
        .values({
          id,
          type: inboxItemType.NOTE,
          title: input.title,
          createdAt: ts,
          modifiedAt: ts,
          processingStatus: 'complete'
        })
        .run()
      return id
    },

    async setInboxReviewSettingsForE2E(input: {
      enabled: boolean
      time: string
    }): Promise<void> {
      writeInboxReviewSettings({
        reviewReminderEnabled: input.enabled,
        reviewReminderTime: input.time
      })
    },

    async forceInboxReviewTickForE2E(input: {
      nowIso: string
    }): Promise<{ notified: boolean; count: number }> {
      return runReviewTick(new Date(input.nowIso))
    },
```

> `new Date(input.nowIso)` uses an ISO string with an explicit offset from the test so the local-time comparison inside `runReviewTick` is deterministic on the CI machine's timezone. The E2E (Task 15) passes an offset that lands at/after the configured target in the runner's local time.

- [ ] **Step 3: Typecheck main**

Run: `pnpm --filter @memry/desktop typecheck:node`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/main/test-hooks.ts
git commit -m "test(e2e): inbox review scheduler test hooks"
```

---

## Task 15: E2E — end-to-end review nudge flow

**Files:**

- Create: `apps/desktop/tests/e2e/inbox-review-reminder.e2e.ts` (mirror an existing `*.e2e.ts` bootstrap, e.g. `quick-capture.e2e.ts`)

**Interfaces:**

- Consumes: the test-hooks surface (Task 14), `window.api.settings.setInboxSettings` (renderer), and the electron test bootstrap used by sibling E2E specs.

- [ ] **Step 1: Write the E2E spec**

Create `apps/desktop/tests/e2e/inbox-review-reminder.e2e.ts` (adapt the bootstrap/fixture imports to the repo's existing e2e harness — copy the top-of-file setup from `quick-capture.e2e.ts`):

```ts
import { test, expect } from './fixtures' // use the repo's electron fixture

test.describe('inbox scheduled review', () => {
  test('fires once when inbox has items at the target time', async ({ electronApp, page }) => {
    const invokeHook = async (name: string, arg: unknown) =>
      electronApp.evaluate(
        async ({ ipcMain: _ignored }, { name, arg }) => {
          // Access the registered test-hooks surface the same way sibling e2e specs do.
          // Replace with the project's helper for calling test hooks.
          return (
            globalThis as never as {
              __memryTestHooks: Record<string, (a: unknown) => Promise<unknown>>
            }
          ).__memryTestHooks[name](arg)
        },
        { name, arg }
      )

    // 1) Enable the reminder for 18:00 and seed one inbox item.
    await invokeHook('setInboxReviewSettingsForE2E', { enabled: true, time: '18:00' })
    await invokeHook('seedInboxItemForE2E', { title: 'Read later' })

    // 2) Before target → silent.
    const before = (await invokeHook('forceInboxReviewTickForE2E', {
      nowIso: '2026-07-17T17:00:00'
    })) as { notified: boolean }
    expect(before.notified).toBe(false)

    // 3) At target → fires once, count 1.
    const atTarget = (await invokeHook('forceInboxReviewTickForE2E', {
      nowIso: '2026-07-17T18:00:00'
    })) as { notified: boolean; count: number }
    expect(atTarget).toMatchObject({ notified: true, count: 1 })

    // 4) In-app toast appears (OS-notification proxy).
    await expect(page.getByText(/review your inbox/i)).toBeVisible()

    // 5) Second tick same day → no re-fire (once/day).
    const again = (await invokeHook('forceInboxReviewTickForE2E', {
      nowIso: '2026-07-17T18:30:00'
    })) as { notified: boolean }
    expect(again.notified).toBe(false)
  })

  test('stays silent when the inbox is empty', async ({ electronApp }) => {
    const invokeHook = async (name: string, arg: unknown) =>
      electronApp.evaluate(
        async (_e, { name, arg }) =>
          (
            globalThis as never as {
              __memryTestHooks: Record<string, (a: unknown) => Promise<unknown>>
            }
          ).__memryTestHooks[name](arg),
        { name, arg }
      )
    await invokeHook('setInboxReviewSettingsForE2E', { enabled: true, time: '18:00' })
    const r = (await invokeHook('forceInboxReviewTickForE2E', {
      nowIso: '2026-07-17T18:00:00'
    })) as { notified: boolean }
    expect(r.notified).toBe(false)
  })
})
```

> The `invokeHook`/`electronApp.evaluate` shape MUST be replaced with the repo's actual mechanism for calling `test-hooks` from an e2e spec (read `quick-capture.e2e.ts` and how it reaches `registerTestHooks` — likely a `page.evaluate(() => window.testHooks.x())` or an ipc channel). Keep the assertions.

- [ ] **Step 2: Run the E2E spec**

Run: `pnpm --filter @memry/desktop test:e2e -- inbox-review-reminder`
Expected: PASS (2 tests). If native load errors appear, run `pnpm --filter @memry/desktop rebuild:electron` first.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/tests/e2e/inbox-review-reminder.e2e.ts
git commit -m "test(e2e): inbox scheduled review end-to-end"
```

---

## Task 16: Full verification + docs

**Files:**

- Modify: `apps/docs/src/**` (via `pnpm docs:ai-update` or manual)

- [ ] **Step 1: Run the full verify suite**

```bash
pnpm ipc:generate && pnpm ipc:check
pnpm lint
pnpm typecheck
pnpm --filter @memry/desktop test:main
pnpm --filter @memry/desktop test:renderer
pnpm --filter @memry/desktop i18n:check
git diff --check
```

Expected: all green. Fix any failure before proceeding.

- [ ] **Step 2: Docs gate**

```bash
base_commit=$(git merge-base origin/main HEAD)
pnpm docs:ai-update --base "$base_commit"   # or edit apps/docs/src manually
pnpm docs:impact --base "$base_commit" --strict
pnpm docs:build
```

Expected: docs impact passes; docs build succeeds. If `missing-docs`, add a short Settings → Inbox reference under `apps/docs/src/**` describing the daily review reminder, then re-run.

- [ ] **Step 3: E2E full run**

```bash
pnpm test:e2e -- inbox-review-reminder
```

Expected: PASS.

- [ ] **Step 4: Commit docs**

```bash
git add apps/docs/src
git commit -m "docs: Settings > Inbox daily review reminder"
```

---

## Self-Review

**Spec coverage:**

- Optional daily reminder at user-set time → Tasks 1, 4, 7, 11. ✅
- Fire only if inbox has items → Task 3 (count) + Task 4 (`inboxCount <= 0` guard). ✅
- Desktop notification → Task 7 (`showReviewNotification`). ✅
- Schedule syncs across devices → Tasks 1 (synced group), 5 (field push), 6 (propagate/broadcast). ✅
- Each device watches independently / once per day per device → Task 7 (local last-fired key, unsynced) + Task 4 (date guard). ✅
- Configured from Settings → Inbox → Task 11. ✅
- Catch-up same-day, no cross-midnight → Task 4 tests. ✅
- Match-the-badge count (unfiled − snoozed − viewed-reminders) → Task 3 tests. ✅
- Backward compatibility → Task 6 regression test. ✅
- Notification click → open inbox → Tasks 7 (`REVIEW_OPEN`), 9, 12. ✅
- All edge cases from the spec matrix → Task 4 (#1,#2,#3,#5,#6,#8,#17,#18,#19), Task 3 (#17,#18), Task 7 (idempotency #15), Task 6 (#16). #9/#10/#11 (DST/clock/timezone) are covered by the local-wall-clock design and exercised implicitly by Task 4's local-Date construction. ✅
- Unit + E2E tests → every task is TDD; Tasks 14-15 are E2E. ✅

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N". The `>` notes flag spots where the implementer must match an exact existing signature (tabs API, test-hook invocation, plural style) — each names the file to read and preserves the assertions. ✅

**Type consistency:** `decideReviewNotification` input/output identical across Tasks 4 and 7. `getInboxReviewSettings` (Task 5) consumed in Task 7. `writeInboxReviewSettings` (Task 5) consumed in Task 14. Channel constants (`inbox:review-due`/`inbox:review-open`, Task 2) consumed in Tasks 7, 9, 12. `INBOX_SETTINGS_DEFAULTS` (Task 1) consumed in Tasks 5, 10. Settings group key `'inbox'` and last-fired key `'inbox.reviewLastNotifiedDate'` consistent across Tasks 5, 6, 7. ✅
