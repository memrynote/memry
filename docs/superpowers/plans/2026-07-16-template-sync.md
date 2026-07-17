# Plan B — Custom Template Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Also load the `adding-sync-item-type` skill before Task 1 — it encodes the full enum + registry + telemetry checklist and guards the non-exhaustive-switch typecheck failure.

**Goal:** Make custom templates sync across devices, and migrate every existing user's template files into the synced store without losing one.

**Architecture:** `template` becomes a record sync item type with whole-row LWW (`clock` only, no `fieldClocks`), copying `filter-handler.ts`. Custom templates move from `vault/.memry/templates/*.md` into a new `templates` table in the data DB; built-in templates stop being files entirely and become code constants served straight from `BUILT_IN_TEMPLATES`. A one-time, settings-guarded backfill imports each existing custom template file as a row with `clock = NULL`, which the existing `seedUnclocked` machinery then pushes.

**Tech Stack:** TypeScript, Drizzle ORM + better-sqlite3 (data DB), Zod contracts, Electron main process, Vitest, Playwright (Electron E2E).

## Global Constraints

- **GATED ON PLAN A.** Do not ship a desktop build carrying the `template` type until `docs/superpowers/plans/2026-07-16-sync-type-negotiation.md` is **deployed to production**. Without it, an old client sharing a vault with an upgraded one drops entire pages of notes and tasks while its cursor advances past them.
- **Live beta, real users on macOS/Windows/Linux. Backward compatibility is mandatory.** No DB resets.
- **Data-DB migrations are HAND-WRITTEN.** Drizzle snapshots are broken past `0021`; `meta/` snapshots stop at `0021_snapshot.json`. Do NOT run `db:generate` for this table — write the SQL and the `_journal.json` entry by hand.
- **Migration `when` must exceed `1783206622572`** (the current max in `_journal.json`), or drizzle silently skips it on every existing database. Enforced by `apps/desktop/src/main/database/migrate-journal.test.ts`.
- **Built-in templates never sync.** They have fixed ids, are identical on every device, and are already immutable.
- **Template ids are never regenerated during migration.** Preserve the id from file frontmatter.
- Logging: `createLogger('Scope')`, never raw `console.*`. User-facing errors: `extractErrorMessage(err, fallback)`.
- Do not add `Co-Authored-By` to commit messages.

## File Structure

| File                                                                      | Responsibility                                                         |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `packages/contracts/src/sync-api.ts` (modify)                             | `'template'` into four arrays.                                         |
| `packages/contracts/src/sync-payloads.ts` (modify)                        | `TemplateSyncPayloadSchema` + inferred type.                           |
| `packages/db-schema/src/schema/templates.ts` (create)                     | Drizzle `templates` table.                                             |
| `packages/db-schema/src/data-schema.ts` + `schema/index.ts` (modify)      | Export it from **both** barrels.                                       |
| `apps/desktop/src/main/database/drizzle-data/0035_templates.sql` (create) | Hand-written migration.                                                |
| `apps/desktop/src/main/database/drizzle-data/meta/_journal.json` (modify) | Register migration 35.                                                 |
| `apps/desktop/src/main/sync/item-handlers/template-handler.ts` (create)   | Record sync handler.                                                   |
| `apps/desktop/src/main/sync/item-handlers/index.ts` (modify)              | Registry entry.                                                        |
| `apps/desktop/src/main/sync/template-sync.ts` (create)                    | `RecordSyncController` service.                                        |
| `apps/desktop/src/main/sync/offline-clock.ts` (modify)                    | `incrementTemplateClockOffline`.                                       |
| `apps/desktop/src/main/sync/local-mutations.ts` (modify)                  | `template` registry block.                                             |
| `apps/desktop/src/main/sync/runtime.ts` (modify)                          | init / reset / adapter registry.                                       |
| `apps/desktop/src/main/sync/manifest-check.ts` (modify)                   | Include clocked templates.                                             |
| `apps/sync-server/src/services/sync-telemetry.ts` (modify)                | `toSyncDomain` case (exhaustive switch — typecheck fails until added). |
| `apps/desktop/src/main/vault/templates.ts` (rewrite)                      | DB-backed CRUD; built-ins as constants; enqueue on every mutation.     |
| `apps/desktop/src/main/vault/templates-migration.ts` (create)             | One-time legacy file → row backfill.                                   |
| `apps/desktop/src/main/vault/index.ts` (modify)                           | Invoke the backfill from `openVault()`.                                |
| `apps/desktop/tests/e2e/fixtures/legacy-template-fixtures.ts` (create)    | Pre-launch vault seeding (new pattern — none exists today).            |
| `apps/desktop/tests/e2e/templates-sync.e2e.ts` (create)                   | Dual-device E2E.                                                       |

---

### Task 1: Contracts — item type + sync payload

**Files:**

- Modify: `packages/contracts/src/sync-api.ts` (four arrays)
- Modify: `packages/contracts/src/sync-payloads.ts`
- Test: `packages/contracts/src/sync-payloads.test.ts`

**Interfaces:**

- Produces: `TemplateSyncPayloadSchema`, `type TemplateSyncPayload = { name?: string; description?: string | null; icon?: string | null; tags?: string[]; properties?: unknown; content?: string; clock?: VectorClock; createdAt?: string; modifiedAt?: string }`. Tasks 3, 4 and 6 consume it.

**Four arrays, not one.** `'template'` goes into `SYNC_ITEM_TYPES`, `RECORD_SYNC_ITEM_TYPES`, `RECORD_CLOCK_REQUIRED_ITEM_TYPES` and `ENCRYPTABLE_ITEM_TYPES`. Omitting `ENCRYPTABLE_ITEM_TYPES` makes encryption refuse the type and sync silently drops it. Do **not** add it to `CRDT_SYNC_ITEM_TYPES`, and do **not** touch `LEGACY_RECORD_SYNC_ITEM_TYPES` (Plan A) — that list is frozen.

- [ ] **Step 1: Write the failing test**

Append to `packages/contracts/src/sync-payloads.test.ts`:

```ts
import { TemplateSyncPayloadSchema } from './sync-payloads'
import {
  SYNC_ITEM_TYPES,
  RECORD_SYNC_ITEM_TYPES,
  RECORD_CLOCK_REQUIRED_ITEM_TYPES,
  ENCRYPTABLE_ITEM_TYPES,
  CRDT_SYNC_ITEM_TYPES,
  LEGACY_RECORD_SYNC_ITEM_TYPES
} from './sync-api'

describe('template sync item type', () => {
  it('is registered in all four required arrays', () => {
    expect(SYNC_ITEM_TYPES).toContain('template')
    expect(RECORD_SYNC_ITEM_TYPES).toContain('template')
    expect(RECORD_CLOCK_REQUIRED_ITEM_TYPES).toContain('template')
    // Omitting this one makes encryption refuse the type and sync drops it silently.
    expect(ENCRYPTABLE_ITEM_TYPES).toContain('template')
  })

  it('is not a CRDT type and never leaks into the frozen legacy list', () => {
    expect(CRDT_SYNC_ITEM_TYPES).not.toContain('template')
    expect(LEGACY_RECORD_SYNC_ITEM_TYPES).not.toContain('template')
  })
})

describe('TemplateSyncPayloadSchema', () => {
  it('parses a full payload', () => {
    const result = TemplateSyncPayloadSchema.safeParse({
      name: 'Standup',
      description: 'Daily standup',
      icon: '✅',
      tags: ['daily'],
      properties: [{ name: 'date', type: 'date', value: null }],
      content: '## Blockers',
      clock: { 'device-a': 1 },
      createdAt: '2026-07-16T00:00:00.000Z',
      modifiedAt: '2026-07-16T00:00:00.000Z'
    })
    expect(result.success).toBe(true)
  })

  it('parses an empty payload (every field optional)', () => {
    expect(TemplateSyncPayloadSchema.safeParse({}).success).toBe(true)
  })

  it('accepts a null icon and null description', () => {
    const result = TemplateSyncPayloadSchema.safeParse({ icon: null, description: null })
    expect(result.success).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/contracts test -- sync-payloads`
Expected: FAIL — `TemplateSyncPayloadSchema` is not exported; the array assertions fail.

- [ ] **Step 3: Write minimal implementation**

In `packages/contracts/src/sync-api.ts`, add `'template'` as the last entry of `SYNC_ITEM_TYPES`, `RECORD_SYNC_ITEM_TYPES`, `RECORD_CLOCK_REQUIRED_ITEM_TYPES` and `ENCRYPTABLE_ITEM_TYPES`. For example:

```ts
export const SYNC_ITEM_TYPES = [
  // ...existing entries unchanged...
  'agent_conversation',
  'agent_message',
  'template'
] as const
```

In `packages/contracts/src/sync-payloads.ts`, add next to `FilterSyncPayloadSchema`:

```ts
export const TemplateSyncPayloadSchema = z.object({
  name: z.string().optional(),
  description: z.string().nullable().optional(),
  icon: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  properties: z.unknown().optional(),
  content: z.string().optional(),
  clock: VectorClockSchema.optional(),
  createdAt: z.string().optional(),
  modifiedAt: z.string().optional()
})
```

And with the other `z.infer` exports at the bottom:

```ts
export type TemplateSyncPayload = z.infer<typeof TemplateSyncPayloadSchema>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/contracts test -- sync-payloads`
Expected: PASS.
Then `pnpm typecheck` — **expect a failure** in `apps/sync-server/src/services/sync-telemetry.ts`: the `toSyncDomain` switch is exhaustive over `SyncItemType` and has no `default`, so it now "lacks ending return statement". Task 9 fixes it. This failure is the checklist working.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/sync-api.ts packages/contracts/src/sync-payloads.ts packages/contracts/src/sync-payloads.test.ts
git commit -m "feat(contracts): add template record sync item type

Whole-row LWW; registered in all four arrays including ENCRYPTABLE_ITEM_TYPES.
Left out of the frozen legacy list so pre-negotiation clients never see it."
```

---

### Task 2: `templates` table + hand-written migration

**Files:**

- Create: `packages/db-schema/src/schema/templates.ts`
- Modify: `packages/db-schema/src/data-schema.ts` and `packages/db-schema/src/schema/index.ts`
- Create: `apps/desktop/src/main/database/drizzle-data/0035_templates.sql`
- Modify: `apps/desktop/src/main/database/drizzle-data/meta/_journal.json`
- Test: `apps/desktop/src/main/database/migrate-journal.test.ts` (already exists — it must stay green)

**Interfaces:**

- Produces: `templates` Drizzle table plus `type TemplateRow = typeof templates.$inferSelect` / `NewTemplateRow`. Columns: `id` (PK text), `name` (text notNull), `description` (text nullable), `icon` (text nullable), `tags` (json `string[]`, notNull, default `'[]'`), `properties` (json, notNull, default `'[]'`), `content` (text notNull, default `''`), `clock` (json `VectorClock`, nullable), `syncedAt` (text nullable), `createdAt` (text notNull), `modifiedAt` (text notNull). Tasks 3, 4, 5, 8, 10, 11 all import `templates`.

**Both barrels.** `data-schema.ts` drives drizzle-kit generation; `schema/index.ts` is what consumers import from. A file missing from `data-schema.ts` gets a `DROP TABLE` emitted for it on the next generate.

- [ ] **Step 1: Write the failing test**

Create `packages/db-schema/src/schema/templates.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { templates } from './templates'
import * as dataSchema from '../data-schema'
import * as schemaIndex from './index'

describe('templates schema', () => {
  it('is exported from both barrels', () => {
    // data-schema.ts drives drizzle-kit; schema/index.ts is what consumers import.
    // Missing from data-schema.ts => drizzle-kit emits a DROP TABLE for it.
    expect(dataSchema).toHaveProperty('templates')
    expect(schemaIndex).toHaveProperty('templates')
  })

  it('carries the columns record sync needs', () => {
    const columns = Object.keys(templates)
    for (const column of [
      'id',
      'name',
      'description',
      'icon',
      'tags',
      'properties',
      'content',
      'clock',
      'syncedAt',
      'createdAt',
      'modifiedAt'
    ]) {
      expect(columns).toContain(column)
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/db-schema test -- templates`
Expected: FAIL — cannot resolve `./templates`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/db-schema/src/schema/templates.ts`:

```ts
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'
import type { VectorClock } from '@memry/contracts/sync-api'

/**
 * Custom note templates. Built-in templates are code constants (see
 * BUILT_IN_TEMPLATES in main/vault/templates.ts) and never appear here.
 */
export const templates = sqliteTable('templates', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  icon: text('icon'),
  tags: text('tags', { mode: 'json' }).$type<string[]>().notNull().default([]),
  properties: text('properties', { mode: 'json' }).$type<unknown[]>().notNull().default([]),
  content: text('content').notNull().default(''),
  clock: text('clock', { mode: 'json' }).$type<VectorClock>(),
  syncedAt: text('synced_at'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  modifiedAt: text('modified_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
})

export type TemplateRow = typeof templates.$inferSelect
export type NewTemplateRow = typeof templates.$inferInsert
```

Add `export * from './schema/templates.ts'` to `packages/db-schema/src/data-schema.ts` and `export * from './templates.ts'` to `packages/db-schema/src/schema/index.ts`.

Create `apps/desktop/src/main/database/drizzle-data/0035_templates.sql`:

```sql
CREATE TABLE `templates` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`icon` text,
	`tags` text DEFAULT '[]' NOT NULL,
	`properties` text DEFAULT '[]' NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`clock` text,
	`synced_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`modified_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
```

Append to the `entries` array in `apps/desktop/src/main/database/drizzle-data/meta/_journal.json`, after the `0034_tag_nocase` entry:

```json
{
  "idx": 35,
  "version": "6",
  "when": 1784246400000,
  "tag": "0035_templates",
  "breakpoints": true
}
```

`when` must exceed `1783206622572` — `1784246400000` does. **Do not** create `meta/0035_snapshot.json`; hand-written migrations since 0022 have none. **Do not** run `db:generate`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/db-schema test -- templates` → PASS.
Run: `pnpm --filter @memry/desktop test:main -- migrate-journal` → PASS (the `when` invariant holds).
Run: `pnpm --filter @memry/desktop db:push` then `pnpm --filter @memry/desktop db:studio:data` and confirm the `templates` table exists.

- [ ] **Step 5: Commit**

```bash
git add packages/db-schema/src/schema/templates.ts packages/db-schema/src/schema/templates.test.ts packages/db-schema/src/data-schema.ts packages/db-schema/src/schema/index.ts apps/desktop/src/main/database/drizzle-data/0035_templates.sql apps/desktop/src/main/database/drizzle-data/meta/_journal.json
git commit -m "feat(db): add templates table

Hand-written migration 0035; drizzle snapshots are broken past 0021 so
db:generate is not used. Journal 'when' exceeds every prior entry, or
drizzle skips the migration on existing databases."
```

---

### Task 3: `template-handler.ts`

**Files:**

- Create: `apps/desktop/src/main/sync/item-handlers/template-handler.ts`
- Modify: `apps/desktop/src/main/sync/item-handlers/index.ts`
- Test: `apps/desktop/src/main/sync/item-handlers/template-handler.test.ts`

**Interfaces:**

- Consumes: `templates` (Task 2); `TemplateSyncPayloadSchema` / `TemplateSyncPayload` (Task 1); `TemplatesChannels` from `@memry/contracts/ipc-channels` (already exists and is already emitted by `vault/templates.ts`).
- Produces: `export const templateHandler` — a `BaseItemHandler<TemplateSyncPayload>` with `type = 'template'`. Task 7 references it via `getRemoteSyncAdapter('template')`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/main/sync/item-handlers/template-handler.test.ts`, modelled on `tag-definition-handler.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { TemplatesChannels } from '@memry/contracts/ipc-channels'
import { templates } from '@memry/db-schema/schema/templates'
import { createTestDataDb, asSyncDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { SyncQueueManager } from '../queue'
import { templateHandler } from './template-handler'
import type { ApplyContext, DrizzleDb } from './types'

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

function makeCtx(testDb: TestDatabaseResult): ApplyContext {
  return { db: testDb.db as unknown as DrizzleDb, emit: vi.fn() }
}

describe('templateHandler', () => {
  let testDb: TestDatabaseResult
  let ctx: ApplyContext

  beforeEach(() => {
    testDb = createTestDataDb()
    ctx = makeCtx(testDb)
  })

  afterEach(() => {
    testDb.close()
  })

  it('inserts a remote template and emits CREATED', () => {
    const result = templateHandler.applyUpsert(
      ctx,
      'tpl-1',
      {
        name: 'Standup',
        icon: '✅',
        tags: ['daily'],
        properties: [],
        content: '## Blockers',
        createdAt: '2026-07-16T00:00:00.000Z'
      },
      { 'device-b': 1 }
    )

    expect(result).toBe('applied')
    expect(testDb.db.select().from(templates).where(eq(templates.id, 'tpl-1')).get()).toMatchObject(
      {
        name: 'Standup',
        icon: '✅',
        content: '## Blockers',
        clock: { 'device-b': 1 }
      }
    )
    expect(ctx.emit).toHaveBeenCalledWith(TemplatesChannels.events.CREATED, { id: 'tpl-1' })
  })

  it('updates on newer clock, skips stale, reports concurrent as conflict', () => {
    testDb.db
      .insert(templates)
      .values({
        id: 'tpl-1',
        name: 'Standup',
        content: 'v1',
        tags: [],
        properties: [],
        clock: { 'device-a': 1 },
        createdAt: '2026-07-16T00:00:00.000Z',
        modifiedAt: '2026-07-16T00:00:00.000Z'
      })
      .run()

    expect(templateHandler.applyUpsert(ctx, 'tpl-1', { content: 'v2' }, { 'device-a': 2 })).toBe(
      'applied'
    )
    expect(testDb.db.select().from(templates).where(eq(templates.id, 'tpl-1')).get()).toMatchObject(
      {
        content: 'v2'
      }
    )
    expect(ctx.emit).toHaveBeenCalledWith(TemplatesChannels.events.UPDATED, { id: 'tpl-1' })

    expect(templateHandler.applyUpsert(ctx, 'tpl-1', { content: 'stale' }, { 'device-a': 1 })).toBe(
      'skipped'
    )
    expect(testDb.db.select().from(templates).where(eq(templates.id, 'tpl-1')).get()).toMatchObject(
      {
        content: 'v2'
      }
    )

    expect(templateHandler.applyUpsert(ctx, 'tpl-1', { content: 'v3' }, { 'device-b': 1 })).toBe(
      'conflict'
    )
    expect(testDb.db.select().from(templates).where(eq(templates.id, 'tpl-1')).get()).toMatchObject(
      {
        content: 'v3',
        clock: { 'device-a': 2, 'device-b': 1 }
      }
    )
  })

  it('builds payloads, fetches local rows, deletes by clock, and seeds unclocked templates', () => {
    testDb.db
      .insert(templates)
      .values([
        {
          id: 'synced',
          name: 'Synced',
          content: 'a',
          tags: [],
          properties: [],
          clock: { 'device-a': 1 },
          createdAt: '2026-07-16T00:00:00.000Z',
          modifiedAt: '2026-07-16T00:00:00.000Z'
        },
        {
          id: 'local-only',
          name: 'Local Only',
          content: 'b',
          tags: [],
          properties: [],
          createdAt: '2026-07-16T00:00:00.000Z',
          modifiedAt: '2026-07-16T00:00:00.000Z'
        }
      ])
      .run()

    expect(templateHandler.fetchLocal(testDb.db as unknown as DrizzleDb, 'synced')).toMatchObject({
      name: 'Synced'
    })
    expect(templateHandler.fetchLocal(testDb.db as unknown as DrizzleDb, 'missing')).toBeUndefined()

    expect(
      JSON.parse(
        templateHandler.buildPushPayload?.(
          testDb.db as unknown as DrizzleDb,
          'synced',
          'device-a',
          'update'
        ) ?? '{}'
      )
    ).toMatchObject({ name: 'Synced', clock: { 'device-a': 1 } })
    expect(
      templateHandler.buildPushPayload?.(
        testDb.db as unknown as DrizzleDb,
        'missing',
        'device-a',
        'update'
      )
    ).toBeNull()

    expect(templateHandler.applyDelete(ctx, 'missing')).toBe('skipped')
    expect(templateHandler.applyDelete(ctx, 'synced', { 'device-b': 1 })).toBe('skipped')
    expect(templateHandler.applyDelete(ctx, 'synced', { 'device-a': 2 })).toBe('applied')
    expect(ctx.emit).toHaveBeenCalledWith(TemplatesChannels.events.DELETED, { id: 'synced' })

    const queue = new SyncQueueManager(asSyncDb(testDb.db))
    expect(
      templateHandler.seedUnclocked(testDb.db as unknown as DrizzleDb, 'device-a', queue)
    ).toBe(1)
    const [queued] = queue.dequeue(1)
    expect(queued).toMatchObject({ type: 'template', itemId: 'local-only', operation: 'create' })
    expect(JSON.parse(queued.payload)).toMatchObject({ clock: { 'device-a': 1 } })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:main -- template-handler`
Expected: FAIL — cannot resolve `./template-handler`.
On `ERR_DLOPEN_FAILED`, run `pnpm --filter @memry/desktop rebuild:node`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/desktop/src/main/sync/item-handlers/template-handler.ts`:

```ts
import { eq, isNull } from 'drizzle-orm'
import { templates } from '@memry/db-schema/schema/templates'
import { TemplateSyncPayloadSchema, type TemplateSyncPayload } from '@memry/contracts/sync-payloads'
import { TemplatesChannels } from '@memry/contracts/ipc-channels'
import type { VectorClock } from '@memry/contracts/sync-api'
import { utcNow } from '@memry/shared/utc'
import type { SyncQueueManager } from '../queue'
import { increment } from '../vector-clock'
import { createLogger } from '../../lib/logger'
import { BaseItemHandler } from './base-handler'
import type { ApplyContext, ApplyResult, DrizzleDb } from './types'

const log = createLogger('TemplateHandler')

class TemplateHandler extends BaseItemHandler<TemplateSyncPayload> {
  readonly type = 'template' as const
  readonly schema = TemplateSyncPayloadSchema

  applyUpsert(
    ctx: ApplyContext,
    itemId: string,
    data: TemplateSyncPayload,
    clock: VectorClock
  ): ApplyResult {
    return ctx.db.transaction((tx): ApplyResult => {
      const existing = tx.select().from(templates).where(eq(templates.id, itemId)).get()
      const remoteClock = Object.keys(clock).length > 0 ? clock : (data.clock ?? {})
      const now = utcNow()

      if (existing) {
        const resolution = this.resolveClock(existing.clock, remoteClock)
        if (resolution.action === 'skip') {
          log.info('Skipping remote template update, local is newer', { itemId })
          return 'skipped'
        }
        if (resolution.action === 'merge') {
          log.warn('Concurrent template edit, using last-write-wins', { itemId })
        }

        tx.update(templates)
          .set({
            name: data.name ?? existing.name,
            description: data.description !== undefined ? data.description : existing.description,
            icon: data.icon !== undefined ? data.icon : existing.icon,
            tags: data.tags ?? existing.tags,
            properties: (data.properties as unknown[]) ?? existing.properties,
            content: data.content ?? existing.content,
            clock: resolution.mergedClock,
            syncedAt: now,
            modifiedAt: data.modifiedAt ?? now
          })
          .where(eq(templates.id, itemId))
          .run()

        ctx.emit(TemplatesChannels.events.UPDATED, { id: itemId })
        return resolution.action === 'merge' ? 'conflict' : 'applied'
      }

      tx.insert(templates)
        .values({
          id: itemId,
          name: data.name ?? 'Untitled Template',
          description: data.description ?? null,
          icon: data.icon ?? null,
          tags: data.tags ?? [],
          properties: (data.properties as unknown[]) ?? [],
          content: data.content ?? '',
          clock: remoteClock,
          syncedAt: now,
          createdAt: data.createdAt ?? now,
          modifiedAt: data.modifiedAt ?? now
        })
        .run()

      ctx.emit(TemplatesChannels.events.CREATED, { id: itemId })
      return 'applied'
    })
  }

  applyDelete(ctx: ApplyContext, itemId: string, clock?: VectorClock): 'applied' | 'skipped' {
    const existing = ctx.db.select().from(templates).where(eq(templates.id, itemId)).get()
    if (!existing) return 'skipped'

    if (clock && existing.clock) {
      const resolution = this.resolveClock(existing.clock, clock)
      if (resolution.action === 'skip' || resolution.action === 'merge') {
        log.info('Skipping remote template delete, local has unseen changes', { itemId })
        return 'skipped'
      }
    }

    ctx.db.delete(templates).where(eq(templates.id, itemId)).run()
    ctx.emit(TemplatesChannels.events.DELETED, { id: itemId })
    return 'applied'
  }

  fetchLocal(db: DrizzleDb, itemId: string): Record<string, unknown> | undefined {
    return db.select().from(templates).where(eq(templates.id, itemId)).get() as
      | Record<string, unknown>
      | undefined
  }

  buildPushPayload(
    db: DrizzleDb,
    itemId: string,
    _deviceId: string,
    _operation: string
  ): string | null {
    const template = db.select().from(templates).where(eq(templates.id, itemId)).get()
    if (!template) return null
    return JSON.stringify(template)
  }

  markPushSynced(db: DrizzleDb, itemId: string): void {
    db.update(templates).set({ syncedAt: utcNow() }).where(eq(templates.id, itemId)).run()
  }

  seedUnclocked(db: DrizzleDb, deviceId: string, queue: SyncQueueManager): number {
    const items = db.select().from(templates).where(isNull(templates.clock)).all()
    for (const item of items) {
      const clock = increment({}, deviceId)
      db.update(templates).set({ clock }).where(eq(templates.id, item.id)).run()
      queue.enqueue({
        type: 'template',
        itemId: item.id,
        operation: 'create',
        payload: JSON.stringify({ ...item, clock }),
        priority: 0
      })
    }
    return items.length
  }
}

export const templateHandler = new TemplateHandler()
```

In `apps/desktop/src/main/sync/item-handlers/index.ts`, add the import alongside the others and register it in the `handlers` Map:

```ts
import { templateHandler } from './template-handler'

// ...inside the Map literal, after ['agent_message', agentMessageHandler]:
;['template', templateHandler]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop test:main -- template-handler`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/sync/item-handlers/template-handler.ts apps/desktop/src/main/sync/item-handlers/template-handler.test.ts apps/desktop/src/main/sync/item-handlers/index.ts
git commit -m "feat(sync): add template record sync handler

Whole-row LWW copied from filter-handler; seedUnclocked back-fills rows that
predate sync."
```

---

### Task 4: `template-sync.ts` service

**Files:**

- Create: `apps/desktop/src/main/sync/template-sync.ts`
- Test: `apps/desktop/src/main/sync/template-sync.test.ts`

**Interfaces:**

- Consumes: `templates` (Task 2); `SyncQueueManager`.
- Produces: `initTemplateSyncService(deps): TemplateSyncService`, `getTemplateSyncService(): TemplateSyncService | null`, `resetTemplateSyncService(): void`, and `class TemplateSyncService` with `enqueueCreate(id: string)`, `enqueueUpdate(id: string)`, `enqueueDelete(id: string, snapshotPayload: string)`. Tasks 6 and 7 consume all of these. `deps` is `{ queue: SyncQueueManager; db: DrizzleDb; getDeviceId: () => string | null }`.

**Note:** this layer imports `incrementClock` / `withIncrementedClock` from `@memry/sync-core` — **not** `increment` from `./vector-clock`. The handler layer uses the latter. Two different helpers; mirror the layer you are in.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/main/sync/template-sync.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { templates } from '@memry/db-schema/schema/templates'
import { createTestDataDb, asSyncDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { SyncQueueManager } from './queue'
import {
  initTemplateSyncService,
  getTemplateSyncService,
  resetTemplateSyncService
} from './template-sync'

describe('TemplateSyncService', () => {
  let testDb: TestDatabaseResult

  beforeEach(() => {
    testDb = createTestDataDb()
    testDb.db
      .insert(templates)
      .values({
        id: 'tpl-1',
        name: 'Standup',
        content: 'v1',
        tags: [],
        properties: [],
        createdAt: '2026-07-16T00:00:00.000Z',
        modifiedAt: '2026-07-16T00:00:00.000Z'
      })
      .run()
  })

  afterEach(() => {
    resetTemplateSyncService()
    testDb.close()
  })

  it('enqueues a create and bumps the row clock', () => {
    const queue = new SyncQueueManager(asSyncDb(testDb.db))
    const service = initTemplateSyncService({
      queue,
      db: testDb.db as never,
      getDeviceId: () => 'device-a'
    })

    service.enqueueCreate('tpl-1')

    const [queued] = queue.dequeue(1)
    expect(queued).toMatchObject({ type: 'template', itemId: 'tpl-1', operation: 'create' })
    expect(
      testDb.db.select().from(templates).where(eq(templates.id, 'tpl-1')).get()?.clock
    ).toEqual({ 'device-a': 1 })
  })

  it('exposes the singleton and clears it on reset', () => {
    const queue = new SyncQueueManager(asSyncDb(testDb.db))
    initTemplateSyncService({ queue, db: testDb.db as never, getDeviceId: () => 'device-a' })
    expect(getTemplateSyncService()).not.toBeNull()

    resetTemplateSyncService()
    expect(getTemplateSyncService()).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:main -- template-sync`
Expected: FAIL — cannot resolve `./template-sync`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/desktop/src/main/sync/template-sync.ts` (copied from `filter-sync.ts`):

```ts
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { eq } from 'drizzle-orm'
import type * as schema from '@memry/db-schema/data-schema'
import { templates } from '@memry/db-schema/schema/templates'
import type { VectorClock } from '@memry/contracts/sync-api'
import { RecordSyncController, incrementClock, withIncrementedClock } from '@memry/sync-core'
import type { SyncQueueManager } from './queue'

type DrizzleDb = BetterSQLite3Database<typeof schema>

interface TemplateSyncDeps {
  queue: SyncQueueManager
  db: DrizzleDb
  getDeviceId: () => string | null
}

let instance: TemplateSyncService | null = null

export function initTemplateSyncService(deps: TemplateSyncDeps): TemplateSyncService {
  instance = new TemplateSyncService(deps)
  return instance
}

export function getTemplateSyncService(): TemplateSyncService | null {
  return instance
}

export function resetTemplateSyncService(): void {
  instance = null
}

export class TemplateSyncService {
  private controller: RecordSyncController<Record<string, unknown>, [], [string]>

  constructor(deps: TemplateSyncDeps) {
    this.controller = new RecordSyncController({
      type: 'template',
      queue: deps.queue,
      getDeviceId: deps.getDeviceId,
      load: (templateId) =>
        deps.db.select().from(templates).where(eq(templates.id, templateId)).get() as
          | Record<string, unknown>
          | undefined,
      applyLocalChange: ({ itemId, local, deviceId }) => {
        const existingClock = (local.clock as VectorClock) ?? {}
        const newClock = incrementClock(existingClock, deviceId)

        deps.db.update(templates).set({ clock: newClock }).where(eq(templates.id, itemId)).run()

        return { ...local, clock: newClock }
      },
      serialize: (local) => local,
      buildDeletePayload: ({ extra, deviceId }) => withIncrementedClock(extra[0], deviceId)
    })
  }

  enqueueCreate(templateId: string): void {
    this.controller.enqueueCreate(templateId)
  }

  enqueueUpdate(templateId: string): void {
    this.controller.enqueueUpdate(templateId)
  }

  enqueueDelete(templateId: string, snapshotPayload: string): void {
    this.controller.enqueueDelete(templateId, snapshotPayload)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop test:main -- template-sync`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/sync/template-sync.ts apps/desktop/src/main/sync/template-sync.test.ts
git commit -m "feat(sync): add template sync service"
```

---

### Task 5: Offline clock helper

**Files:**

- Modify: `apps/desktop/src/main/sync/offline-clock.ts` (append after `incrementFilterClockOffline`, ~line 181)
- Test: `apps/desktop/src/main/sync/offline-clock.test.ts` (extend if present, else create)

**Interfaces:**

- Produces: `incrementTemplateClockOffline(db: DataDb, templateId: string): void`. Task 6 is the only caller.

**Why:** without it, edits made while the sync service is uninitialized (offline) never bump the clock, so they are lost on reconnect.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { templates } from '@memry/db-schema/schema/templates'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { incrementTemplateClockOffline, OFFLINE_DEVICE_KEY } from './offline-clock'

describe('incrementTemplateClockOffline', () => {
  let testDb: TestDatabaseResult

  beforeEach(() => {
    testDb = createTestDataDb()
  })

  afterEach(() => {
    testDb.close()
  })

  it('stamps the offline device key on the row clock', () => {
    testDb.db
      .insert(templates)
      .values({
        id: 'tpl-1',
        name: 'Standup',
        content: '',
        tags: [],
        properties: [],
        createdAt: '2026-07-16T00:00:00.000Z',
        modifiedAt: '2026-07-16T00:00:00.000Z'
      })
      .run()

    incrementTemplateClockOffline(testDb.db as never, 'tpl-1')

    expect(
      testDb.db.select().from(templates).where(eq(templates.id, 'tpl-1')).get()?.clock
    ).toEqual({ [OFFLINE_DEVICE_KEY]: 1 })
  })

  it('is a no-op for a missing template', () => {
    expect(() => incrementTemplateClockOffline(testDb.db as never, 'nope')).not.toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:main -- offline-clock`
Expected: FAIL — `incrementTemplateClockOffline is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add the import at the top of `offline-clock.ts`:

```ts
import { templates } from '@memry/db-schema/schema/templates'
```

Append the function (copied from `incrementFilterClockOffline`):

```ts
export function incrementTemplateClockOffline(db: DataDb, templateId: string): void {
  try {
    const template = db.select().from(templates).where(eq(templates.id, templateId)).get()
    if (!template) return

    const existingClock = (template.clock as VectorClock) ?? {}
    const newClock = increment(existingClock, OFFLINE_DEVICE_KEY)

    db.update(templates).set({ clock: newClock }).where(eq(templates.id, templateId)).run()

    log.debug('Incremented offline template clock', { templateId })
  } catch (err) {
    log.warn('Failed to increment offline template clock', { templateId, error: err })
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop test:main -- offline-clock` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/sync/offline-clock.ts apps/desktop/src/main/sync/offline-clock.test.ts
git commit -m "feat(sync): bump template clocks for offline edits"
```

---

### Task 6: `local-mutations` registry entry

**Files:**

- Modify: `apps/desktop/src/main/sync/local-mutations.ts`
- Test: `apps/desktop/src/main/sync/local-mutations.test.ts`

**Interfaces:**

- Consumes: `getTemplateSyncService` (Task 4), `incrementTemplateClockOffline` (Task 5).
- Produces: `enqueueLocalSyncCreate('template', id)` / `Update` / `Delete` now resolve to a real adapter. Task 10 calls these from the template CRUD.

`type LocalSyncType = Exclude<SyncItemType, 'attachment'>` already includes `'template'` from Task 1, so without this entry `getLocal('template')` returns undefined and logs `'Missing local sync adapter'`.

- [ ] **Step 1: Write the failing test**

```ts
it('resolves a local adapter for template', () => {
  // Without a registry entry this logs 'Missing local sync adapter' and the
  // mutation is silently dropped.
  expect(localSyncRegistry.getLocal('template')).toBeDefined()
})
```

Match the existing conventions in `local-mutations.test.ts` for exposing `localSyncRegistry`; if it is not exported, assert instead that `enqueueLocalSyncCreate('template', 'tpl-1')` reaches a mocked `getTemplateSyncService().enqueueCreate`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:main -- local-mutations`
Expected: FAIL — adapter undefined.

- [ ] **Step 3: Write minimal implementation**

Add the imports:

```ts
import { getTemplateSyncService } from './template-sync'
import { incrementTemplateClockOffline } from './offline-clock'
```

Add this block to the `createSyncAdapterRegistry([...])` array (mirrors the `filter` block, offline fallback included):

```ts
  {
    type: 'template',
    kind: 'record',
    local: {
      enqueueCreate(itemId: string): void {
        const service = getTemplateSyncService()
        if (service) {
          service.enqueueCreate(itemId)
          return
        }

        incrementTemplateClockOffline(getDatabase(), itemId)
      },
      enqueueUpdate(itemId: string): void {
        const service = getTemplateSyncService()
        if (service) {
          service.enqueueUpdate(itemId)
          return
        }

        incrementTemplateClockOffline(getDatabase(), itemId)
      },
      enqueueDelete(itemId: string, snapshotPayload?: string): void {
        if (!snapshotPayload) return
        getTemplateSyncService()?.enqueueDelete(itemId, snapshotPayload)
      }
    }
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop test:main -- local-mutations` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/sync/local-mutations.ts apps/desktop/src/main/sync/local-mutations.test.ts
git commit -m "feat(sync): register template local mutation adapter"
```

---

### Task 7: Runtime wiring

**Files:**

- Modify: `apps/desktop/src/main/sync/runtime.ts` — import (~L25), `resetSyncServiceSingletons` (~L112-126), init (~L252), `createSyncAdapterRegistry` (~L288-358)
- Test: `apps/desktop/src/main/sync/runtime-effects.test.ts` (extend, following existing conventions)

**Interfaces:**

- Consumes: `initTemplateSyncService` / `resetTemplateSyncService` (Task 4); `getRemoteSyncAdapter('template')` (Task 3).
- Produces: a live `template` entry in the runtime adapter registry.

- [ ] **Step 1: Write the failing test**

Extend the runtime allowlist/fan-out test to assert `template` is present in the adapter registry, matching how the existing test enumerates types.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:main -- runtime-effects`
Expected: FAIL — `template` missing from the registry.

- [ ] **Step 3: Write minimal implementation**

Import, alongside the other record-sync service imports:

```ts
import { initTemplateSyncService, resetTemplateSyncService } from './template-sync'
```

Add to `resetSyncServiceSingletons()` before its closing brace:

```ts
resetTemplateSyncService()
```

Add the init next to the other services (after `calendarExternalEventSync`):

```ts
const templateSync = initTemplateSyncService({ queue, db: runtimeSyncDb, getDeviceId })
```

Add the registry entry before the `])` that closes `createSyncAdapterRegistry`:

```ts
          {
            type: 'template',
            kind: 'record',
            local: templateSync,
            remote: getRemoteSyncAdapter('template')
          }
```

Mind the comma on the now-penultimate `calendar_external_event` entry.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop test:main -- runtime-effects` → PASS. Then `pnpm typecheck`.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/sync/runtime.ts apps/desktop/src/main/sync/runtime-effects.test.ts
git commit -m "feat(sync): wire template sync into runtime"
```

---

### Task 8: Manifest check

**Files:**

- Modify: `apps/desktop/src/main/sync/manifest-check.ts` — `getLocalSyncableItems` (~L140-143, after the `savedFilters` block)
- Test: `apps/desktop/src/main/sync/manifest-check.test.ts` (extend)

**Interfaces:**

- Consumes: `templates` (Task 2).
- Produces: clocked template rows now participate in manifest repair.

Without this, a template that exists locally but is missing from the server manifest is never re-enqueued.

- [ ] **Step 1: Write the failing test**

Assert that a clocked template row is returned as a local syncable item (and an unclocked one is not), following the file's existing conventions.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:main -- manifest-check`
Expected: FAIL — template absent from local items.

- [ ] **Step 3: Write minimal implementation**

Add the import:

```ts
import { templates } from '@memry/db-schema/schema/templates'
```

Add after the `savedFilters` block in `getLocalSyncableItems`:

```ts
const syncedTemplates = db.select().from(templates).where(isNotNull(templates.clock)).all()
for (const t of syncedTemplates) {
  addLocalItem({ id: t.id, type: 'template', payload: JSON.stringify(t) })
}
```

`LocalSyncableItem.type` is `RecordSyncItemType`, which includes `'template'` from Task 1.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop test:main -- manifest-check` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/sync/manifest-check.ts apps/desktop/src/main/sync/manifest-check.test.ts
git commit -m "feat(sync): include templates in manifest integrity check"
```

---

### Task 9: Server telemetry domain

**Files:**

- Modify: `apps/sync-server/src/services/sync-telemetry.ts` — `SyncDomain` union (~L8-19), `toSyncDomain` (~L30-60)
- Test: `apps/sync-server/src/services/sync-telemetry.test.ts`

**Interfaces:**

- Produces: `toSyncDomain('template') === 'templates'`.

This is the **only** sync-server change Plan B needs — the server is otherwise type-agnostic (D1 metadata + opaque encrypted R2 blobs), and `sync_items.item_type` has no CHECK constraint, so no D1 migration. Note `getStorageBreakdown`'s switch (`services/storage.ts:47`) is `default`-terminated over `row.item_type: string`, so templates silently land in `other` with no typecheck error — that is acceptable and needs no edit.

- [ ] **Step 1: Write the failing test**

```ts
it('maps template to the templates domain', () => {
  expect(toSyncDomain('template')).toBe('templates')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/sync-server test -- sync-telemetry`
Expected: FAIL. And `pnpm --filter @memry/sync-server typecheck` fails with _"Function lacks ending return statement and return type does not include 'undefined'"_ — the switch is non-exhaustive over the widened `SyncItemType` (this has been failing since Task 1).

- [ ] **Step 3: Write minimal implementation**

Add `'templates'` to the `SyncDomain` union, and the case to `toSyncDomain` before its closing brace:

```ts
    case 'template':
      return 'templates'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/sync-server test -- sync-telemetry` → PASS.
Run: `pnpm --filter @memry/sync-server typecheck` → no errors; the switch is exhaustive again.

- [ ] **Step 5: Commit**

```bash
git add apps/sync-server/src/services/sync-telemetry.ts apps/sync-server/src/services/sync-telemetry.test.ts
git commit -m "feat(sync-server): map template item type to templates domain"
```

---

### Task 10: Move template CRUD into the DB

**Files:**

- Rewrite: `apps/desktop/src/main/vault/templates.ts`
- Test: `apps/desktop/src/main/vault/templates.test.ts` (rewrite)

**Interfaces:**

- Consumes: `templates` (Task 2); `enqueueLocalSyncCreate/Update/Delete` (Task 6); `getDatabase` from `../database`.
- Produces — the **public signatures must not change**, so `main/ipc/templates-handlers.ts` and the renderer stay untouched:
  - `listTemplates(): Promise<TemplateListItem[]>`
  - `getTemplate(id: string): Promise<Template | null>`
  - `createTemplate(input: TemplateCreateInput): Promise<Template>`
  - `updateTemplate(input: TemplateUpdateInput): Promise<Template>`
  - `deleteTemplate(id: string): Promise<void>`
  - `duplicateTemplate(id: string, newName: string): Promise<Template>`
  - `applyTemplate(template: Template, title: string): { content: string; tags: string[]; properties: Record<string, unknown> }` — unchanged, pure.
  - `BUILT_IN_TEMPLATES` — now **exported** so Task 11's migration can identify built-in ids.

**Ordering — do NOT delete `parseTemplate` in this task.** Task 11 is what relocates it into `templates-migration.ts`. Removing it here would leave the tree unbuildable between the two commits. Leave `parseTemplate` (and its `matter` import and `TemplateFrontmatter` interface) exactly where they are; Task 11 deletes them from this file once the migration module owns them.

**The critical rule:** every create/update/delete **must call** the `local-mutations` enqueue functions. Registering the adapter (Task 6) alone does nothing — a mutation that bypasses it writes to the DB, seeds once via `seedUnclocked`, and then never syncs again.

**Behaviour changes to preserve:** `updateTemplate` and `deleteTemplate` still throw `VaultError` with `PERMISSION_DENIED` for built-ins. `listTemplates` still sorts built-ins first, then by name. `duplicateTemplate` of a built-in still produces a custom template.

- [ ] **Step 1: Write the failing test**

Rewrite `apps/desktop/src/main/vault/templates.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { templates as templatesTable } from '@memry/db-schema/schema/templates'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'

const enqueueCreate = vi.fn()
const enqueueUpdate = vi.fn()
const enqueueDelete = vi.fn()

vi.mock('../sync/local-mutations', () => ({
  enqueueLocalSyncCreate: (...args: unknown[]) => enqueueCreate(...args),
  enqueueLocalSyncUpdate: (...args: unknown[]) => enqueueUpdate(...args),
  enqueueLocalSyncDelete: (...args: unknown[]) => enqueueDelete(...args)
}))

let testDb: TestDatabaseResult
vi.mock('../database', () => ({ getDatabase: () => testDb.db }))
vi.mock('../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import {
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  duplicateTemplate,
  BUILT_IN_TEMPLATES
} from './templates'

describe('templates CRUD', () => {
  beforeEach(() => {
    testDb = createTestDataDb()
    vi.clearAllMocks()
  })

  afterEach(() => {
    testDb.close()
  })

  it('lists built-ins from code with no DB rows and no files', async () => {
    const list = await listTemplates()
    expect(list.length).toBe(BUILT_IN_TEMPLATES.length)
    expect(list.every((t) => t.isBuiltIn)).toBe(true)
    expect(testDb.db.select().from(templatesTable).all()).toEqual([])
  })

  it('serves a built-in by id without touching the DB', async () => {
    const blank = await getTemplate('blank')
    expect(blank).toMatchObject({ id: 'blank', isBuiltIn: true })
  })

  it('creates a custom template as a row and enqueues it for sync', async () => {
    const created = await createTemplate({ name: 'Standup', content: '## Blockers' })

    expect(created.isBuiltIn).toBe(false)
    expect(
      testDb.db.select().from(templatesTable).where(eq(templatesTable.id, created.id)).get()
    ).toMatchObject({ name: 'Standup', content: '## Blockers' })
    // Registry wiring alone does nothing — the mutation must enqueue.
    expect(enqueueCreate).toHaveBeenCalledWith('template', created.id)
  })

  it('sorts built-ins first, then custom by name', async () => {
    await createTemplate({ name: 'AAA Custom', content: '' })
    const list = await listTemplates()
    expect(list[0].isBuiltIn).toBe(true)
    expect(list[list.length - 1]).toMatchObject({ name: 'AAA Custom', isBuiltIn: false })
  })

  it('updates a custom template and enqueues an update', async () => {
    const created = await createTemplate({ name: 'Standup', content: 'v1' })
    vi.clearAllMocks()

    const updated = await updateTemplate({ id: created.id, content: 'v2' })

    expect(updated.content).toBe('v2')
    expect(enqueueUpdate).toHaveBeenCalledWith('template', created.id)
  })

  it('deletes a custom template and enqueues a delete with a snapshot payload', async () => {
    const created = await createTemplate({ name: 'Standup', content: 'v1' })
    vi.clearAllMocks()

    await deleteTemplate(created.id)

    expect(
      testDb.db.select().from(templatesTable).where(eq(templatesTable.id, created.id)).get()
    ).toBeUndefined()
    expect(enqueueDelete).toHaveBeenCalledWith('template', created.id, expect.any(String))
  })

  it('refuses to modify or delete built-ins', async () => {
    await expect(updateTemplate({ id: 'blank', content: 'x' })).rejects.toThrow()
    await expect(deleteTemplate('blank')).rejects.toThrow()
  })

  it('duplicating a built-in produces a syncable custom template', async () => {
    const copy = await duplicateTemplate('meeting-notes', 'My Meeting Notes')

    expect(copy.isBuiltIn).toBe(false)
    expect(copy.name).toBe('My Meeting Notes')
    expect(enqueueCreate).toHaveBeenCalledWith('template', copy.id)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:main -- vault/templates`
Expected: FAIL — the current implementation reads and writes files.

- [ ] **Step 3: Write minimal implementation**

Rewrite `apps/desktop/src/main/vault/templates.ts`:

- **Keep** the `BUILT_IN_TEMPLATES` array exactly as-is, but `export` it and drop `createdAt`/`modifiedAt` synthesis into a helper (`toBuiltInTemplate(t)` stamping a fixed epoch — built-ins are immutable, so a stable timestamp avoids churn).
- **Delete** `getTemplatesDir`, `ensureTemplatesDir`, `seedBuiltInTemplates`, `serializeTemplate`, `writeTemplate`, `getTemplatePath`, and the `fs`/`getMemryDir` imports. **Keep** `emitTemplateEvent` (the CRUD functions still broadcast through it, so `BrowserWindow` stays), and **keep** `parseTemplate` with its `TemplateFrontmatter` interface and the `path`/`matter` imports it needs — Task 11 relocates those and deletes them from here.
- Row ↔ `Template` mapping:

```ts
function rowToTemplate(row: TemplateRow): Template {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    icon: row.icon ?? null,
    isBuiltIn: false,
    tags: row.tags ?? [],
    properties: (row.properties ?? []) as TemplateProperty[],
    content: row.content,
    createdAt: row.createdAt,
    modifiedAt: row.modifiedAt
  }
}
```

- `listTemplates` returns built-ins mapped to `TemplateListItem` concatenated with rows, keeping the existing sort (built-ins first, then `name.localeCompare`).
- `getTemplate(id)` checks `BUILT_IN_TEMPLATES` first, then the DB, else `null`.
- `createTemplate` inserts a row with `generateNoteId()` and then calls `enqueueLocalSyncCreate('template', id)`.
- `updateTemplate` throws `new VaultError('Cannot modify built-in templates', VaultErrorCode.PERMISSION_DENIED)` for built-in ids, throws `NOT_FOUND` when the row is absent, updates, then calls `enqueueLocalSyncUpdate('template', id)`.
- `deleteTemplate` throws the same way for built-ins, **captures `JSON.stringify(row)` as the snapshot payload before deleting**, deletes, then calls `enqueueLocalSyncDelete('template', id, snapshot)`. The snapshot is required — `enqueueDelete` returns early without it and the tombstone never syncs.
- `duplicateTemplate` stays a thin wrapper over `getTemplate` + `createTemplate`, so it inherits the enqueue.
- Event emission stays on `TemplatesChannels.events.*`, now emitted from the CRUD functions via the existing window-broadcast helper.
- `applyTemplate` is unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop test:main -- vault/templates` → PASS.
Run: `pnpm ipc:generate && pnpm ipc:check` — the contract shape is unchanged, but regenerate anyway.
Run: `pnpm --filter @memry/desktop test:main` → full main suite green.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/vault/templates.ts apps/desktop/src/main/vault/templates.test.ts
git commit -m "refactor(templates): move custom templates into the data DB

Built-ins become code constants served without rows or files. Every mutation
enqueues through local-mutations; registry wiring alone would seed once and
then never sync. Public signatures unchanged, so IPC and renderer are untouched."
```

---

### Task 11: One-time migration of existing template files

**Files:**

- Create: `apps/desktop/src/main/vault/templates-migration.ts`
- Modify: `apps/desktop/src/main/vault/index.ts` — `openVault()` (~L233-262)
- Test: `apps/desktop/src/main/vault/templates-migration.test.ts`

**Interfaces:**

- Consumes: `templates` (Task 2); `BUILT_IN_TEMPLATES` (Task 10); `getSetting`/`setSetting` from `../database/queries/settings`; `getMemryDir` from `./init`.
- Produces: `migrateTemplateFilesToDb(db: DataDb, vaultPath: string): number` (returns the number imported), and `parseTemplate(content: string, filePath: string): Template` moved here from `templates.ts`.

**Guard: `templates.importedFromFiles` settings key.** An existence check ("no rows yet") is wrong — a user who deletes all their templates would have them resurrected on next launch. This introduces a **new convention** (no settings-guarded one-time migration exists in the codebase today; `ensureDefaultTaskProject` uses an existence check and `migrateSettingsToConfig` infers state).

**Old files are left on disk untouched** — zero-risk, and it doubles as the downgrade path.

**`createDormantVault()`** (`sync/vault-provisioning.ts:30`) runs migrations without calling `openVault()`, so the backfill will not run there. That is correct: a dormant vault has no legacy template files.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/main/vault/templates-migration.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import matter from 'gray-matter'
import { templates } from '@memry/db-schema/schema/templates'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { getSetting } from '../database/queries/settings'
import { migrateTemplateFilesToDb } from './templates-migration'

vi.mock('../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

let vaultPath: string
let testDb: TestDatabaseResult

function writeTemplateFile(id: string, frontmatter: Record<string, unknown>, body: string): void {
  const dir = path.join(vaultPath, '.memry', 'templates')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${id}.md`), matter.stringify(body, frontmatter))
}

describe('migrateTemplateFilesToDb', () => {
  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-tpl-migration-'))
    testDb = createTestDataDb()
  })

  afterEach(() => {
    testDb.close()
    fs.rmSync(vaultPath, { recursive: true, force: true })
  })

  it('imports a custom template preserving its frontmatter id', () => {
    writeTemplateFile(
      'abc123',
      {
        id: 'abc123',
        name: 'My Standup',
        isBuiltIn: false,
        tags: ['daily'],
        createdAt: '2026-01-01T00:00:00.000Z',
        modifiedAt: '2026-01-02T00:00:00.000Z'
      },
      '## Blockers'
    )

    expect(migrateTemplateFilesToDb(testDb.db as never, vaultPath)).toBe(1)

    const rows = testDb.db.select().from(templates).all()
    expect(rows).toHaveLength(1)
    // The id MUST be preserved: a vault copied across devices must converge by
    // LWW rather than duplicate.
    expect(rows[0]).toMatchObject({
      id: 'abc123',
      name: 'My Standup',
      content: '## Blockers',
      tags: ['daily'],
      createdAt: '2026-01-01T00:00:00.000Z'
    })
    // clock is NULL so seedUnclocked picks it up and pushes it.
    expect(rows[0].clock).toBeNull()
  })

  it('skips built-in templates', () => {
    writeTemplateFile('blank', { id: 'blank', name: 'Blank Note', isBuiltIn: true }, '')

    expect(migrateTemplateFilesToDb(testDb.db as never, vaultPath)).toBe(0)
    expect(testDb.db.select().from(templates).all()).toEqual([])
  })

  it('is idempotent and does not resurrect deleted templates', () => {
    writeTemplateFile('abc123', { id: 'abc123', name: 'My Standup', isBuiltIn: false }, 'body')

    expect(migrateTemplateFilesToDb(testDb.db as never, vaultPath)).toBe(1)
    expect(getSetting(testDb.db as never, 'templates.importedFromFiles')).toBe('1')

    // Simulate the user deleting the template after migration.
    testDb.db.delete(templates).run()

    expect(migrateTemplateFilesToDb(testDb.db as never, vaultPath)).toBe(0)
    expect(testDb.db.select().from(templates).all()).toEqual([])
  })

  it('leaves the legacy files on disk as a downgrade path', () => {
    writeTemplateFile('abc123', { id: 'abc123', name: 'My Standup', isBuiltIn: false }, 'body')

    migrateTemplateFilesToDb(testDb.db as never, vaultPath)

    expect(fs.existsSync(path.join(vaultPath, '.memry', 'templates', 'abc123.md'))).toBe(true)
  })

  it('falls back to the filename when frontmatter has no id', () => {
    writeTemplateFile('legacy-name', { name: 'Legacy', isBuiltIn: false }, 'body')

    expect(migrateTemplateFilesToDb(testDb.db as never, vaultPath)).toBe(1)
    expect(testDb.db.select().from(templates).all()[0]).toMatchObject({ id: 'legacy-name' })
  })

  it('is a no-op when the templates directory does not exist', () => {
    expect(migrateTemplateFilesToDb(testDb.db as never, vaultPath)).toBe(0)
  })

  it('skips unparseable files without aborting the migration', () => {
    const dir = path.join(vaultPath, '.memry', 'templates')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'broken.md'), '---\nname: [unclosed\n')
    writeTemplateFile('good', { id: 'good', name: 'Good', isBuiltIn: false }, 'body')

    expect(migrateTemplateFilesToDb(testDb.db as never, vaultPath)).toBe(1)
    expect(testDb.db.select().from(templates).all()[0]).toMatchObject({ id: 'good' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:main -- templates-migration`
Expected: FAIL — cannot resolve `./templates-migration`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/desktop/src/main/vault/templates-migration.ts`:

```ts
import fs from 'fs'
import path from 'path'
import { existsSync } from 'fs'
import matter from 'gray-matter'
import { templates } from '@memry/db-schema/schema/templates'
import type { Template, TemplateProperty } from '@memry/contracts/templates-api'
import { getSetting, setSetting } from '../database/queries/settings'
import type { DataDb } from '../database/types'
import { createLogger } from '../lib/logger'
import { getMemryDir } from './init'
import { BUILT_IN_TEMPLATES } from './templates'

const log = createLogger('TemplatesMigration')

const MIGRATION_KEY = 'templates.importedFromFiles'
const TEMPLATES_DIR = 'templates'

const BUILT_IN_IDS = new Set(BUILT_IN_TEMPLATES.map((t) => t.id))

interface TemplateFrontmatter {
  id?: string
  name?: string
  description?: string
  icon?: string | null
  isBuiltIn?: boolean
  tags?: string[]
  properties?: TemplateProperty[]
  createdAt?: string
  modifiedAt?: string
}

/** Moved verbatim from vault/templates.ts — only the migration still needs it. */
export function parseTemplate(content: string, filePath: string): Template {
  const { data, content: body } = matter(content)
  const frontmatter = data as TemplateFrontmatter
  const id = frontmatter.id ?? path.basename(filePath, '.md')

  return {
    id,
    name: frontmatter.name ?? id,
    description: frontmatter.description,
    icon: frontmatter.icon ?? null,
    isBuiltIn: frontmatter.isBuiltIn === true,
    tags: Array.isArray(frontmatter.tags) ? frontmatter.tags : [],
    properties: Array.isArray(frontmatter.properties) ? frontmatter.properties : [],
    content: body.trim(),
    createdAt: frontmatter.createdAt ?? new Date().toISOString(),
    modifiedAt: frontmatter.modifiedAt ?? new Date().toISOString()
  }
}

/**
 * One-time backfill of pre-sync template files into the data DB.
 *
 * Guarded by a settings key rather than an emptiness check: a user who deletes
 * every template must not have them resurrected on the next launch.
 *
 * Rows are inserted with clock = NULL so seedUnclocked stamps a clock and
 * pushes them. Ids come from frontmatter and are never regenerated, so a vault
 * copied between devices converges by LWW instead of duplicating.
 *
 * Legacy files are deliberately left on disk: zero-risk, and an older build
 * downgraded onto this vault still reads them.
 */
export function migrateTemplateFilesToDb(db: DataDb, vaultPath: string): number {
  if (getSetting(db, MIGRATION_KEY) === '1') return 0

  const dir = path.join(getMemryDir(vaultPath), TEMPLATES_DIR)
  if (!existsSync(dir)) {
    setSetting(db, MIGRATION_KEY, '1')
    return 0
  }

  let imported = 0

  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.md')) continue

    const filePath = path.join(dir, file)
    try {
      const template = parseTemplate(fs.readFileSync(filePath, 'utf-8'), filePath)

      if (template.isBuiltIn || BUILT_IN_IDS.has(template.id)) continue

      db.insert(templates)
        .values({
          id: template.id,
          name: template.name,
          description: template.description ?? null,
          icon: template.icon ?? null,
          tags: template.tags,
          properties: template.properties,
          content: template.content,
          clock: null,
          createdAt: template.createdAt,
          modifiedAt: template.modifiedAt
        })
        .onConflictDoNothing()
        .run()

      imported++
    } catch (err) {
      log.warn('Skipping unparseable template file during migration', { file, error: err })
    }
  }

  setSetting(db, MIGRATION_KEY, '1')
  log.info('Imported legacy template files', { imported })

  return imported
}
```

In `apps/desktop/src/main/vault/index.ts`, import it and call it inside `openVault()` right after `migrateSettingsToConfig(dataDb, vaultPath)`:

```ts
import { migrateTemplateFilesToDb } from './templates-migration'

// ...inside openVault(), after migrateSettingsToConfig(dataDb, vaultPath):
migrateTemplateFilesToDb(dataDb, vaultPath)
```

**Now complete the relocation Task 10 deferred.** `templates-migration.ts` owns `parseTemplate`, so delete `parseTemplate`, the `TemplateFrontmatter` interface, and the now-unused `matter` / `path` imports from `apps/desktop/src/main/vault/templates.ts`. Doing it here rather than in Task 10 is what keeps every commit buildable. Run `pnpm lint` — it flags any import this orphans.

Guard against the import cycle: `templates-migration.ts` imports `BUILT_IN_TEMPLATES` from `./templates`, so `templates.ts` must **not** import anything from `templates-migration.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop test:main -- templates-migration` → PASS (7 tests).
Run: `pnpm --filter @memry/desktop test:main` → full main suite green.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/vault/templates-migration.ts apps/desktop/src/main/vault/templates-migration.test.ts apps/desktop/src/main/vault/index.ts
git commit -m "feat(templates): import existing template files into the data DB

One-time, settings-guarded so deleted templates are never resurrected. Ids
come from frontmatter and are never regenerated. Rows land with clock NULL so
seedUnclocked pushes them. Legacy files stay on disk as the downgrade path."
```

---

### Task 12: Dual-device E2E

**Files:**

- Create: `apps/desktop/tests/e2e/fixtures/legacy-template-fixtures.ts`
- Create: `apps/desktop/tests/e2e/templates-sync.e2e.ts`

**Interfaces:**

- Consumes: `test`/`expect` from `./fixtures/sync-auth-fixtures` (`electronAppA`, `electronAppB`, `pageA`, `pageB`, `bootstrappedSyncPair`, `vaultPathA`, `vaultPathB`); `goOffline`/`goOnline`/`syncBothAndWait`/`waitForSyncOnline`/`waitForSyncOffline` from `./utils/network-control`.
- Produces: a `test` export extending `sync-auth-fixtures` with a `seededLegacyTemplate` fixture.

**Pre-launch vault seeding does not exist in this repo.** Every current E2E seeds _after_ launch and forces a reindex. The migration case needs the file present _before_ the app opens the vault, which means overriding `vaultPathA` (Playwright resolves it before `electronAppA`, which depends on it). Task 12 introduces that pattern.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/tests/e2e/fixtures/legacy-template-fixtures.ts`:

```ts
import fs from 'fs'
import path from 'path'
import matter from 'gray-matter'
import { test as base } from './sync-auth-fixtures'

export const LEGACY_TEMPLATE_ID = 'legacy-tpl-1'
export const LEGACY_TEMPLATE_NAME = 'Legacy Standup'
export const LEGACY_TEMPLATE_BODY = '## Legacy Blockers'

/**
 * Writes a pre-sync template file into device A's vault BEFORE the app launches.
 *
 * vaultPathA is overridden rather than written from the test body because
 * electronAppA depends on vaultPathA, so Playwright resolves this fixture first.
 * Every other e2e seeds after launch and reindexes; the migration only runs on
 * vault open, so it must be on disk beforehand.
 */
export const test = base.extend<{ seededLegacyTemplate: void }>({
  vaultPathA: async ({ vaultPathA }, use) => {
    const dir = path.join(vaultPathA, '.memry', 'templates')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, `${LEGACY_TEMPLATE_ID}.md`),
      matter.stringify(LEGACY_TEMPLATE_BODY, {
        id: LEGACY_TEMPLATE_ID,
        name: LEGACY_TEMPLATE_NAME,
        isBuiltIn: false,
        tags: ['daily'],
        createdAt: '2026-01-01T00:00:00.000Z',
        modifiedAt: '2026-01-01T00:00:00.000Z'
      })
    )
    await use(vaultPathA)
  },

  seededLegacyTemplate: async ({ vaultPathA }, use) => {
    void vaultPathA
    await use()
  }
})

export { expect } from './sync-auth-fixtures'
```

Create `apps/desktop/tests/e2e/templates-sync.e2e.ts`:

```ts
import { test, expect } from './fixtures/sync-auth-fixtures'
import {
  test as legacyTest,
  expect as legacyExpect,
  LEGACY_TEMPLATE_ID,
  LEGACY_TEMPLATE_NAME
} from './fixtures/legacy-template-fixtures'
import { goOffline, goOnline, syncBothAndWait, waitForSyncOnline } from './utils/network-control'
import type { Page } from '@playwright/test'

async function createTemplate(page: Page, name: string, content: string): Promise<string> {
  return page.evaluate(
    async ({ name, content }) => {
      const result = await window.api.templates.create({ name, content })
      if (!result.success || !result.template) throw new Error('template create failed')
      return result.template.id
    },
    { name, content }
  )
}

async function listTemplateNames(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const result = await window.api.templates.list()
    return result.templates.map((t) => t.name)
  })
}

async function getTemplateContent(page: Page, id: string): Promise<string | null> {
  return page.evaluate(async (templateId) => {
    const template = await window.api.templates.get(templateId)
    return template?.content ?? null
  }, id)
}

test.describe('Custom template sync', () => {
  test('T1: a template created on A appears on B', async ({
    pageA,
    pageB,
    bootstrappedSyncPair
  }) => {
    void bootstrappedSyncPair
    const name = `T1 Standup ${Date.now()}`

    const id = await createTemplate(pageA, name, '## Blockers')
    expect(await listTemplateNames(pageB)).not.toContain(name)

    await syncBothAndWait(pageA, pageB)

    expect(await listTemplateNames(pageB)).toContain(name)
    expect(await getTemplateContent(pageB, id)).toBe('## Blockers')
  })

  test('T2: an edit on A propagates to B', async ({ pageA, pageB, bootstrappedSyncPair }) => {
    void bootstrappedSyncPair
    const name = `T2 Standup ${Date.now()}`

    const id = await createTemplate(pageA, name, 'v1')
    await syncBothAndWait(pageA, pageB)

    await pageA.evaluate(async (templateId) => {
      await window.api.templates.update({ id: templateId, content: 'v2' })
    }, id)
    await syncBothAndWait(pageA, pageB)

    expect(await getTemplateContent(pageB, id)).toBe('v2')
  })

  test('T3: a delete on A tombstones on B', async ({ pageA, pageB, bootstrappedSyncPair }) => {
    void bootstrappedSyncPair
    const name = `T3 Standup ${Date.now()}`

    const id = await createTemplate(pageA, name, 'v1')
    await syncBothAndWait(pageA, pageB)
    expect(await listTemplateNames(pageB)).toContain(name)

    await pageA.evaluate(async (templateId) => {
      await window.api.templates.delete(templateId)
    }, id)
    await syncBothAndWait(pageA, pageB)

    expect(await listTemplateNames(pageB)).not.toContain(name)
    expect(await getTemplateContent(pageB, id)).toBeNull()
  })

  test('T4: concurrent offline edits converge by LWW without looping', async ({
    electronAppA,
    electronAppB,
    pageA,
    pageB,
    bootstrappedSyncPair
  }) => {
    void bootstrappedSyncPair
    const name = `T4 Standup ${Date.now()}`

    const id = await createTemplate(pageA, name, 'base')
    await syncBothAndWait(pageA, pageB)

    await goOffline(electronAppA, electronAppB)
    await pageA.evaluate(async (t) => {
      await window.api.templates.update({ id: t, content: 'from-A' })
    }, id)
    await pageB.evaluate(async (t) => {
      await window.api.templates.update({ id: t, content: 'from-B' })
    }, id)

    await goOnline(electronAppA, electronAppB)
    await Promise.all([waitForSyncOnline(pageA), waitForSyncOnline(pageB)])
    await syncBothAndWait(pageA, pageB)

    const contentA = await getTemplateContent(pageA, id)
    const contentB = await getTemplateContent(pageB, id)
    expect(contentA).toBe(contentB)
    expect(['from-A', 'from-B']).toContain(contentA)
  })

  test('T6: built-ins exist on both devices and never duplicate', async ({
    pageA,
    pageB,
    bootstrappedSyncPair
  }) => {
    void bootstrappedSyncPair
    await syncBothAndWait(pageA, pageB)

    for (const page of [pageA, pageB]) {
      const names = await listTemplateNames(page)
      const blanks = names.filter((n) => n === 'Blank Note')
      expect(blanks).toHaveLength(1)
    }
  })
})

legacyTest.describe('Legacy template migration', () => {
  legacyTest(
    'T5: a pre-sync template file on A is migrated and reaches B',
    async ({ pageA, pageB, bootstrappedSyncPair }) => {
      void bootstrappedSyncPair

      // A's vault had the file on disk before launch; openVault should have
      // imported it with clock NULL, and seedUnclocked should have pushed it.
      legacyExpect(await listTemplateNames(pageA)).toContain(LEGACY_TEMPLATE_NAME)

      await syncBothAndWait(pageA, pageB)

      legacyExpect(await listTemplateNames(pageB)).toContain(LEGACY_TEMPLATE_NAME)
      legacyExpect(await getTemplateContent(pageB, LEGACY_TEMPLATE_ID)).toBe('## Legacy Blockers')
    }
  )
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:e2e -- templates-sync`
Expected: FAIL — templates do not sync yet if Tasks 1-11 are incomplete; if they are complete, this should be the pass that proves the feature.
Rebuild first if the app is stale: `pnpm --filter @memry/desktop exec electron-vite build`. On native load errors: `pnpm --filter @memry/desktop rebuild:electron`.

- [ ] **Step 3: Write minimal implementation**

No implementation — Tasks 1-11 are the implementation. If a test fails here, fix the underlying task rather than weakening the test.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop test:e2e -- templates-sync`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/tests/e2e/fixtures/legacy-template-fixtures.ts apps/desktop/tests/e2e/templates-sync.e2e.ts
git commit -m "test(e2e): dual-device custom template sync

Covers create/edit/delete propagation, concurrent-offline LWW, built-in
de-duplication, and legacy file migration reaching the second device. Adds the
first pre-launch vault seeding fixture."
```

---

## Verification (run before pushing)

- [ ] `pnpm --filter @memry/contracts test` — four arrays + payload schema.
- [ ] `pnpm --filter @memry/db-schema test` — table exported from both barrels.
- [ ] `pnpm --filter @memry/desktop test:main -- migrate-journal` — the `when` invariant.
- [ ] `pnpm --filter @memry/desktop test:main` — handler, service, offline clock, local mutations, runtime, manifest, CRUD, migration.
- [ ] `pnpm --filter @memry/sync-server test && pnpm --filter @memry/sync-server typecheck` — exhaustive `toSyncDomain`.
- [ ] `pnpm ipc:generate && pnpm ipc:check`
- [ ] `pnpm typecheck` — catches any missed array or switch.
- [ ] `pnpm lint` and `git diff --check`
- [ ] `pnpm check:contracts && pnpm check:architecture`
- [ ] `pnpm --filter @memry/desktop test:e2e -- templates-sync`
- [ ] `pnpm docs:impact --base origin/main --strict`; if `missing-docs`, update `apps/docs/src/**` or run `pnpm docs:ai-update --base origin/main`, then re-run and `pnpm docs:build`.

**Manual two-profile check:** `pnpm --filter @memry/desktop dev:a` + `dev:b` on one linked vault. Create a template on A → it appears on B. Edit on both concurrently → LWW resolves, no sync loop. Confirm built-ins are not duplicated on either device.

**Manual upgrade check (the one that protects real users):** open a vault that already contains `.memry/templates/*.md` custom templates with a build from this branch. Confirm every custom template still appears in the UI, that the files remain on disk, and that the templates reach a second device after sync.

## Release gate

Do not ship a desktop build from this plan until **Plan A is deployed to production**. Verify the deployed server is serving the legacy list to header-less clients before releasing.
