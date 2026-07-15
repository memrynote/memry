# Server + Desktop Additive Sync (D6 item types + D8 settings-push) Implementation Plan

> Agentic workers: execute this with the `superpowers:subagent-driven-development` sub-skill. Each step below is a checkbox; check it off only when its exact verification evidence is green. Follow strict TDD (failing test first). Also load the `adding-sync-item-type` skill before Task 1 — it encodes the full enum + registry + telemetry checklist and guards the non-exhaustive-switch typecheck failure.

**Goal:** Make `home_page`, `bookmark`, and `reminder` first-class cross-device record-sync entities and widen the settings-sync PUSH emitter beyond `general.*` to the `editor`/`tasks`/`calendar`/`keyboard` groups — purely additive, server-deploys-first, backward-compatible for every existing install.

**Architecture:** Home pages, bookmarks, and reminders already live in local `data.db` tables but are device-local today. This plan wires them through the existing record-sync strategy pattern: three new payload Zod schemas in `@memry/contracts` (the single wire-format source of truth), three doc-clock last-write-wins item handlers registered in the desktop handler registry, three `RecordSyncController`-backed sync services registered in the runtime, and emit-on-mutation calls from the three IPC handler modules. The sync-server stores payloads generically in `sync_items` (D1 metadata + R2 blobs), so the only server touch is the exhaustive `toSyncDomain` telemetry switch (a typecheck gate). A hand-written data-DB migration (`0035`) adds a nullable `clock` JSON column to the three tables; a `NULL` clock is the `seedUnclocked` trigger that back-fills existing rows into sync on first run. Settings D8 is a push-side allowlist widening only — the inbound `mergeRemote` path is already group-agnostic.

**Tech Stack:** TypeScript, Zod v4, Drizzle ORM over `better-sqlite3` (desktop `data.db`), Cloudflare Workers + Hono + D1/R2 (sync-server), Vitest, Electron 39 main process.

---

## Global Constraints

Copied verbatim from the mobile-port program shared spine. These bind every task in this plan:

- Backward compatibility is MANDATORY for production installs: every change must work for existing installs, no DB resets, sync protocol / IPC contracts / vault file formats / settings shapes must tolerate data written by older app versions.
- DB schema changes go through additive, hand-written D1/data-DB migrations that preserve existing rows (Drizzle snapshots broken past 0021; data-DB migrations are hand-written).
- Sync-server deploys BEFORE desktop/mobile clients for every additive change (D6 sync item types, D8 settings-push, entitlement_grants).
- Crypto parameters are IMMUTABLE and byte-identical across clients: Argon2id v1.3 ops=3, mem=64 MiB, parallelism=1; BLAKE2b crypto_kdf_derive_from_key with exact 8-char contexts (memryvlt/memrysgn/memryvrf/memrykve/memrylnk/memrymac/memrysas); base64 = sodium.base64_variants.ORIGINAL (standard alphabet, padded); cryptoVersion=1; canonical CBOR in CBOR_FIELD_ORDER.
- E2E-encrypted: server never sees plaintext; it verifies Ed25519 via WebCrypto and validates envelope lengths only.
- Offline-first: SQLite local storage is canonical on mobile; CRDT (Yjs) for note/journal bodies, field-level vector clocks for tasks/projects/calendar; correctness never depends on background execution.
- `@blocknote/*`, `yjs`, and `zod` pinned IDENTICALLY to desktop across clients; a CI check fails the mobile build on drift; BlockNote bumps gated on the markdown round-trip / byte-preservation golden suite.
- `@memry/contracts` is the single wire-format source of truth; mobile MUST import, never copy (copying breaks cross-device crypto/signature interop).
- No `Co-Authored-By` trailer on commit messages.
- Prettier: single quotes, no semicolons, 100-char width, no trailing commas.
- RTL safety: new code uses logical Tailwind/RN props (`ms-`/`me-`, `ps-`/`pe-`, `start-`/`end-`) that flip automatically in RTL; RN uses `I18nManager.forceRTL` instead of `document.dir`.
- Extraction principle: move files, re-export from old paths, tests move with the code, desktop consumes the new package first — each extraction keeps desktop green, verified by the existing suite before mobile exists.
- Logging via `createLogger('Scope')` seam (never raw `console.*`); user-facing errors via `extractErrorMessage(err, fallback)`.
- WCAG AA + reduced-motion + RTL accessibility per PRODUCT.md; personality calm, private, crafted.

Version pins relevant here: `zod = ^4.3.4` (must match `packages/contracts`). Zod v4 gotcha: `z.record(z.unknown())` throws in `safeParse` → always use `z.record(z.string(), z.unknown())`.

**Deploy order for THIS plan (hard rule):** the sync-server change in Task 3 MUST be deployed to production (staging auto-deploys on `main` push; prod is manual + approval via GitHub Actions) BEFORE any desktop build that ships Tasks 1–2's new item types reaches users. If desktop pushes `home_page`/`bookmark`/`reminder` items to a server that predates the `toSyncDomain` change, telemetry logging throws on the unknown type. Coordinate the desktop release to trail the server deploy.

---

## File Structure

**Modify**

| Path                                                             | Responsibility                                                                                                                                                                                                        |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/sync-api.ts`                             | Add the three types to `SYNC_ITEM_TYPES`, `RECORD_SYNC_ITEM_TYPES`, `RECORD_CLOCK_REQUIRED_ITEM_TYPES`, `ENCRYPTABLE_ITEM_TYPES` (NOT `CRDT_SYNC_ITEM_TYPES`). Derived types + `z.enum` schemas update automatically. |
| `packages/contracts/src/sync-payloads.ts`                        | Add `HomePageSyncPayloadSchema`, `BookmarkSyncPayloadSchema`, `ReminderSyncPayloadSchema` + inferred `*SyncPayload` type exports.                                                                                     |
| `apps/sync-server/src/services/sync-telemetry.ts`                | Extend the exhaustive `toSyncDomain` switch + `SyncDomain` union with `home`/`bookmarks`/`reminders`.                                                                                                                 |
| `apps/sync-server/src/services/storage.ts`                       | No code change: new types fall through the existing `default → breakdown.other`. Covered by a characterization test only.                                                                                             |
| `packages/db-schema/src/schema/home-pages.ts`                    | Add `clock: text('clock', { mode: 'json' })` column so ORM types include it.                                                                                                                                          |
| `packages/db-schema/src/schema/bookmarks.ts`                     | Add `clock` column (same).                                                                                                                                                                                            |
| `packages/db-schema/src/schema/reminders.ts`                     | Add `clock` column (same).                                                                                                                                                                                            |
| `apps/desktop/src/main/database/drizzle-data/meta/_journal.json` | Append the `0035` migration journal entry.                                                                                                                                                                            |
| `apps/desktop/src/main/sync/item-handlers/index.ts`              | Register the three new handlers in the `handlers` Map.                                                                                                                                                                |
| `apps/desktop/src/main/sync/local-mutations.ts`                  | Add three `record` adapters to the registry; import the three `get*SyncService`.                                                                                                                                      |
| `apps/desktop/src/main/sync/runtime.ts`                          | Import `init*`/`reset*`; init the three services; add them to `adapters` + `resetSyncServiceSingletons`.                                                                                                              |
| `apps/desktop/src/main/ipc/home-page-handlers.ts`                | Emit-on-mutation for create/update/delete/reorder.                                                                                                                                                                    |
| `apps/desktop/src/main/ipc/bookmarks-handlers.ts`                | Emit-on-mutation for create/delete/toggle/reorder.                                                                                                                                                                    |
| `apps/desktop/src/main/ipc/reminder-handlers.ts`                 | Emit-on-mutation for create/update/delete/dismiss/snooze.                                                                                                                                                             |
| `apps/desktop/src/main/ipc/settings-handlers.ts`                 | D8: push `editor`/`tasks`/`calendar`/`keyboard` field paths via `syncSettingsUpdates`.                                                                                                                                |

**Create**

| Path                                                                                      | Responsibility                                                                                                |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `apps/desktop/src/main/database/drizzle-data/0035_sync_clocks_home_bookmark_reminder.sql` | Hand-written additive migration: `ALTER TABLE ... ADD COLUMN clock text` on the three tables.                 |
| `apps/desktop/src/main/sync/item-handlers/home-page-handler.ts`                           | `HomePageHandler` — doc-clock LWW keyed by `home_pages.id`.                                                   |
| `apps/desktop/src/main/sync/item-handlers/bookmark-handler.ts`                            | `BookmarkHandler` — doc-clock LWW keyed by `bookmarks.id`, reconciling the `unique(item_type,item_id)` index. |
| `apps/desktop/src/main/sync/item-handlers/reminder-handler.ts`                            | `ReminderHandler` — doc-clock LWW over the full `reminders` row.                                              |
| `apps/desktop/src/main/sync/home-page-sync.ts`                                            | `HomePageSyncService` — `RecordSyncController` keyed by `home_pages.id`.                                      |
| `apps/desktop/src/main/sync/bookmark-sync.ts`                                             | `BookmarkSyncService` — `RecordSyncController` keyed by `bookmarks.id`.                                       |
| `apps/desktop/src/main/sync/reminder-sync.ts`                                             | `ReminderSyncService` — `RecordSyncController` keyed by `reminders.id`.                                       |
| `apps/desktop/src/main/sync/item-handlers/home-page-handler.test.ts`                      | Handler tests.                                                                                                |
| `apps/desktop/src/main/sync/item-handlers/bookmark-handler.test.ts`                       | Handler tests.                                                                                                |
| `apps/desktop/src/main/sync/item-handlers/reminder-handler.test.ts`                       | Handler tests.                                                                                                |

---

### Task 1: Contracts — extend the sync item-type enums

**Files:**

- Modify: `packages/contracts/src/sync-api.ts` (arrays at lines 7–24, 26–42, 44–59, 65–81)
- Test: `packages/contracts/src/sync-api.test.ts` (Create if absent)

**Interfaces:**

- Produces: `SYNC_ITEM_TYPES`, `RECORD_SYNC_ITEM_TYPES`, `RECORD_CLOCK_REQUIRED_ITEM_TYPES`, `ENCRYPTABLE_ITEM_TYPES` now each include `'home_page' | 'bookmark' | 'reminder'`. Derived types `SyncItemType`, `RecordSyncItemType`, `RecordClockRequiredItemType`, `EncryptableItemType` widen automatically. `CRDT_SYNC_ITEM_TYPES` stays `['note']`.

- [ ] **Step 1: Write the failing test.** Create `packages/contracts/src/sync-api.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  SYNC_ITEM_TYPES,
  RECORD_SYNC_ITEM_TYPES,
  RECORD_CLOCK_REQUIRED_ITEM_TYPES,
  ENCRYPTABLE_ITEM_TYPES,
  CRDT_SYNC_ITEM_TYPES
} from './sync-api'

const NEW_TYPES = ['home_page', 'bookmark', 'reminder'] as const

describe('D6 sync item types', () => {
  it('registers home_page/bookmark/reminder as record + clock-required + encryptable', () => {
    for (const t of NEW_TYPES) {
      expect(SYNC_ITEM_TYPES).toContain(t)
      expect(RECORD_SYNC_ITEM_TYPES).toContain(t)
      expect(RECORD_CLOCK_REQUIRED_ITEM_TYPES).toContain(t)
      expect(ENCRYPTABLE_ITEM_TYPES).toContain(t)
    }
  })

  it('does NOT treat them as CRDT types', () => {
    for (const t of NEW_TYPES) {
      expect(CRDT_SYNC_ITEM_TYPES).not.toContain(t)
    }
  })
})
```

- [ ] **Step 2: Run it, expect FAIL.** Command: `pnpm --filter @memry/contracts test -- sync-api`. Expected failure: `AssertionError: expected [ 'note', 'task', … ] to contain 'home_page'`.

- [ ] **Step 3: Minimal implementation.** In `packages/contracts/src/sync-api.ts` append the three entries to the four arrays. Add to `SYNC_ITEM_TYPES` (after `'agent_message'`), `RECORD_SYNC_ITEM_TYPES` (after `'agent_message'`), `RECORD_CLOCK_REQUIRED_ITEM_TYPES` (after `'agent_message'`), and `ENCRYPTABLE_ITEM_TYPES` (after `'agent_message'`):

```ts
  'agent_message',
  'home_page',
  'bookmark',
  'reminder'
] as const
```

Apply the identical three-line insertion to each of the four `as const` arrays. Leave `CRDT_SYNC_ITEM_TYPES` untouched.

- [ ] **Step 4: Run tests, expect PASS.** Command: `pnpm --filter @memry/contracts test -- sync-api`. Expected: `2 passed`. Then `pnpm typecheck` — expect no new errors (derived unions widen automatically).

- [ ] **Step 5: Commit.** `git add packages/contracts/src/sync-api.ts packages/contracts/src/sync-api.test.ts && git commit -m "feat(contracts): register home_page/bookmark/reminder sync item types"`

---

### Task 2: Contracts — payload schemas

**Files:**

- Modify: `packages/contracts/src/sync-payloads.ts` (add schemas after `FolderConfigSyncPayloadSchema` at line 120; add type exports in the block at lines 329–346)
- Test: `packages/contracts/src/sync-payloads.test.ts` (Create if absent)

**Interfaces:**

- Consumes: `VectorClockSchema` from `./sync-api` (already imported at line 2).
- Produces:
  - `HomePageSyncPayloadSchema` / `type HomePageSyncPayload` — `{ name?, icon?: string|null, position?, widgets?: string (JSON WidgetInstance[]), clock?, createdAt?, updatedAt? }`
  - `BookmarkSyncPayloadSchema` / `type BookmarkSyncPayload` — `{ itemType?, itemId?, position?, clock?, createdAt? }`
  - `ReminderSyncPayloadSchema` / `type ReminderSyncPayload` — mirrors the `reminders` table columns.

- [ ] **Step 1: Write the failing test.** Create `packages/contracts/src/sync-payloads.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  HomePageSyncPayloadSchema,
  BookmarkSyncPayloadSchema,
  ReminderSyncPayloadSchema
} from './sync-payloads'

describe('D6 payload schemas', () => {
  it('parses a home_page payload with widgets JSON and a vector clock', () => {
    const parsed = HomePageSyncPayloadSchema.parse({
      name: 'Home',
      icon: null,
      position: 0,
      widgets: '[]',
      clock: { 'device-A': 3 },
      createdAt: '2026-07-14T00:00:00.000Z',
      updatedAt: '2026-07-14T00:00:00.000Z'
    })
    expect(parsed.widgets).toBe('[]')
    expect(parsed.clock).toEqual({ 'device-A': 3 })
  })

  it('parses a bookmark payload', () => {
    const parsed = BookmarkSyncPayloadSchema.parse({
      itemType: 'note',
      itemId: 'note_123',
      position: 2,
      clock: { 'device-B': 1 }
    })
    expect(parsed.itemId).toBe('note_123')
  })

  it('parses a reminder payload with nullable highlight fields', () => {
    const parsed = ReminderSyncPayloadSchema.parse({
      targetType: 'note',
      targetId: 'note_123',
      remindAt: '2026-07-15T09:00:00.000Z',
      highlightText: null,
      highlightStart: null,
      highlightEnd: null,
      anchorId: null,
      title: null,
      note: null,
      status: 'pending',
      triggeredAt: null,
      dismissedAt: null,
      snoozedUntil: null,
      clock: { 'device-A': 1 }
    })
    expect(parsed.status).toBe('pending')
  })
})
```

- [ ] **Step 2: Run it, expect FAIL.** Command: `pnpm --filter @memry/contracts test -- sync-payloads`. Expected failure: `SyntaxError`/import error — `HomePageSyncPayloadSchema` is not exported.

- [ ] **Step 3: Minimal implementation.** In `packages/contracts/src/sync-payloads.ts`, insert after `FolderConfigSyncPayloadSchema` (line 120):

```ts
export const HomePageSyncPayloadSchema = z.object({
  name: z.string().optional(),
  icon: z.string().nullable().optional(),
  position: z.number().optional(),
  // JSON-encoded WidgetInstance[]; stored verbatim, parsed by the handler.
  widgets: z.string().optional(),
  clock: VectorClockSchema.optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional()
})

export const BookmarkSyncPayloadSchema = z.object({
  itemType: z.string().optional(),
  itemId: z.string().optional(),
  position: z.number().optional(),
  clock: VectorClockSchema.optional(),
  createdAt: z.string().optional()
})

export const ReminderSyncPayloadSchema = z.object({
  targetType: z.string().optional(),
  targetId: z.string().optional(),
  remindAt: z.string().optional(),
  highlightText: z.string().nullable().optional(),
  highlightStart: z.number().nullable().optional(),
  highlightEnd: z.number().nullable().optional(),
  anchorId: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  status: z.string().optional(),
  triggeredAt: z.string().nullable().optional(),
  dismissedAt: z.string().nullable().optional(),
  snoozedUntil: z.string().nullable().optional(),
  clock: VectorClockSchema.optional(),
  createdAt: z.string().optional(),
  modifiedAt: z.string().optional()
})
```

Then in the type-export block (near line 344) add:

```ts
export type HomePageSyncPayload = z.infer<typeof HomePageSyncPayloadSchema>
export type BookmarkSyncPayload = z.infer<typeof BookmarkSyncPayloadSchema>
export type ReminderSyncPayload = z.infer<typeof ReminderSyncPayloadSchema>
```

- [ ] **Step 4: Run tests, expect PASS.** Command: `pnpm --filter @memry/contracts test -- sync-payloads`. Expected: `3 passed`. Then `pnpm ipc:check` (contract boundary unchanged for IPC, but verify no invoke-map drift) — expect `IPC invoke map is up to date`.

- [ ] **Step 5: Commit.** `git add packages/contracts/src/sync-payloads.ts packages/contracts/src/sync-payloads.test.ts && git commit -m "feat(contracts): add home_page/bookmark/reminder sync payload schemas"`

---

### Task 3: Sync-server — exhaustive telemetry switch (deploy-first gate)

**Files:**

- Modify: `apps/sync-server/src/services/sync-telemetry.ts` (`SyncDomain` union lines 8–19; `toSyncDomain` switch lines 30–60)
- Test: `apps/sync-server/src/services/sync-telemetry.test.ts` (Create if absent)
- Test (characterization): `apps/sync-server/src/services/storage.test.ts` — assert no compile break; new types bucket into `other`. (If a D1-backed storage test already exists, add the assertion there; otherwise cover it inline in the telemetry test file's documentation and skip a separate storage test — no runtime change to storage.)

**Interfaces:**

- Consumes: `SyncItemType` from `@memry/contracts/sync-api` (now includes the three new types from Task 1).
- Produces: `toSyncDomain(itemType: SyncItemType): SyncDomain` total over the widened union; `SyncDomain` gains `'home' | 'bookmarks' | 'reminders'`.

- [ ] **Step 1: Write the failing test.** Create `apps/sync-server/src/services/sync-telemetry.test.ts`. `toSyncDomain` is module-private, so drive it through the public `logRecordQueryBatch` (which calls `summarizeItemTypes` → `toSyncDomain`) and a spy on the logger, or export a thin test hook. Simplest: temporarily export `toSyncDomain` for testing by adding `export` to it (it is otherwise unused externally). Test:

```ts
import { describe, it, expect } from 'vitest'
import { toSyncDomain } from './sync-telemetry'

describe('toSyncDomain', () => {
  it('maps the D6 record types to distinct domains', () => {
    expect(toSyncDomain('home_page')).toBe('home')
    expect(toSyncDomain('bookmark')).toBe('bookmarks')
    expect(toSyncDomain('reminder')).toBe('reminders')
  })
})
```

- [ ] **Step 2: Run it, expect FAIL.** Command: `pnpm --filter @memry/sync-server test -- sync-telemetry`. Expected failure: `toSyncDomain is not a function` (not yet exported) AND, once exported, `pnpm --filter @memry/sync-server typecheck` fails with `Function lacks ending return statement and return type does not include 'undefined'` because the switch is now non-exhaustive over the widened `SyncItemType`.

- [ ] **Step 3: Minimal implementation.** In `apps/sync-server/src/services/sync-telemetry.ts`:
  1. Widen the union (lines 8–19), appending:

```ts
  | 'agent_chat'
  | 'home'
  | 'bookmarks'
  | 'reminders'
```

2. Add `export` to `const toSyncDomain` so the test can import it.
3. Add cases before the switch closes (after the `agent_message` case at line 58):

```ts
    case 'home_page':
      return 'home'
    case 'bookmark':
      return 'bookmarks'
    case 'reminder':
      return 'reminders'
```

- [ ] **Step 4: Run tests, expect PASS.** Commands: `pnpm --filter @memry/sync-server test -- sync-telemetry` → `1 passed`; `pnpm --filter @memry/sync-server typecheck` → no errors (switch now exhaustive). Storage note: `apps/sync-server/src/services/storage.ts` needs no edit — the three new `item_type` values hit `default: breakdown.other` at line 55 with no compile break; confirm by reading lines 46–58 and leaving them unchanged.

- [ ] **Step 5: Commit.** `git add apps/sync-server/src/services/sync-telemetry.ts apps/sync-server/src/services/sync-telemetry.test.ts && git commit -m "feat(sync-server): map home/bookmark/reminder in toSyncDomain telemetry switch"`

> DEPLOY GATE: after this task merges to `main`, the server auto-deploys to staging; promote to production (manual approval in GitHub Actions) BEFORE the desktop release carrying Tasks 1–2 ships. Do not check this task complete until the prod deploy is queued/scheduled.

---

### Task 4: Data-DB migration 0035 + schema clock columns

**Files:**

- Create: `apps/desktop/src/main/database/drizzle-data/0035_sync_clocks_home_bookmark_reminder.sql`
- Modify: `apps/desktop/src/main/database/drizzle-data/meta/_journal.json` (append entry idx 35)
- Modify: `packages/db-schema/src/schema/home-pages.ts`, `packages/db-schema/src/schema/bookmarks.ts`, `packages/db-schema/src/schema/reminders.ts`
- Test: `apps/desktop/src/main/database/migrate.test.ts` (add a case) and rely on the existing `migrate-journal.test.ts` monotonic-`when` guard.

**Interfaces:**

- Produces: `home_pages.clock`, `bookmarks.clock`, `reminders.clock` — nullable JSON text columns. Drizzle row types (`HomePageRow`, `Bookmark`, `Reminder`) gain `clock: VectorClock | null`. `NULL` is the `seedUnclocked` sentinel.

- [ ] **Step 1: Write the failing test.** Add to `apps/desktop/src/main/database/migrate.test.ts` a case that opens a fresh migrated `data.db` and asserts the `clock` column exists on each table:

```ts
it('0035 adds a clock column to home_pages/bookmarks/reminders', () => {
  const { db, close } = createTestDataDb() // runs drizzle-data migrations incl. 0035
  try {
    for (const table of ['home_pages', 'bookmarks', 'reminders']) {
      const cols = db.$client.prepare(`PRAGMA table_info(${table})`).all() as Array<{
        name: string
      }>
      expect(cols.map((c) => c.name)).toContain('clock')
    }
  } finally {
    close()
  }
})
```

(Import `createTestDataDb` from `@tests/utils/test-db`, matching the handler tests. If `migrate.test.ts` uses a different DB-open helper, mirror that file's existing setup instead.)

- [ ] **Step 2: Run it, expect FAIL.** Command: `pnpm --filter @memry/desktop test:main -- migrate`. Expected failure: `expected [ 'id', 'name', … ] to contain 'clock'`. If you hit `ERR_DLOPEN_FAILED`, run `pnpm --filter @memry/desktop rebuild:node` first.

- [ ] **Step 3: Minimal implementation.**
  1. Create `0035_sync_clocks_home_bookmark_reminder.sql` (mirror the additive style of `0026`/`0033`; `text` matches Drizzle `{ mode: 'json' }` storage):

```sql
ALTER TABLE `home_pages` ADD COLUMN `clock` text;--> statement-breakpoint
ALTER TABLE `bookmarks` ADD COLUMN `clock` text;--> statement-breakpoint
ALTER TABLE `reminders` ADD COLUMN `clock` text;
```

2. Append to `meta/_journal.json` `entries` array (after the idx-34 entry; `when` must exceed 34's `1783206622572` to satisfy `migrate-journal.test.ts`):

```json
{
  "idx": 35,
  "version": "6",
  "when": 1783900000000,
  "tag": "0035_sync_clocks_home_bookmark_reminder",
  "breakpoints": true
}
```

3. Add the column to each schema file. In `home-pages.ts` after the `widgets` field:

```ts
    clock: text('clock', { mode: 'json' }),
```

In `bookmarks.ts` after the `position` field (before `createdAt`):

```ts
    clock: text('clock', { mode: 'json' }),
```

In `reminders.ts` after the `snoozedUntil` field (before the timestamps block):

```ts
    clock: text('clock', { mode: 'json' }),
```

- [ ] **Step 4: Run tests, expect PASS.** Commands: `pnpm --filter @memry/desktop test:main -- migrate` → new case passes; `pnpm --filter @memry/desktop test:main -- migrate-journal` → monotonic guard still green; `pnpm typecheck` → row types include `clock`.

- [ ] **Step 5: Commit.** `git add apps/desktop/src/main/database/drizzle-data/0035_sync_clocks_home_bookmark_reminder.sql apps/desktop/src/main/database/drizzle-data/meta/_journal.json packages/db-schema/src/schema/home-pages.ts packages/db-schema/src/schema/bookmarks.ts packages/db-schema/src/schema/reminders.ts apps/desktop/src/main/database/migrate.test.ts && git commit -m "feat(db): add nullable clock column to home_pages/bookmarks/reminders (migration 0035)"`

---

### Task 5: Home-page item handler

**Files:**

- Create: `apps/desktop/src/main/sync/item-handlers/home-page-handler.ts`
- Create: `apps/desktop/src/main/sync/item-handlers/home-page-handler.test.ts`

**Interfaces:**

- Consumes: `HomePageSyncPayloadSchema`/`HomePageSyncPayload` (Task 2); `home_pages.clock` (Task 4); `BaseItemHandler`, `ApplyContext`, `ApplyResult`, `DrizzleDb` from `./base-handler`/`./types`; `increment` from `../vector-clock`; `SyncQueueManager` from `../queue`.
- Produces: `export const homePageHandler` implementing `SyncItemHandler<HomePageSyncPayload>` with `type = 'home_page'`. Emits IPC channel `'home:changed'` on apply.

- [ ] **Step 1: Write the failing test.** Create `home-page-handler.test.ts` (template: `folder-config-handler.test.ts`):

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { homePages } from '@memry/db-schema/schema/home-pages'
import type { HomePageSyncPayload } from '@memry/contracts/sync-payloads'
import type { VectorClock } from '@memry/contracts/sync-api'
import type { ApplyContext, DrizzleDb } from './types'

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import { homePageHandler } from './home-page-handler'

function makeCtx(testDb: TestDatabaseResult): ApplyContext {
  return { db: testDb.db as unknown as DrizzleDb, emit: vi.fn() }
}

describe('homePageHandler', () => {
  let testDb: TestDatabaseResult
  let ctx: ApplyContext

  beforeEach(() => {
    testDb = createTestDataDb()
    ctx = makeCtx(testDb)
    vi.clearAllMocks()
  })
  afterEach(() => testDb.close())

  it('inserts a new home page from a remote upsert', () => {
    const data: HomePageSyncPayload = {
      name: 'Home',
      icon: '🏠',
      position: 0,
      widgets: '[]',
      createdAt: '2026-07-14T00:00:00.000Z',
      updatedAt: '2026-07-14T00:00:00.000Z'
    }
    const result = homePageHandler.applyUpsert(ctx, 'hp_1', data, { 'device-B': 1 })
    expect(result).toBe('applied')
    const row = testDb.db.select().from(homePages).where(eq(homePages.id, 'hp_1')).get()
    expect(row?.name).toBe('Home')
    expect(ctx.emit).toHaveBeenCalledWith('home:changed', expect.anything())
  })

  it('skips a stale remote update when local clock is newer', () => {
    testDb.db
      .insert(homePages)
      .values({ id: 'hp_1', name: 'Local', widgets: '[]', clock: { 'device-A': 5 } as VectorClock })
      .run()
    const result = homePageHandler.applyUpsert(
      ctx,
      'hp_1',
      { name: 'Remote', widgets: '[]' },
      { 'device-A': 2 }
    )
    expect(result).toBe('skipped')
    const row = testDb.db.select().from(homePages).where(eq(homePages.id, 'hp_1')).get()
    expect(row?.name).toBe('Local')
  })

  it('seeds unclocked rows into the queue and stamps a clock', () => {
    testDb.db.insert(homePages).values({ id: 'hp_seed', name: 'Seed', widgets: '[]' }).run()
    const enqueue = vi.fn()
    const count = homePageHandler.seedUnclocked(testDb.db as unknown as DrizzleDb, 'device-A', {
      enqueue
    } as never)
    expect(count).toBe(1)
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'home_page', itemId: 'hp_seed' })
    )
    const row = testDb.db.select().from(homePages).where(eq(homePages.id, 'hp_seed')).get()
    expect(row?.clock).toEqual({ 'device-A': 1 })
  })
})
```

- [ ] **Step 2: Run it, expect FAIL.** Command: `pnpm --filter @memry/desktop test:main -- home-page-handler`. Expected failure: `Cannot find module './home-page-handler'`.

- [ ] **Step 3: Minimal implementation.** Create `home-page-handler.ts` (template: `tag-definition-handler.ts`):

```ts
import { eq, isNull } from 'drizzle-orm'
import { homePages } from '@memry/db-schema/schema/home-pages'
import { utcNow } from '@memry/shared/utc'
import { HomePageSyncPayloadSchema, type HomePageSyncPayload } from '@memry/contracts/sync-payloads'
import type { VectorClock } from '@memry/contracts/sync-api'
import type { SyncQueueManager } from '../queue'
import { increment } from '../vector-clock'
import { createLogger } from '../../lib/logger'
import { BaseItemHandler } from './base-handler'
import type { ApplyContext, ApplyResult, DrizzleDb } from './types'

const log = createLogger('HomePageHandler')
const CHANGED = 'home:changed'

class HomePageHandler extends BaseItemHandler<HomePageSyncPayload> {
  readonly type = 'home_page' as const
  readonly schema = HomePageSyncPayloadSchema

  applyUpsert(
    ctx: ApplyContext,
    itemId: string,
    data: HomePageSyncPayload,
    clock: VectorClock
  ): ApplyResult {
    return ctx.db.transaction((tx): ApplyResult => {
      const existing = tx.select().from(homePages).where(eq(homePages.id, itemId)).get()
      const remoteClock = Object.keys(clock).length > 0 ? clock : (data.clock ?? {})
      const now = utcNow()

      if (existing) {
        const resolution = this.resolveClock(existing.clock as VectorClock | null, remoteClock)
        if (resolution.action === 'skip') {
          log.info('Skipping stale remote home page update', { itemId })
          return 'skipped'
        }
        tx.update(homePages)
          .set({
            name: data.name ?? existing.name,
            icon: data.icon !== undefined ? data.icon : existing.icon,
            position: data.position ?? existing.position,
            widgets: data.widgets ?? existing.widgets,
            updatedAt: data.updatedAt ?? now,
            clock: resolution.mergedClock
          })
          .where(eq(homePages.id, itemId))
          .run()
        ctx.emit(CHANGED, { id: itemId })
        return resolution.action === 'merge' ? 'conflict' : 'applied'
      }

      tx.insert(homePages)
        .values({
          id: itemId,
          name: data.name ?? 'Home',
          icon: data.icon ?? null,
          position: data.position ?? 0,
          widgets: data.widgets ?? '[]',
          createdAt: data.createdAt ?? now,
          updatedAt: data.updatedAt ?? now,
          clock: remoteClock
        })
        .run()
      ctx.emit(CHANGED, { id: itemId })
      return 'applied'
    })
  }

  applyDelete(ctx: ApplyContext, itemId: string, clock?: VectorClock): 'applied' | 'skipped' {
    const existing = ctx.db.select().from(homePages).where(eq(homePages.id, itemId)).get()
    if (!existing) return 'skipped'
    if (clock && existing.clock) {
      const resolution = this.resolveClock(existing.clock as VectorClock | null, clock)
      if (resolution.action !== 'apply') {
        log.info('Skipping stale remote home page delete', { itemId })
        return 'skipped'
      }
    }
    ctx.db.delete(homePages).where(eq(homePages.id, itemId)).run()
    ctx.emit(CHANGED, { id: itemId })
    return 'applied'
  }

  fetchLocal(db: DrizzleDb, itemId: string): Record<string, unknown> | undefined {
    return db.select().from(homePages).where(eq(homePages.id, itemId)).get() as
      | Record<string, unknown>
      | undefined
  }

  buildPushPayload(db: DrizzleDb, itemId: string): string | null {
    const row = db.select().from(homePages).where(eq(homePages.id, itemId)).get()
    if (!row) return null
    const payload: HomePageSyncPayload = {
      name: row.name,
      icon: row.icon ?? null,
      position: row.position,
      widgets: row.widgets,
      clock: (row.clock as VectorClock) ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    }
    return JSON.stringify(payload)
  }

  seedUnclocked(db: DrizzleDb, deviceId: string, queue: SyncQueueManager): number {
    const items = db.select().from(homePages).where(isNull(homePages.clock)).all()
    for (const item of items) {
      const clock = increment({}, deviceId)
      db.update(homePages).set({ clock }).where(eq(homePages.id, item.id)).run()
      queue.enqueue({
        type: 'home_page',
        itemId: item.id,
        operation: 'create',
        payload: JSON.stringify({ ...item, clock }),
        priority: 0
      })
    }
    return items.length
  }
}

export const homePageHandler = new HomePageHandler()
```

- [ ] **Step 4: Run tests, expect PASS.** Command: `pnpm --filter @memry/desktop test:main -- home-page-handler` → `3 passed`.

- [ ] **Step 5: Commit.** `git add apps/desktop/src/main/sync/item-handlers/home-page-handler.ts apps/desktop/src/main/sync/item-handlers/home-page-handler.test.ts && git commit -m "feat(sync): add home_page item handler (doc-clock LWW)"`

---

### Task 6: Bookmark item handler (unique-key reconciliation)

**Files:**

- Create: `apps/desktop/src/main/sync/item-handlers/bookmark-handler.ts`
- Create: `apps/desktop/src/main/sync/item-handlers/bookmark-handler.test.ts`

**Interfaces:**

- Consumes: `BookmarkSyncPayloadSchema`/`BookmarkSyncPayload` (Task 2); `bookmarks` table + its `unique(item_type,item_id)` index; `bookmarks.clock` (Task 4).
- Produces: `export const bookmarkHandler` (`type = 'bookmark'`). Emits `'bookmarks:changed'`. On upsert, reconciles by the unique key so a second device applying the same logical bookmark under a different `id` does not violate `idx_bookmarks_unique_item`.

- [ ] **Step 1: Write the failing test.** Create `bookmark-handler.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { bookmarks } from '@memry/db-schema/schema/bookmarks'
import type { BookmarkSyncPayload } from '@memry/contracts/sync-payloads'
import type { ApplyContext, DrizzleDb } from './types'

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import { bookmarkHandler } from './bookmark-handler'

function makeCtx(testDb: TestDatabaseResult): ApplyContext {
  return { db: testDb.db as unknown as DrizzleDb, emit: vi.fn() }
}

describe('bookmarkHandler', () => {
  let testDb: TestDatabaseResult
  let ctx: ApplyContext
  beforeEach(() => {
    testDb = createTestDataDb()
    ctx = makeCtx(testDb)
    vi.clearAllMocks()
  })
  afterEach(() => testDb.close())

  it('inserts a new bookmark from a remote upsert', () => {
    const data: BookmarkSyncPayload = { itemType: 'note', itemId: 'note_1', position: 0 }
    expect(bookmarkHandler.applyUpsert(ctx, 'bm_1', data, { 'device-B': 1 })).toBe('applied')
    const row = testDb.db.select().from(bookmarks).where(eq(bookmarks.id, 'bm_1')).get()
    expect(row?.itemId).toBe('note_1')
    expect(ctx.emit).toHaveBeenCalledWith('bookmarks:changed', expect.anything())
  })

  it('reconciles a same-(itemType,itemId) bookmark instead of violating the unique index', () => {
    testDb.db
      .insert(bookmarks)
      .values({ id: 'bm_local', itemType: 'note', itemId: 'note_1', position: 0 })
      .run()
    // Different id, same logical target — must not throw a UNIQUE constraint error.
    const result = bookmarkHandler.applyUpsert(
      ctx,
      'bm_remote',
      { itemType: 'note', itemId: 'note_1', position: 3 },
      { 'device-B': 1 }
    )
    expect(result).toBe('applied')
    const rows = testDb.db
      .select()
      .from(bookmarks)
      .where(and(eq(bookmarks.itemType, 'note'), eq(bookmarks.itemId, 'note_1')))
      .all()
    expect(rows).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run it, expect FAIL.** Command: `pnpm --filter @memry/desktop test:main -- bookmark-handler`. Expected: `Cannot find module './bookmark-handler'`.

- [ ] **Step 3: Minimal implementation.** Create `bookmark-handler.ts`:

```ts
import { and, eq, isNull } from 'drizzle-orm'
import { bookmarks } from '@memry/db-schema/schema/bookmarks'
import { utcNow } from '@memry/shared/utc'
import { BookmarkSyncPayloadSchema, type BookmarkSyncPayload } from '@memry/contracts/sync-payloads'
import type { VectorClock } from '@memry/contracts/sync-api'
import type { SyncQueueManager } from '../queue'
import { increment } from '../vector-clock'
import { createLogger } from '../../lib/logger'
import { BaseItemHandler } from './base-handler'
import type { ApplyContext, ApplyResult, DrizzleDb } from './types'

const log = createLogger('BookmarkHandler')
const CHANGED = 'bookmarks:changed'

class BookmarkHandler extends BaseItemHandler<BookmarkSyncPayload> {
  readonly type = 'bookmark' as const
  readonly schema = BookmarkSyncPayloadSchema

  applyUpsert(
    ctx: ApplyContext,
    itemId: string,
    data: BookmarkSyncPayload,
    clock: VectorClock
  ): ApplyResult {
    return ctx.db.transaction((tx): ApplyResult => {
      const remoteClock = Object.keys(clock).length > 0 ? clock : (data.clock ?? {})
      const now = utcNow()

      const byId = tx.select().from(bookmarks).where(eq(bookmarks.id, itemId)).get()
      // Reconcile against the unique(item_type,item_id) index: a peer may hold the
      // same logical bookmark under a different id. Treat that row as the target.
      const byKey =
        !byId && data.itemType && data.itemId
          ? tx
              .select()
              .from(bookmarks)
              .where(and(eq(bookmarks.itemType, data.itemType), eq(bookmarks.itemId, data.itemId)))
              .get()
          : undefined
      const existing = byId ?? byKey

      if (existing) {
        const resolution = this.resolveClock(existing.clock as VectorClock | null, remoteClock)
        if (resolution.action === 'skip') {
          log.info('Skipping stale remote bookmark update', { itemId })
          return 'skipped'
        }
        tx.update(bookmarks)
          .set({ position: data.position ?? existing.position, clock: resolution.mergedClock })
          .where(eq(bookmarks.id, existing.id))
          .run()
        ctx.emit(CHANGED, { id: existing.id })
        return resolution.action === 'merge' ? 'conflict' : 'applied'
      }

      tx.insert(bookmarks)
        .values({
          id: itemId,
          itemType: data.itemType ?? '',
          itemId: data.itemId ?? '',
          position: data.position ?? 0,
          createdAt: data.createdAt ?? now,
          clock: remoteClock
        })
        .run()
      ctx.emit(CHANGED, { id: itemId })
      return 'applied'
    })
  }

  applyDelete(ctx: ApplyContext, itemId: string, clock?: VectorClock): 'applied' | 'skipped' {
    const existing = ctx.db.select().from(bookmarks).where(eq(bookmarks.id, itemId)).get()
    if (!existing) return 'skipped'
    if (clock && existing.clock) {
      const resolution = this.resolveClock(existing.clock as VectorClock | null, clock)
      if (resolution.action !== 'apply') {
        log.info('Skipping stale remote bookmark delete', { itemId })
        return 'skipped'
      }
    }
    ctx.db.delete(bookmarks).where(eq(bookmarks.id, itemId)).run()
    ctx.emit(CHANGED, { id: itemId })
    return 'applied'
  }

  fetchLocal(db: DrizzleDb, itemId: string): Record<string, unknown> | undefined {
    return db.select().from(bookmarks).where(eq(bookmarks.id, itemId)).get() as
      | Record<string, unknown>
      | undefined
  }

  buildPushPayload(db: DrizzleDb, itemId: string): string | null {
    const row = db.select().from(bookmarks).where(eq(bookmarks.id, itemId)).get()
    if (!row) return null
    const payload: BookmarkSyncPayload = {
      itemType: row.itemType,
      itemId: row.itemId,
      position: row.position,
      clock: (row.clock as VectorClock) ?? undefined,
      createdAt: row.createdAt
    }
    return JSON.stringify(payload)
  }

  seedUnclocked(db: DrizzleDb, deviceId: string, queue: SyncQueueManager): number {
    const items = db.select().from(bookmarks).where(isNull(bookmarks.clock)).all()
    for (const item of items) {
      const clock = increment({}, deviceId)
      db.update(bookmarks).set({ clock }).where(eq(bookmarks.id, item.id)).run()
      queue.enqueue({
        type: 'bookmark',
        itemId: item.id,
        operation: 'create',
        payload: JSON.stringify({ ...item, clock }),
        priority: 0
      })
    }
    return items.length
  }
}

export const bookmarkHandler = new BookmarkHandler()
```

- [ ] **Step 4: Run tests, expect PASS.** Command: `pnpm --filter @memry/desktop test:main -- bookmark-handler` → `2 passed`.

- [ ] **Step 5: Commit.** `git add apps/desktop/src/main/sync/item-handlers/bookmark-handler.ts apps/desktop/src/main/sync/item-handlers/bookmark-handler.test.ts && git commit -m "feat(sync): add bookmark item handler with unique-key reconciliation"`

---

### Task 7: Reminder item handler

**Files:**

- Create: `apps/desktop/src/main/sync/item-handlers/reminder-handler.ts`
- Create: `apps/desktop/src/main/sync/item-handlers/reminder-handler.test.ts`

**Interfaces:**

- Consumes: `ReminderSyncPayloadSchema`/`ReminderSyncPayload` (Task 2); `reminders` table + `reminders.clock` (Task 4).
- Produces: `export const reminderHandler` (`type = 'reminder'`). Emits `'reminders:changed'`. Full-row LWW. MUST NOT schedule OS notifications from the apply path — that stays a per-device concern (see risk note).

- [ ] **Step 1: Write the failing test.** Create `reminder-handler.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { reminders } from '@memry/db-schema/schema/reminders'
import type { ReminderSyncPayload } from '@memry/contracts/sync-payloads'
import type { ApplyContext, DrizzleDb } from './types'

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import { reminderHandler } from './reminder-handler'

function makeCtx(testDb: TestDatabaseResult): ApplyContext {
  return { db: testDb.db as unknown as DrizzleDb, emit: vi.fn() }
}

const basePayload: ReminderSyncPayload = {
  targetType: 'note',
  targetId: 'note_1',
  remindAt: '2026-07-15T09:00:00.000Z',
  status: 'pending'
}

describe('reminderHandler', () => {
  let testDb: TestDatabaseResult
  let ctx: ApplyContext
  beforeEach(() => {
    testDb = createTestDataDb()
    ctx = makeCtx(testDb)
    vi.clearAllMocks()
  })
  afterEach(() => testDb.close())

  it('inserts a reminder from a remote upsert', () => {
    expect(reminderHandler.applyUpsert(ctx, 'rem_1', basePayload, { 'device-B': 1 })).toBe(
      'applied'
    )
    const row = testDb.db.select().from(reminders).where(eq(reminders.id, 'rem_1')).get()
    expect(row?.status).toBe('pending')
    expect(ctx.emit).toHaveBeenCalledWith('reminders:changed', expect.anything())
  })

  it('applies a newer remote status (dismissed) over local', () => {
    testDb.db
      .insert(reminders)
      .values({ ...basePayload, id: 'rem_1', clock: { 'device-A': 1 } })
      .run()
    const result = reminderHandler.applyUpsert(
      ctx,
      'rem_1',
      { ...basePayload, status: 'dismissed', dismissedAt: '2026-07-15T10:00:00.000Z' },
      { 'device-A': 1, 'device-B': 1 }
    )
    expect(result).toBe('applied')
    const row = testDb.db.select().from(reminders).where(eq(reminders.id, 'rem_1')).get()
    expect(row?.status).toBe('dismissed')
  })
})
```

- [ ] **Step 2: Run it, expect FAIL.** Command: `pnpm --filter @memry/desktop test:main -- reminder-handler`. Expected: `Cannot find module './reminder-handler'`.

- [ ] **Step 3: Minimal implementation.** Create `reminder-handler.ts`:

```ts
import { eq, isNull } from 'drizzle-orm'
import { reminders } from '@memry/db-schema/schema/reminders'
import { utcNow } from '@memry/shared/utc'
import { ReminderSyncPayloadSchema, type ReminderSyncPayload } from '@memry/contracts/sync-payloads'
import type { VectorClock } from '@memry/contracts/sync-api'
import type { SyncQueueManager } from '../queue'
import { increment } from '../vector-clock'
import { createLogger } from '../../lib/logger'
import { BaseItemHandler } from './base-handler'
import type { ApplyContext, ApplyResult, DrizzleDb } from './types'

const log = createLogger('ReminderHandler')
const CHANGED = 'reminders:changed'

// Prefer remote value when present (including explicit null); else keep local.
function pick<T>(remote: T | undefined, local: T): T {
  return remote !== undefined ? remote : local
}

class ReminderHandler extends BaseItemHandler<ReminderSyncPayload> {
  readonly type = 'reminder' as const
  readonly schema = ReminderSyncPayloadSchema

  applyUpsert(
    ctx: ApplyContext,
    itemId: string,
    data: ReminderSyncPayload,
    clock: VectorClock
  ): ApplyResult {
    return ctx.db.transaction((tx): ApplyResult => {
      const existing = tx.select().from(reminders).where(eq(reminders.id, itemId)).get()
      const remoteClock = Object.keys(clock).length > 0 ? clock : (data.clock ?? {})
      const now = utcNow()

      if (existing) {
        const resolution = this.resolveClock(existing.clock as VectorClock | null, remoteClock)
        if (resolution.action === 'skip') {
          log.info('Skipping stale remote reminder update', { itemId })
          return 'skipped'
        }
        tx.update(reminders)
          .set({
            targetType: data.targetType ?? existing.targetType,
            targetId: data.targetId ?? existing.targetId,
            remindAt: data.remindAt ?? existing.remindAt,
            highlightText: pick(data.highlightText, existing.highlightText),
            highlightStart: pick(data.highlightStart, existing.highlightStart),
            highlightEnd: pick(data.highlightEnd, existing.highlightEnd),
            anchorId: pick(data.anchorId, existing.anchorId),
            title: pick(data.title, existing.title),
            note: pick(data.note, existing.note),
            status: data.status ?? existing.status,
            triggeredAt: pick(data.triggeredAt, existing.triggeredAt),
            dismissedAt: pick(data.dismissedAt, existing.dismissedAt),
            snoozedUntil: pick(data.snoozedUntil, existing.snoozedUntil),
            modifiedAt: data.modifiedAt ?? now,
            clock: resolution.mergedClock
          })
          .where(eq(reminders.id, itemId))
          .run()
        ctx.emit(CHANGED, { id: itemId })
        return resolution.action === 'merge' ? 'conflict' : 'applied'
      }

      tx.insert(reminders)
        .values({
          id: itemId,
          targetType: data.targetType ?? 'note',
          targetId: data.targetId ?? '',
          remindAt: data.remindAt ?? now,
          highlightText: data.highlightText ?? null,
          highlightStart: data.highlightStart ?? null,
          highlightEnd: data.highlightEnd ?? null,
          anchorId: data.anchorId ?? null,
          title: data.title ?? null,
          note: data.note ?? null,
          status: data.status ?? 'pending',
          triggeredAt: data.triggeredAt ?? null,
          dismissedAt: data.dismissedAt ?? null,
          snoozedUntil: data.snoozedUntil ?? null,
          createdAt: data.createdAt ?? now,
          modifiedAt: data.modifiedAt ?? now,
          clock: remoteClock
        })
        .run()
      ctx.emit(CHANGED, { id: itemId })
      return 'applied'
    })
  }

  applyDelete(ctx: ApplyContext, itemId: string, clock?: VectorClock): 'applied' | 'skipped' {
    const existing = ctx.db.select().from(reminders).where(eq(reminders.id, itemId)).get()
    if (!existing) return 'skipped'
    if (clock && existing.clock) {
      const resolution = this.resolveClock(existing.clock as VectorClock | null, clock)
      if (resolution.action !== 'apply') {
        log.info('Skipping stale remote reminder delete', { itemId })
        return 'skipped'
      }
    }
    ctx.db.delete(reminders).where(eq(reminders.id, itemId)).run()
    ctx.emit(CHANGED, { id: itemId })
    return 'applied'
  }

  fetchLocal(db: DrizzleDb, itemId: string): Record<string, unknown> | undefined {
    return db.select().from(reminders).where(eq(reminders.id, itemId)).get() as
      | Record<string, unknown>
      | undefined
  }

  buildPushPayload(db: DrizzleDb, itemId: string): string | null {
    const row = db.select().from(reminders).where(eq(reminders.id, itemId)).get()
    if (!row) return null
    const payload: ReminderSyncPayload = {
      targetType: row.targetType,
      targetId: row.targetId,
      remindAt: row.remindAt,
      highlightText: row.highlightText,
      highlightStart: row.highlightStart,
      highlightEnd: row.highlightEnd,
      anchorId: row.anchorId,
      title: row.title,
      note: row.note,
      status: row.status,
      triggeredAt: row.triggeredAt,
      dismissedAt: row.dismissedAt,
      snoozedUntil: row.snoozedUntil,
      clock: (row.clock as VectorClock) ?? undefined,
      createdAt: row.createdAt,
      modifiedAt: row.modifiedAt
    }
    return JSON.stringify(payload)
  }

  seedUnclocked(db: DrizzleDb, deviceId: string, queue: SyncQueueManager): number {
    const items = db.select().from(reminders).where(isNull(reminders.clock)).all()
    for (const item of items) {
      const clock = increment({}, deviceId)
      db.update(reminders).set({ clock }).where(eq(reminders.id, item.id)).run()
      queue.enqueue({
        type: 'reminder',
        itemId: item.id,
        operation: 'create',
        payload: JSON.stringify({ ...item, clock }),
        priority: 0
      })
    }
    return items.length
  }
}

export const reminderHandler = new ReminderHandler()
```

- [ ] **Step 4: Run tests, expect PASS.** Command: `pnpm --filter @memry/desktop test:main -- reminder-handler` → `2 passed`.

- [ ] **Step 5: Commit.** `git add apps/desktop/src/main/sync/item-handlers/reminder-handler.ts apps/desktop/src/main/sync/item-handlers/reminder-handler.test.ts && git commit -m "feat(sync): add reminder item handler (full-row LWW)"`

---

### Task 8: Register handlers in the item-handlers registry

**Files:**

- Modify: `apps/desktop/src/main/sync/item-handlers/index.ts` (imports lines 5–19; `handlers` Map lines 24–40)
- Test: `apps/desktop/src/main/sync/item-handlers/index.test.ts` (Create if absent)

**Interfaces:**

- Consumes: `homePageHandler`, `bookmarkHandler`, `reminderHandler` (Tasks 5–7); `getHandler`, `getRemoteSyncAdapter` (existing).
- Produces: `getHandler('home_page'|'bookmark'|'reminder')` returns the handler; `getRemoteSyncAdapter(...)` returns a wired `DesktopRemoteSyncAdapter`.

- [ ] **Step 1: Write the failing test.** Create `index.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { getHandler, getRemoteSyncAdapter } from './index'

describe('item-handler registry (D6)', () => {
  it.each(['home_page', 'bookmark', 'reminder'] as const)('registers %s', (type) => {
    expect(getHandler(type)?.type).toBe(type)
    expect(getRemoteSyncAdapter(type)?.type).toBe(type)
  })
})
```

- [ ] **Step 2: Run it, expect FAIL.** Command: `pnpm --filter @memry/desktop test:main -- item-handlers/index`. Expected: `expected undefined to be 'home_page'`.

- [ ] **Step 3: Minimal implementation.** In `index.ts` add imports after line 19:

```ts
import { homePageHandler } from './home-page-handler'
import { bookmarkHandler } from './bookmark-handler'
import { reminderHandler } from './reminder-handler'
```

And add to the `handlers` Map (after the `agent_message` entry, before the closing `])`):

```ts
;(['home_page', homePageHandler], ['bookmark', bookmarkHandler], ['reminder', reminderHandler])
```

- [ ] **Step 4: Run tests, expect PASS.** Command: `pnpm --filter @memry/desktop test:main -- item-handlers/index` → `3 passed`.

- [ ] **Step 5: Commit.** `git add apps/desktop/src/main/sync/item-handlers/index.ts apps/desktop/src/main/sync/item-handlers/index.test.ts && git commit -m "feat(sync): register home_page/bookmark/reminder in handler registry"`

---

### Task 9: Sync services (RecordSyncController wrappers)

**Files:**

- Create: `apps/desktop/src/main/sync/home-page-sync.ts`
- Create: `apps/desktop/src/main/sync/bookmark-sync.ts`
- Create: `apps/desktop/src/main/sync/reminder-sync.ts`
- Test: `apps/desktop/src/main/sync/home-page-sync.test.ts`

**Interfaces:**

- Consumes: `RecordSyncController`, `incrementClock`, `withIncrementedClock` from `@memry/sync-core`; the three tables; `SyncQueueManager`.
- Produces (each file): `init{X}SyncService(deps)`, `get{X}SyncService()`, `reset{X}SyncService()`, and a class with `enqueueCreate(id)`, `enqueueUpdate(id)`, `enqueueDelete(id, snapshotPayload?)`. `X` ∈ `HomePage`/`Bookmark`/`Reminder`. `applyLocalChange` increments the row's `clock`; `buildDeletePayload` uses the snapshot argument.

- [ ] **Step 1: Write the failing test.** Create `home-page-sync.test.ts` (proves clock increment + enqueue; the other two are structurally identical and covered by the runtime wiring test in Task 10):

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { homePages } from '@memry/db-schema/schema/home-pages'
import type { SyncQueueManager } from './queue'
import { initHomePageSyncService, resetHomePageSyncService } from './home-page-sync'

describe('HomePageSyncService', () => {
  let testDb: TestDatabaseResult
  let enqueue: ReturnType<typeof vi.fn>
  beforeEach(() => {
    testDb = createTestDataDb()
    enqueue = vi.fn()
    testDb.db.insert(homePages).values({ id: 'hp_1', name: 'Home', widgets: '[]' }).run()
  })
  afterEach(() => {
    resetHomePageSyncService()
    testDb.close()
  })

  it('increments the row clock and enqueues an update payload', () => {
    const svc = initHomePageSyncService({
      queue: { enqueue } as unknown as SyncQueueManager,
      db: testDb.db as never,
      getDeviceId: () => 'device-A'
    })
    svc.enqueueUpdate('hp_1')
    const row = testDb.db.select().from(homePages).where(eq(homePages.id, 'hp_1')).get()
    expect(row?.clock).toEqual({ 'device-A': 1 })
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'home_page', itemId: 'hp_1' })
    )
  })
})
```

- [ ] **Step 2: Run it, expect FAIL.** Command: `pnpm --filter @memry/desktop test:main -- home-page-sync`. Expected: `Cannot find module './home-page-sync'`.

- [ ] **Step 3: Minimal implementation.** Create `home-page-sync.ts` (template: `tag-definition-sync.ts`, keyed by `homePages.id`):

```ts
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { eq } from 'drizzle-orm'
import type * as schema from '@memry/db-schema/data-schema'
import { homePages } from '@memry/db-schema/schema/home-pages'
import type { VectorClock } from '@memry/contracts/sync-api'
import { RecordSyncController, incrementClock, withIncrementedClock } from '@memry/sync-core'
import type { SyncQueueManager } from './queue'

type DrizzleDb = BetterSQLite3Database<typeof schema>

interface HomePageSyncDeps {
  queue: SyncQueueManager
  db: DrizzleDb
  getDeviceId: () => string | null
}

let instance: HomePageSyncService | null = null

export function initHomePageSyncService(deps: HomePageSyncDeps): HomePageSyncService {
  instance = new HomePageSyncService(deps)
  return instance
}
export function getHomePageSyncService(): HomePageSyncService | null {
  return instance
}
export function resetHomePageSyncService(): void {
  instance = null
}

export class HomePageSyncService {
  private controller: RecordSyncController<Record<string, unknown>, [], [string?]>

  constructor(deps: HomePageSyncDeps) {
    this.controller = new RecordSyncController({
      type: 'home_page',
      queue: deps.queue,
      getDeviceId: deps.getDeviceId,
      load: (id) =>
        deps.db.select().from(homePages).where(eq(homePages.id, id)).get() as
          | Record<string, unknown>
          | undefined,
      applyLocalChange: ({ itemId, local, deviceId }) => {
        const existingClock = (local.clock as VectorClock) ?? {}
        const newClock = incrementClock(existingClock, deviceId)
        deps.db.update(homePages).set({ clock: newClock }).where(eq(homePages.id, itemId)).run()
        return { ...local, clock: newClock }
      },
      serialize: (local) => local,
      buildDeletePayload: ({ itemId, extra, deviceId }) => {
        const snapshot = extra[0]
        if (snapshot) return withIncrementedClock(snapshot, deviceId)
        return JSON.stringify({ id: itemId, clock: incrementClock({}, deviceId) })
      }
    })
  }

  enqueueCreate(id: string): void {
    this.controller.enqueueCreate(id)
  }
  enqueueUpdate(id: string): void {
    this.controller.enqueueUpdate(id)
  }
  enqueueDelete(id: string, snapshotPayload?: string): void {
    this.controller.enqueueDelete(id, snapshotPayload)
  }
}
```

Create `bookmark-sync.ts` — identical shape, replace: `homePages`→`bookmarks`, `home_page`→`bookmark`, class/fn names `HomePage`→`Bookmark`, and the minimal delete fallback `{ id: itemId, clock: ... }`.
Create `reminder-sync.ts` — identical shape, replace with `reminders`/`reminder`/`Reminder`.

- [ ] **Step 4: Run tests, expect PASS.** Command: `pnpm --filter @memry/desktop test:main -- home-page-sync` → `1 passed`. Then `pnpm typecheck`.

- [ ] **Step 5: Commit.** `git add apps/desktop/src/main/sync/home-page-sync.ts apps/desktop/src/main/sync/bookmark-sync.ts apps/desktop/src/main/sync/reminder-sync.ts apps/desktop/src/main/sync/home-page-sync.test.ts && git commit -m "feat(sync): add home_page/bookmark/reminder RecordSyncController services"`

---

### Task 10: Wire services into local-mutations registry + runtime lifecycle

**Files:**

- Modify: `apps/desktop/src/main/sync/local-mutations.ts` (imports lines 11–23; registry array lines 29–280)
- Modify: `apps/desktop/src/main/sync/runtime.ts` (imports lines 23–44; `resetSyncServiceSingletons` lines 112–126; init block lines 250–286; `adapters` array lines 288–358)
- Test: `apps/desktop/src/main/sync/local-mutations.test.ts` (Create if absent)

**Interfaces:**

- Consumes: `getHomePageSyncService`/`getBookmarkSyncService`/`getReminderSyncService` and their `init*`/`reset*` (Task 9); `getRemoteSyncAdapter` (Task 8); `createSyncAdapterRegistry`.
- Produces: `enqueueLocalSyncCreate/Update/Delete('home_page'|'bookmark'|'reminder', id, ...)` route to the services; runtime inits/resets them and registers their remote adapters so pulls apply.

- [ ] **Step 1: Write the failing test.** Create `local-mutations.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('../database', () => ({ getDatabase: () => ({}) }))

const enqueueCreate = vi.fn()
vi.mock('./home-page-sync', () => ({
  getHomePageSyncService: () => ({ enqueueCreate, enqueueUpdate: vi.fn(), enqueueDelete: vi.fn() })
}))
vi.mock('./bookmark-sync', () => ({ getBookmarkSyncService: () => null }))
vi.mock('./reminder-sync', () => ({ getReminderSyncService: () => null }))

import { enqueueLocalSyncCreate } from './local-mutations'

afterEach(() => vi.clearAllMocks())

describe('local-mutations D6 adapters', () => {
  it('routes home_page create to the home page sync service', () => {
    enqueueLocalSyncCreate('home_page', 'hp_1')
    expect(enqueueCreate).toHaveBeenCalledWith('hp_1')
  })

  it('is a safe no-op when a service is uninitialized (offline)', () => {
    expect(() => enqueueLocalSyncCreate('bookmark', 'bm_1')).not.toThrow()
  })
})
```

(Mock only the modules `local-mutations` imports; keep the other `get*SyncService` mocks minimal. If `local-mutations` imports additional services at load time that break the mock graph, add matching `vi.mock` stubs returning `null`.)

- [ ] **Step 2: Run it, expect FAIL.** Command: `pnpm --filter @memry/desktop test:main -- local-mutations`. Expected: `enqueueCreate` not called / registry has no `home_page` adapter → `Missing local sync adapter` warn path, assertion fails.

- [ ] **Step 3: Minimal implementation.**
  1. In `local-mutations.ts` add imports (after line 23):

```ts
import { getHomePageSyncService } from './home-page-sync'
import { getBookmarkSyncService } from './bookmark-sync'
import { getReminderSyncService } from './reminder-sync'
```

2. Append three entries to the `createSyncAdapterRegistry([...])` array (after the `calendar_external_event` entry, before the closing `])`). Home page (reorder emits per-id updates, so `enqueueUpdate` must be present):

```ts
  {
    type: 'home_page',
    kind: 'record',
    local: {
      enqueueCreate(itemId: string): void {
        getHomePageSyncService()?.enqueueCreate(itemId)
      },
      enqueueUpdate(itemId: string): void {
        getHomePageSyncService()?.enqueueUpdate(itemId)
      },
      enqueueDelete(itemId: string, snapshotPayload?: string): void {
        getHomePageSyncService()?.enqueueDelete(itemId, snapshotPayload)
      }
    }
  },
  {
    type: 'bookmark',
    kind: 'record',
    local: {
      enqueueCreate(itemId: string): void {
        getBookmarkSyncService()?.enqueueCreate(itemId)
      },
      enqueueUpdate(itemId: string): void {
        getBookmarkSyncService()?.enqueueUpdate(itemId)
      },
      enqueueDelete(itemId: string, snapshotPayload?: string): void {
        getBookmarkSyncService()?.enqueueDelete(itemId, snapshotPayload)
      }
    }
  },
  {
    type: 'reminder',
    kind: 'record',
    local: {
      enqueueCreate(itemId: string): void {
        getReminderSyncService()?.enqueueCreate(itemId)
      },
      enqueueUpdate(itemId: string): void {
        getReminderSyncService()?.enqueueUpdate(itemId)
      },
      enqueueDelete(itemId: string, snapshotPayload?: string): void {
        getReminderSyncService()?.enqueueDelete(itemId, snapshotPayload)
      }
    }
  }
```

3. In `runtime.ts` add imports (after line 44):

```ts
import { initHomePageSyncService, resetHomePageSyncService } from './home-page-sync'
import { initBookmarkSyncService, resetBookmarkSyncService } from './bookmark-sync'
import { initReminderSyncService, resetReminderSyncService } from './reminder-sync'
```

4. In `resetSyncServiceSingletons()` (lines 112–126) add:

```ts
resetHomePageSyncService()
resetBookmarkSyncService()
resetReminderSyncService()
```

5. In the init block (after `calendarExternalEventSync`, ~line 286) add:

```ts
const homePageSync = initHomePageSyncService({ queue, db: runtimeSyncDb, getDeviceId })
const bookmarkSync = initBookmarkSyncService({ queue, db: runtimeSyncDb, getDeviceId })
const reminderSync = initReminderSyncService({ queue, db: runtimeSyncDb, getDeviceId })
```

6. In the `adapters = createSyncAdapterRegistry([...])` array (before the closing `])` at ~line 358) add:

```ts
        {
          type: 'home_page',
          kind: 'record',
          local: homePageSync,
          remote: getRemoteSyncAdapter('home_page')
        },
        {
          type: 'bookmark',
          kind: 'record',
          local: bookmarkSync,
          remote: getRemoteSyncAdapter('bookmark')
        },
        {
          type: 'reminder',
          kind: 'record',
          local: reminderSync,
          remote: getRemoteSyncAdapter('reminder')
        }
```

- [ ] **Step 4: Run tests, expect PASS.** Commands: `pnpm --filter @memry/desktop test:main -- local-mutations` → `2 passed`; `pnpm typecheck`; `pnpm --filter @memry/desktop test:main` (full main suite, confirm no runtime-wiring regressions). If `ERR_DLOPEN_FAILED`, run `pnpm --filter @memry/desktop rebuild:node`.

- [ ] **Step 5: Commit.** `git add apps/desktop/src/main/sync/local-mutations.ts apps/desktop/src/main/sync/runtime.ts apps/desktop/src/main/sync/local-mutations.test.ts && git commit -m "feat(sync): wire home_page/bookmark/reminder services into local-mutations and runtime"`

---

### Task 11: Emit-on-mutation — home pages

**Files:**

- Modify: `apps/desktop/src/main/ipc/home-page-handlers.ts` (`makeHomePageHandlers` create/update/delete/reorder, lines 66–104)
- Test: `apps/desktop/src/main/ipc/home-page-handlers.test.ts` (Create if absent)

**Interfaces:**

- Consumes: `enqueueLocalSyncCreate/Update/Delete` from `../sync/local-mutations` (Task 10); `getHomePage` for the delete snapshot.
- Produces: home-page mutations enqueue matching sync operations. Reorder enqueues an update per affected id.

- [ ] **Step 1: Write the failing test.** Create `home-page-handlers.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'

const create = vi.fn()
const update = vi.fn()
const del = vi.fn()
vi.mock('../sync/local-mutations', () => ({
  enqueueLocalSyncCreate: (...a: unknown[]) => create(...a),
  enqueueLocalSyncUpdate: (...a: unknown[]) => update(...a),
  enqueueLocalSyncDelete: (...a: unknown[]) => del(...a)
}))

import { makeHomePageHandlers } from './home-page-handlers'

describe('home-page emit-on-mutation', () => {
  let testDb: TestDatabaseResult
  beforeEach(() => {
    testDb = createTestDataDb()
    vi.clearAllMocks()
  })
  afterEach(() => testDb.close())

  it('enqueues a create after creating a home page', async () => {
    const h = makeHomePageHandlers(testDb.db as never)
    const page = await h.create({ name: 'Home', position: 0, widgets: [] })
    expect(create).toHaveBeenCalledWith('home_page', page.id)
  })

  it('enqueues a delete with a snapshot payload', async () => {
    const h = makeHomePageHandlers(testDb.db as never)
    const page = await h.create({ name: 'Home', position: 0, widgets: [] })
    create.mockClear()
    await h.delete(page.id)
    expect(del).toHaveBeenCalledWith('home_page', page.id, expect.any(String))
  })
})
```

- [ ] **Step 2: Run it, expect FAIL.** Command: `pnpm --filter @memry/desktop test:main -- home-page-handlers`. Expected: `create` mock not called.

- [ ] **Step 3: Minimal implementation.** In `home-page-handlers.ts` add import after line 21:

```ts
import {
  enqueueLocalSyncCreate,
  enqueueLocalSyncUpdate,
  enqueueLocalSyncDelete
} from '../sync/local-mutations'
```

In `makeHomePageHandlers`, edit the mutation methods:

```ts
    create: async (input: unknown): Promise<HomePage> => {
      const data = HomePageCreateSchema.parse(input)
      const row = insertHomePage(db, {
        id: nanoid(),
        name: data.name,
        icon: data.icon ?? null,
        position: data.position,
        widgets: JSON.stringify(data.widgets)
      })
      enqueueLocalSyncCreate('home_page', row.id)
      return rowToHomePage(row)
    },
    update: async (input: unknown): Promise<HomePage> => {
      const data = HomePageUpdateSchema.parse(input)
      const row = updateHomePage(db, data.id, {
        name: data.name,
        icon: data.icon,
        position: data.position,
        widgets: data.widgets !== undefined ? JSON.stringify(data.widgets) : undefined
      })
      if (!row) throw new Error(`Home page ${data.id} not found`)
      enqueueLocalSyncUpdate('home_page', row.id)
      return rowToHomePage(row)
    },
    delete: async (id: string): Promise<{ success: boolean }> => {
      // Snapshot before deletion so the sync delete carries a clocked payload.
      const snapshot = getHomePage(db, id)
      const success = deleteHomePage(db, id)
      if (success && snapshot) {
        enqueueLocalSyncDelete('home_page', id, JSON.stringify(snapshot))
      }
      return { success }
    },
    reorder: async (input: unknown): Promise<{ success: boolean }> => {
      const { ids } = HomePageReorderSchema.parse(input)
      reorderHomePages(db, ids)
      // Reorder rewrites positions across rows; coalesced by itemId in the queue.
      for (const id of ids) enqueueLocalSyncUpdate('home_page', id)
      return { success: true }
    }
```

- [ ] **Step 4: Run tests, expect PASS.** Command: `pnpm --filter @memry/desktop test:main -- home-page-handlers` → `2 passed`.

- [ ] **Step 5: Commit.** `git add apps/desktop/src/main/ipc/home-page-handlers.ts apps/desktop/src/main/ipc/home-page-handlers.test.ts && git commit -m "feat(home): emit sync mutations on home page create/update/delete/reorder"`

---

### Task 12: Emit-on-mutation — bookmarks

**Files:**

- Modify: `apps/desktop/src/main/ipc/bookmarks-handlers.ts` (CREATE lines 159–187, DELETE 190–210, TOGGLE 255–283, REORDER 299–311)
- Test: `apps/desktop/src/main/ipc/bookmarks-handlers.test.ts` (Create if absent)

**Interfaces:**

- Consumes: `enqueueLocalSyncCreate/Update/Delete` (Task 10); the `bookmarkQueries` store for snapshots.
- Produces: bookmark create/toggle-create enqueue `bookmark` create; delete/toggle-delete enqueue `bookmark` delete with a snapshot; reorder enqueues per-id updates. Because `registerBookmarksHandlers` wires `ipcMain.handle` inline, extract the mutation bodies into small helpers so they are unit-testable, OR assert via the exported query layer. Simplest testable seam: add and export a `bookmarkSyncEffects` helper used by the handlers.

- [ ] **Step 1: Write the failing test.** Create `bookmarks-handlers.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const create = vi.fn()
const del = vi.fn()
vi.mock('../sync/local-mutations', () => ({
  enqueueLocalSyncCreate: (...a: unknown[]) => create(...a),
  enqueueLocalSyncUpdate: vi.fn(),
  enqueueLocalSyncDelete: (...a: unknown[]) => del(...a)
}))

import { emitBookmarkCreated, emitBookmarkDeleted } from './bookmarks-handlers'
import type { Bookmark } from '@memry/contracts/bookmarks-api'

const bm: Bookmark = { id: 'bm_1', itemType: 'note', itemId: 'note_1', position: 0, createdAt: 'x' }

beforeEach(() => vi.clearAllMocks())

describe('bookmark sync effects', () => {
  it('enqueues a create for a new bookmark', () => {
    emitBookmarkCreated(bm)
    expect(create).toHaveBeenCalledWith('bookmark', 'bm_1')
  })
  it('enqueues a delete with a snapshot payload', () => {
    emitBookmarkDeleted(bm)
    expect(del).toHaveBeenCalledWith('bookmark', 'bm_1', expect.any(String))
  })
})
```

- [ ] **Step 2: Run it, expect FAIL.** Command: `pnpm --filter @memry/desktop test:main -- bookmarks-handlers`. Expected: `emitBookmarkCreated is not exported`.

- [ ] **Step 3: Minimal implementation.** In `bookmarks-handlers.ts` add import after line 27:

```ts
import { enqueueLocalSyncCreate, enqueueLocalSyncDelete } from '../sync/local-mutations'
```

Add two exported helpers near `emitBookmarkEvent`:

```ts
export function emitBookmarkCreated(bookmark: Bookmark): void {
  enqueueLocalSyncCreate('bookmark', bookmark.id)
}

export function emitBookmarkDeleted(bookmark: Bookmark): void {
  // Snapshot the row so the sync delete carries a clocked payload.
  enqueueLocalSyncDelete('bookmark', bookmark.id, JSON.stringify(bookmark))
}
```

Call them from the handlers: after `emitBookmarkEvent(...CREATED, { bookmark })` in CREATE add `emitBookmarkCreated(bookmark)`; in DELETE after `bookmarkQueries.deleteBookmark(db, id)` add `emitBookmarkDeleted(bookmark)`; in TOGGLE, in the create branch add `emitBookmarkCreated(result.bookmark)` and in the delete branch add `emitBookmarkDeleted(existing)`.

- [ ] **Step 4: Run tests, expect PASS.** Command: `pnpm --filter @memry/desktop test:main -- bookmarks-handlers` → `2 passed`.

- [ ] **Step 5: Commit.** `git add apps/desktop/src/main/ipc/bookmarks-handlers.ts apps/desktop/src/main/ipc/bookmarks-handlers.test.ts && git commit -m "feat(bookmarks): emit sync mutations on bookmark create/delete/toggle"`

---

### Task 13: Emit-on-mutation — reminders

**Files:**

- Modify: `apps/desktop/src/main/ipc/reminder-handlers.ts` (create 46–56, update 59–72, delete 75–86, dismiss 153–165, snooze 168–181)
- Test: `apps/desktop/src/main/ipc/reminder-handlers.test.ts` (Create if absent)

**Interfaces:**

- Consumes: `enqueueLocalSyncCreate/Update/Delete` (Task 10); `remindersService.getReminder` for the delete snapshot.
- Produces: reminder create → sync create; update/dismiss/snooze → sync update; delete → sync delete with snapshot. OS-notification scheduling is untouched (stays per-device). Extract two exported helpers for testability.

- [ ] **Step 1: Write the failing test.** Create `reminder-handlers.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const create = vi.fn()
const update = vi.fn()
const del = vi.fn()
vi.mock('../sync/local-mutations', () => ({
  enqueueLocalSyncCreate: (...a: unknown[]) => create(...a),
  enqueueLocalSyncUpdate: (...a: unknown[]) => update(...a),
  enqueueLocalSyncDelete: (...a: unknown[]) => del(...a)
}))

import { emitReminderMutated, emitReminderDeleted } from './reminder-handlers'

beforeEach(() => vi.clearAllMocks())

describe('reminder sync effects', () => {
  it('enqueues a create on create', () => {
    emitReminderMutated('rem_1', 'create')
    expect(create).toHaveBeenCalledWith('reminder', 'rem_1')
  })
  it('enqueues an update on dismiss/snooze/update', () => {
    emitReminderMutated('rem_1', 'update')
    expect(update).toHaveBeenCalledWith('reminder', 'rem_1')
  })
  it('enqueues a delete with a snapshot', () => {
    emitReminderDeleted('rem_1', '{"id":"rem_1"}')
    expect(del).toHaveBeenCalledWith('reminder', 'rem_1', '{"id":"rem_1"}')
  })
})
```

- [ ] **Step 2: Run it, expect FAIL.** Command: `pnpm --filter @memry/desktop test:main -- reminder-handlers`. Expected: `emitReminderMutated is not exported`.

- [ ] **Step 3: Minimal implementation.** In `reminder-handlers.ts` add import after line 26:

```ts
import {
  enqueueLocalSyncCreate,
  enqueueLocalSyncUpdate,
  enqueueLocalSyncDelete
} from '../sync/local-mutations'
```

Add exported helpers:

```ts
export function emitReminderMutated(id: string, op: 'create' | 'update'): void {
  if (op === 'create') enqueueLocalSyncCreate('reminder', id)
  else enqueueLocalSyncUpdate('reminder', id)
}

export function emitReminderDeleted(id: string, snapshotPayload: string): void {
  enqueueLocalSyncDelete('reminder', id, snapshotPayload)
}
```

Wire them: in CREATE after `const reminder = remindersService.createReminder(input)` add `emitReminderMutated(reminder.id, 'create')`; in UPDATE (after non-null reminder) add `emitReminderMutated(reminder.id, 'update')`; in DISMISS and SNOOZE likewise `emitReminderMutated(reminder.id, 'update')`; in DELETE snapshot before deleting:

```ts
createStringHandler((id) => {
  ensureDb()
  const snapshot = remindersService.getReminder(id)
  const deleted = remindersService.deleteReminder(id)
  if (!deleted) {
    return { success: false, error: 'Reminder not found' }
  }
  if (snapshot) emitReminderDeleted(id, JSON.stringify(snapshot))
  return { success: true }
})
```

- [ ] **Step 4: Run tests, expect PASS.** Command: `pnpm --filter @memry/desktop test:main -- reminder-handlers` → `3 passed`.

- [ ] **Step 5: Commit.** `git add apps/desktop/src/main/ipc/reminder-handlers.ts apps/desktop/src/main/ipc/reminder-handlers.test.ts && git commit -m "feat(reminders): emit sync mutations on reminder create/update/delete/dismiss/snooze"`

---

### Task 14: D8 — widen the settings-sync PUSH allowlist

**Files:**

- Modify: `apps/desktop/src/main/ipc/settings-handlers.ts` (add per-group syncable-field lists near line 69; call `syncSettingsUpdates` in `SET_EDITOR_SETTINGS` ~778, `SET_TASK_SETTINGS` ~788, `SET_KEYBOARD_SETTINGS` ~797, `SET_CALENDAR_SETTINGS` ~847)
- Test: `apps/desktop/src/main/settings/runtime-effects.test.ts` (Create if absent — exercises the shared `syncSettingsUpdates` fan-out with the new allowlists)

**Interfaces:**

- Consumes: `syncSettingsUpdates(groupKey, updates, syncableFields)` from `../settings/runtime-effects` (existing); `syncSettingsFieldUpdate` → `SettingsSyncManager.updateField` (group-agnostic; inbound `mergeRemote` already tolerant, no server/contract change).
- Produces: editor/tasks/calendar/keyboard field mutations now push. Allowlists (audited to contain NO device-local values — no window bounds, no filesystem paths):
  - `EDITOR_SYNCABLE_FIELDS = ['width', 'toolbarMode']`
  - `TASK_SYNCABLE_FIELDS = ['defaultProjectId', 'defaultSortOrder', 'defaultView', 'staleInboxDays']`
  - `KEYBOARD_SYNCABLE_FIELDS = ['overrides', 'globalCapture']`
  - `CALENDAR_SYNCABLE_FIELDS = ['dayCellClickBehavior', 'calendarPageClickOverride', 'weekStartDay', 'showNotesOnCalendar']`

- [ ] **Step 1: Write the failing test.** The push decision is made by `syncSettingsUpdates`, which loops the allowlist and calls `syncSettingsFieldUpdate`. Test that the widened allowlists produce field pushes. Create `apps/desktop/src/main/settings/runtime-effects.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const fieldUpdate = vi.fn()
vi.mock('../sync/local-mutations', () => ({
  syncSettingsFieldUpdate: (...a: unknown[]) => fieldUpdate(...a)
}))

import { syncSettingsUpdates } from './runtime-effects'

beforeEach(() => vi.clearAllMocks())

describe('syncSettingsUpdates (D8 groups)', () => {
  it('pushes editor.width when present', () => {
    syncSettingsUpdates('editor', { width: 'full' }, ['width', 'toolbarMode'] as const)
    expect(fieldUpdate).toHaveBeenCalledWith('editor.width', 'full')
  })
  it('pushes tasks.defaultView but skips undefined fields', () => {
    syncSettingsUpdates('tasks', { defaultView: 'today' }, [
      'defaultView',
      'staleInboxDays'
    ] as const)
    expect(fieldUpdate).toHaveBeenCalledWith('tasks.defaultView', 'today')
    expect(fieldUpdate).toHaveBeenCalledTimes(1)
  })
})
```

(This proves the fan-out contract the handler relies on. The handler wiring itself is verified by `pnpm typecheck` + manual verify in Step 4.)

- [ ] **Step 2: Run it, expect FAIL.** Command: `pnpm --filter @memry/desktop test:main -- runtime-effects`. Expected: initially PASSES for the shared helper (it already works) — so instead make the test meaningful by asserting the exact allowlists exported from the handler. Adjust: export the four `*_SYNCABLE_FIELDS` consts from `settings-handlers.ts` and assert them:

```ts
import {
  EDITOR_SYNCABLE_FIELDS,
  TASK_SYNCABLE_FIELDS,
  KEYBOARD_SYNCABLE_FIELDS,
  CALENDAR_SYNCABLE_FIELDS
} from '../ipc/settings-handlers'

it('exposes the D8 syncable-field allowlists', () => {
  expect(EDITOR_SYNCABLE_FIELDS).toEqual(['width', 'toolbarMode'])
  expect(TASK_SYNCABLE_FIELDS).toContain('defaultView')
  expect(KEYBOARD_SYNCABLE_FIELDS).toEqual(['overrides', 'globalCapture'])
  expect(CALENDAR_SYNCABLE_FIELDS).toContain('showNotesOnCalendar')
})
```

Run again → FAIL: `EDITOR_SYNCABLE_FIELDS is not exported`.

- [ ] **Step 3: Minimal implementation.** In `settings-handlers.ts`, after `GENERAL_SYNCABLE_FIELDS` (line 76) add:

```ts
const EDITOR_SYNCABLE_FIELDS: (keyof EditorSettings)[] = ['width', 'toolbarMode']

const TASK_SYNCABLE_FIELDS: (keyof TaskSettings)[] = [
  'defaultProjectId',
  'defaultSortOrder',
  'defaultView',
  'staleInboxDays'
]

const KEYBOARD_SYNCABLE_FIELDS: (keyof KeyboardShortcuts)[] = ['overrides', 'globalCapture']

const CALENDAR_SYNCABLE_FIELDS: (keyof CalendarSettings)[] = [
  'dayCellClickBehavior',
  'calendarPageClickOverride',
  'weekStartDay',
  'showNotesOnCalendar'
]

export {
  EDITOR_SYNCABLE_FIELDS,
  TASK_SYNCABLE_FIELDS,
  KEYBOARD_SYNCABLE_FIELDS,
  CALENDAR_SYNCABLE_FIELDS
}
```

Then add `syncSettingsUpdates` calls to the four SET handlers (mirroring the `general` handler at line 766, which calls it only on success):

```ts
ipcMain.handle(
  SettingsChannels.invoke.SET_EDITOR_SETTINGS,
  (_event, updates: Partial<EditorSettings>) => {
    writeEditorToConfig(updates)
    const result = writeGroupSettings('editor', EDITOR_SETTINGS_DEFAULTS, updates)
    if (result.success) syncSettingsUpdates('editor', updates, EDITOR_SYNCABLE_FIELDS)
    return result
  }
)

ipcMain.handle(
  SettingsChannels.invoke.SET_TASK_SETTINGS,
  (_event, updates: Partial<TaskSettings>) => {
    const result = writeGroupSettings('tasks', TASK_SETTINGS_DEFAULTS, updates)
    if (result.success) syncSettingsUpdates('tasks', updates, TASK_SYNCABLE_FIELDS)
    return result
  }
)

ipcMain.handle(
  SettingsChannels.invoke.SET_KEYBOARD_SETTINGS,
  (_event, updates: Partial<KeyboardShortcuts>) => {
    const result = writeGroupSettings('keyboard', KEYBOARD_SHORTCUTS_DEFAULTS, updates)
    if ('globalCapture' in updates) {
      applyGlobalCaptureShortcut()
    }
    if (result.success) syncSettingsUpdates('keyboard', updates, KEYBOARD_SYNCABLE_FIELDS)
    return result
  }
)

ipcMain.handle(
  SettingsChannels.invoke.SET_CALENDAR_SETTINGS,
  (_event, updates: Partial<CalendarSettings>) => {
    const result = writeGroupSettings('calendar', CALENDAR_SETTINGS_DEFAULTS, updates)
    if (result.success) syncSettingsUpdates('calendar', updates, CALENDAR_SYNCABLE_FIELDS)
    return result
  }
)
```

(`syncSettingsUpdates` is already imported at line 52.)

- [ ] **Step 4: Run tests, expect PASS.** Commands: `pnpm --filter @memry/desktop test:main -- runtime-effects` → allowlist + fan-out tests pass; `pnpm typecheck`; `pnpm --filter @memry/desktop i18n:check` (no new user strings, sanity). Manual verify: in `pnpm --filter @memry/desktop dev:a` + `dev:b` on one linked vault, toggle Tasks default view on A and confirm it converges on B (settings inbound path is already tolerant).

- [ ] **Step 5: Commit.** `git add apps/desktop/src/main/ipc/settings-handlers.ts apps/desktop/src/main/settings/runtime-effects.test.ts && git commit -m "feat(settings): push editor/tasks/calendar/keyboard groups cross-device (D8)"`

---

## Final Verification (run after all tasks)

- [ ] `pnpm --filter @memry/contracts test` — contract schema + enum tests green.
- [ ] `pnpm --filter @memry/sync-server test && pnpm --filter @memry/sync-server typecheck` — exhaustive `toSyncDomain` switch compiles and is covered.
- [ ] `pnpm --filter @memry/desktop test:main` — handlers, services, wiring, emit, migration, settings.
- [ ] `pnpm typecheck` — all packages.
- [ ] `pnpm lint` and `git diff --check`.
- [ ] `pnpm ipc:check` — no invoke-map drift (no IPC channel added; contract-only changes).
- [ ] `pnpm check:contracts` and `pnpm check:architecture` — boundaries intact.
- [ ] `pnpm docs:impact --base <base_commit> --strict` then `pnpm docs:build` — desktop/sync-server changes may require a docs note; update `apps/docs/src/**` or run `pnpm docs:ai-update --base <base_commit>` if `missing-docs`.
- [ ] Native-module gotcha: any `ERR_DLOPEN_FAILED` during `test:main` → `pnpm --filter @memry/desktop rebuild:node`.

## Rollout & Risk Notes (carry into the PR body)

- **Deploy order (mandatory):** ship the sync-server `toSyncDomain` change (Task 3) to production BEFORE the desktop release carrying the new item types (Tasks 1–2). Otherwise the server throws in telemetry on unknown types.
- **Backward compat:** older desktop versions never wrote these as sync items and never sent `home_page`/`bookmark`/`reminder` types; the server stores them generically and old clients simply never pull types they don't register. First sync from an upgraded device back-fills existing rows via `seedUnclocked` (NULL-clock rows).
- **Bookmark unique index:** the handler upsert reconciles by `(item_type,item_id)` (Task 6) so a peer applying the same logical bookmark under a different id does not violate `idx_bookmarks_unique_item`.
- **Reminders don't double-fire:** only the reminder ENTITY syncs; OS-notification scheduling stays per-device and is NOT invoked from the remote-apply path. If a per-device scheduler needs to react to synced changes, subscribe it to the `reminders:changed` IPC event separately (out of scope here).
- **Reorder flood:** home-page reorder enqueues one update per affected id; the sync queue coalesces by `itemId`, so this is bounded. Debounce is a future optimization only if reorder churn shows up in queue metrics.
- **D8 audit:** the four widened settings groups contain no device-local values (no window bounds, no filesystem paths) — every allowlisted field is a portable preference safe to converge across devices.
- **ENCRYPTABLE_ITEM_TYPES:** confirmed the three types are in `ENCRYPTABLE_ITEM_TYPES` (Task 1) so payloads (which carry user content) push encrypted — this is a separate array from `SYNC_ITEM_TYPES` and easy to miss.
