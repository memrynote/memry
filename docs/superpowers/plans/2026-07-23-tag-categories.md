# Tag Categories + Tag Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users group tags into named categories with a manual synced order, and replace the sidebar tag drill-down with a full tab that shows a tag's notes, tasks, and inbox items in the folder-view table.

**Architecture:** A new `tag_categories` table plus two additive columns on `tag_definitions` carry the grouping. Categories sync as a new `tag_category` record type using the same field-level vector-clock handler pattern as `folder_config`. Two new tab types — a singleton `tags` hub and an entity-keyed `tag` page — replace `TagDetailView`. The tag page reuses the existing presentational `FolderTableView` with one added row discriminator.

**Tech Stack:** Electron, React 19, TypeScript, Drizzle ORM over better-sqlite3, Zod v4, TanStack Table + Virtual, dnd-kit, Vitest, Playwright.

**Design spec:** [`docs/superpowers/specs/2026-07-23-tag-categories-design.md`](../specs/2026-07-23-tag-categories-design.md)

## Global Constraints

- **Production app, backward compatibility is mandatory.** No DB resets. Data-DB migrations are hand-written additive SQL — Drizzle snapshots have been broken since 0021, so `db:generate` is not the source of truth here.
- **Logging:** always `createLogger('Scope')`, never raw `console.*`.
- **User-facing errors:** always `extractErrorMessage(err, fallback)` from `@/lib/ipc-error`.
- **IPC boundary:** every renderer↔main call goes through `packages/contracts`. Run `pnpm ipc:generate` then `pnpm ipc:check` after touching contracts, preload, or main IPC handlers.
- **Tailwind logical properties (RTL):** new code uses `ms-*`/`me-*`, `ps-*`/`pe-*`, `start-*`/`end-*`, `text-start`/`text-end`, `border-s`/`border-e`, `rounded-s-*`/`rounded-e-*`. Never the physical variants.
- **i18n:** every user-visible string goes through `useT(ns)`. ICU uses single braces. Run `pnpm --filter @memry/desktop i18n:check`.
- **Zod v4:** `z.record(z.unknown())` throws in `safeParse` — always `z.record(z.string(), z.unknown())`.
- **Drizzle:** nullable JSON columns need `null`, not `undefined`, in `.values()` inserts.
- **No foreign key on `tag_definitions.category_id`.** A cascade FK on a synced table caused an orphan loop that broke production sync (#837). A dangling `category_id` reads as uncategorized.
- **Branch:** `tag-categories`. No agent/tool branding in commits or PR text. No `Co-Authored-By` trailers.
- **Tag names are stored lowercased and trimmed**, and the `name` column is `NOCASE`. Every lookup normalizes with `.toLowerCase().trim()`.

## Phase structure

Four phases. Each ends green and is independently reviewable. Phase 1 ships no UI but leaves the data layer complete and tested; Phases 2–4 are user-visible.

| Phase                 | Tasks | Deliverable                                                 |
| --------------------- | ----- | ----------------------------------------------------------- |
| 1 — Data + sync + IPC | 1–6   | Categories exist, persist, sync, and are reachable over IPC |
| 2 — Hub page          | 7–13  | The `tags` hub tab: create, rename, delete, drag, search    |
| 3 — Tag page          | 14–18 | The `tag` tab with the shared table                         |
| 4 — Sidebar migration | 19–21 | Sidebar groups by category; drill-down deleted; docs        |

## File structure

**Phase 1**

- Create `packages/db-schema/src/schema/tag-categories.ts` — Drizzle table definition, nothing else.
- Modify `packages/db-schema/src/schema/index.ts` — export the new table.
- Modify `packages/db-schema/src/schema/tag-definitions.ts` — add `categoryId`, `sortOrder`.
- Create `apps/desktop/src/main/database/drizzle-data/0038_tag_categories.sql` — the migration.
- Create `apps/desktop/src/main/database/queries/tag-categories.ts` — category CRUD and reorder. Owns every category SQL statement.
- Modify `apps/desktop/src/main/database/queries/tag-definitions.ts` — category assignment reads/writes only.
- Modify `packages/contracts/src/sync-api.ts` — register `tag_category`.
- Modify `packages/contracts/src/sync-payloads.ts` — add the category payload, extend the tag payload.
- Create `apps/desktop/src/main/sync/item-handlers/tag-category-handler.ts` — one handler, mirrors `folder-config-handler.ts`.
- Modify `apps/desktop/src/main/sync/item-handlers/index.ts` — register it.
- Modify `apps/desktop/src/main/sync/item-handlers/tag-definition-handler.ts` — carry the two new fields.
- Modify `packages/contracts/src/ipc-channels.ts` — new channels on `TagsChannels`.
- Modify `apps/desktop/src/main/ipc/tags-handlers.ts` — wire the channels.
- Modify `apps/desktop/src/renderer/src/services/tags-service.ts` — renderer-side callers.

**Phase 2**

- Create `apps/desktop/src/renderer/src/pages/tags-hub.tsx` — page shell and layout only.
- Create `apps/desktop/src/renderer/src/components/tags-hub/category-block.tsx` — one category heading plus its chip row.
- Create `apps/desktop/src/renderer/src/components/tags-hub/tag-chip-item.tsx` — a single draggable chip.
- Create `apps/desktop/src/renderer/src/components/tags-hub/inline-create-row.tsx` — the two create affordances.
- Create `apps/desktop/src/renderer/src/hooks/use-tag-categories.ts` — data + mutations for the hub.

**Phase 3**

- Create `apps/desktop/src/renderer/src/pages/tag-view.tsx` — page shell, header, toolbar.
- Create `apps/desktop/src/renderer/src/hooks/use-tag-items.ts` — fetches and adapts notes/tasks/inbox into table rows.
- Modify `apps/desktop/src/renderer/src/hooks/use-folder-view.ts` — add `kind` to the row type.
- Modify `apps/desktop/src/renderer/src/components/folder-view/folder-table-view.tsx` — render the Kind column when present.

**Phase 4**

- Modify `apps/desktop/src/renderer/src/components/sidebar/sidebar-tag-list.tsx` — grouping and Manual sort.
- Delete `apps/desktop/src/renderer/src/components/sidebar/tag-detail-view.tsx` and its test.
- Modify `apps/desktop/src/renderer/src/contexts/sidebar-drill-down.tsx` — remove the tag branch.

---

# Phase 1 — Data, sync, IPC

### Task 1: `tag_categories` table and migration

**Files:**

- Create: `packages/db-schema/src/schema/tag-categories.ts`
- Modify: `packages/db-schema/src/schema/index.ts`
- Modify: `packages/db-schema/src/schema/tag-definitions.ts`
- Create: `apps/desktop/src/main/database/drizzle-data/0038_tag_categories.sql`
- Test: `apps/desktop/src/main/database/tag-categories-schema.test.ts`

**Interfaces:**

- Produces: `tagCategories` Drizzle table with columns `id`, `name`, `sortOrder`, `clock`, `createdAt`, `updatedAt`, `deletedAt`. Types `TagCategory` and `NewTagCategory`. `tagDefinitions` gains `categoryId: string | null` and `sortOrder: number`.

- [ ] **Step 1: Write the failing test**

Model it on the existing `project-links-schema.test.ts`, which opens an in-memory DB, runs the migrations, and asserts the table shape.

```ts
// apps/desktop/src/main/database/tag-categories-schema.test.ts
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function migratedDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE tag_definitions (
      name TEXT PRIMARY KEY COLLATE NOCASE NOT NULL,
      color TEXT NOT NULL,
      icon TEXT,
      clock TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `)
  db.exec(readFileSync(join(__dirname, 'drizzle-data/0038_tag_categories.sql'), 'utf8'))
  return db
}

describe('0038_tag_categories migration', () => {
  it('creates tag_categories with the expected columns', () => {
    const db = migratedDb()
    const cols = db.prepare('PRAGMA table_info(tag_categories)').all() as { name: string }[]
    expect(cols.map((c) => c.name).sort()).toEqual(
      ['clock', 'created_at', 'deleted_at', 'id', 'name', 'sort_order', 'updated_at'].sort()
    )
  })

  it('adds category_id and sort_order to tag_definitions without touching existing rows', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE tag_definitions (
        name TEXT PRIMARY KEY COLLATE NOCASE NOT NULL,
        color TEXT NOT NULL,
        icon TEXT,
        clock TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
    `)
    db.prepare("INSERT INTO tag_definitions (name, color) VALUES ('work', 'blue')").run()

    db.exec(readFileSync(join(__dirname, 'drizzle-data/0038_tag_categories.sql'), 'utf8'))

    const row = db.prepare("SELECT * FROM tag_definitions WHERE name = 'work'").get() as {
      color: string
      category_id: string | null
      sort_order: number
    }
    expect(row.color).toBe('blue')
    expect(row.category_id).toBeNull()
    expect(row.sort_order).toBe(0)
  })

  it('is safe to re-run for the table creation', () => {
    const db = migratedDb()
    expect(() =>
      db.exec(`
        CREATE TABLE IF NOT EXISTS tag_categories (
          id TEXT PRIMARY KEY NOT NULL,
          name TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          clock TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          deleted_at TEXT
        );
      `)
    ).not.toThrow()
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
pnpm --filter @memry/desktop test:main -- tag-categories-schema
```

Expected: FAIL — `ENOENT` on `drizzle-data/0038_tag_categories.sql`.

- [ ] **Step 3: Write the migration**

```sql
-- apps/desktop/src/main/database/drizzle-data/0038_tag_categories.sql
CREATE TABLE IF NOT EXISTS tag_categories (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  clock TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_tag_categories_sort ON tag_categories (sort_order);

ALTER TABLE tag_definitions ADD COLUMN category_id TEXT;
ALTER TABLE tag_definitions ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_tag_definitions_category ON tag_definitions (category_id);
```

`ALTER TABLE ... ADD COLUMN` is not idempotent in SQLite. That is fine and matches every other migration here — the migrator runs each file once. Do not wrap it in a guard.

- [ ] **Step 4: Write the Drizzle schema**

```ts
// packages/db-schema/src/schema/tag-categories.ts
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

export const tagCategories = sqliteTable(
  'tag_categories',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    clock: text('clock', { mode: 'json' }),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    deletedAt: text('deleted_at')
  },
  (table) => [index('idx_tag_categories_sort').on(table.sortOrder)]
)

export type TagCategory = typeof tagCategories.$inferSelect
export type NewTagCategory = typeof tagCategories.$inferInsert
```

- [ ] **Step 5: Extend `tag_definitions` schema**

In `packages/db-schema/src/schema/tag-definitions.ts`, add two fields to the existing table body (keep the rest untouched) and add `integer` to the `drizzle-orm/sqlite-core` import:

```ts
  categoryId: text('category_id'),
  sortOrder: integer('sort_order').notNull().default(0),
```

- [ ] **Step 6: Export from the schema barrel**

Add to `packages/db-schema/src/schema/index.ts`, following the existing export style in that file:

```ts
export * from './tag-categories.ts'
```

- [ ] **Step 7: Run the tests**

```bash
pnpm --filter @memry/desktop test:main -- tag-categories-schema
```

Expected: PASS, 3 tests.

- [ ] **Step 8: Typecheck**

```bash
pnpm typecheck
```

Expected: no new errors. Pre-existing errors in `websocket.test.ts` and `folders.test.ts` are known and ignored.

- [ ] **Step 9: Commit**

```bash
git add packages/db-schema/src/schema apps/desktop/src/main/database
git commit -m "feat(tags): add tag_categories table and category columns on tag_definitions"
```

---

### Task 2: Category queries

**Files:**

- Create: `apps/desktop/src/main/database/queries/tag-categories.ts`
- Modify: `apps/desktop/src/main/database/queries/tag-definitions.ts`
- Test: `apps/desktop/src/main/database/queries/tag-categories.test.ts`

**Interfaces:**

- Consumes: `tagCategories`, `tagDefinitions` from Task 1.
- Produces:
  - `listTagCategories(db): TagCategoryRow[]` where `TagCategoryRow = { id: string; name: string; sortOrder: number; tagCount: number }`, ordered by `sortOrder` then `name`, excluding soft-deleted rows.
  - `createTagCategory(db, name: string): TagCategoryRow` — appends at the end.
  - `renameTagCategory(db, id: string, name: string): void`
  - `deleteTagCategory(db, id: string): void` — soft delete; clears `category_id` on member tags.
  - `reorderTags(db, assignments: TagAssignment[]): void` where `TagAssignment = { tag: string; categoryId: string | null; sortOrder: number }` — one transaction.
  - `reorderCategories(db, order: { id: string; sortOrder: number }[]): void` — one transaction.
  - `setTagCategory(db, tag: string, categoryId: string | null): void` in `tag-definitions.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/main/database/queries/tag-categories.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import {
  listTagCategories,
  createTagCategory,
  renameTagCategory,
  deleteTagCategory,
  reorderTags,
  reorderCategories
} from './tag-categories'
import { createTestDataDb, type TestDataDb } from '../../../test/helpers/test-data-db'
import { getOrCreateTag } from './tag-definitions'

let db: TestDataDb

beforeEach(() => {
  db = createTestDataDb()
})

describe('tag categories', () => {
  it('creates a category and appends it at the end', () => {
    const work = createTagCategory(db, 'Work')
    const books = createTagCategory(db, 'Books')

    expect(work.sortOrder).toBe(0)
    expect(books.sortOrder).toBe(1)
    expect(listTagCategories(db).map((c) => c.name)).toEqual(['Work', 'Books'])
  })

  it('counts the tags in each category', () => {
    const work = createTagCategory(db, 'Work')
    getOrCreateTag(db, 'meetings')
    getOrCreateTag(db, 'okr')
    getOrCreateTag(db, 'idea')
    reorderTags(db, [
      { tag: 'meetings', categoryId: work.id, sortOrder: 0 },
      { tag: 'okr', categoryId: work.id, sortOrder: 1 }
    ])

    expect(listTagCategories(db)[0].tagCount).toBe(2)
  })

  it('renames a category', () => {
    const c = createTagCategory(db, 'Work')
    renameTagCategory(db, c.id, 'Job')
    expect(listTagCategories(db)[0].name).toBe('Job')
  })

  it('deleting a category keeps its tags and uncategorizes them', () => {
    const work = createTagCategory(db, 'Work')
    getOrCreateTag(db, 'meetings')
    reorderTags(db, [{ tag: 'meetings', categoryId: work.id, sortOrder: 0 }])

    deleteTagCategory(db, work.id)

    expect(listTagCategories(db)).toEqual([])
    expect(getOrCreateTag(db, 'meetings').categoryId).toBeNull()
  })

  it('moves a tag between categories in one call', () => {
    const work = createTagCategory(db, 'Work')
    const books = createTagCategory(db, 'Books')
    getOrCreateTag(db, 'notes')
    reorderTags(db, [{ tag: 'notes', categoryId: work.id, sortOrder: 0 }])

    reorderTags(db, [{ tag: 'notes', categoryId: books.id, sortOrder: 0 }])

    const [w, b] = listTagCategories(db)
    expect(w.tagCount).toBe(0)
    expect(b.tagCount).toBe(1)
  })

  it('reorders categories', () => {
    const work = createTagCategory(db, 'Work')
    const books = createTagCategory(db, 'Books')

    reorderCategories(db, [
      { id: books.id, sortOrder: 0 },
      { id: work.id, sortOrder: 1 }
    ])

    expect(listTagCategories(db).map((c) => c.name)).toEqual(['Books', 'Work'])
  })

  it('normalizes tag names when assigning', () => {
    const work = createTagCategory(db, 'Work')
    getOrCreateTag(db, 'meetings')
    reorderTags(db, [{ tag: '  MEETINGS ', categoryId: work.id, sortOrder: 0 }])
    expect(listTagCategories(db)[0].tagCount).toBe(1)
  })
})
```

If `apps/desktop/src/test/helpers/test-data-db.ts` does not exist, create it in this task: it opens `better-sqlite3` in-memory, applies every file in `drizzle-data/` in filename order, and returns the Drizzle handle typed as `DataDb`. Search the repo for an existing in-memory data-DB helper first (`rtk grep -rn "new Database(':memory:')" apps/desktop/src`) and reuse it rather than adding a second one.

- [ ] **Step 2: Run it to make sure it fails**

```bash
pnpm --filter @memry/desktop test:main -- queries/tag-categories
```

Expected: FAIL — cannot resolve `./tag-categories`.

- [ ] **Step 3: Implement the queries**

```ts
// apps/desktop/src/main/database/queries/tag-categories.ts
import { randomUUID } from 'node:crypto'
import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { tagCategories } from '@memry/db-schema/schema/tag-categories'
import { tagDefinitions } from '@memry/db-schema/schema/tag-definitions'
import { utcNow } from '@memry/shared/utc'
import type { DataDb } from '../types'

export interface TagCategoryRow {
  id: string
  name: string
  sortOrder: number
  tagCount: number
}

export interface TagAssignment {
  tag: string
  categoryId: string | null
  sortOrder: number
}

const normalize = (tag: string): string => tag.toLowerCase().trim()

export function listTagCategories(db: DataDb): TagCategoryRow[] {
  return db
    .select({
      id: tagCategories.id,
      name: tagCategories.name,
      sortOrder: tagCategories.sortOrder,
      tagCount: sql<number>`(
        SELECT COUNT(*) FROM tag_definitions
        WHERE tag_definitions.category_id = ${tagCategories.id}
      )`
    })
    .from(tagCategories)
    .where(isNull(tagCategories.deletedAt))
    .orderBy(asc(tagCategories.sortOrder), asc(tagCategories.name))
    .all()
}

export function createTagCategory(db: DataDb, name: string): TagCategoryRow {
  const trimmed = name.trim()
  const next = db
    .select({ max: sql<number | null>`MAX(${tagCategories.sortOrder})` })
    .from(tagCategories)
    .where(isNull(tagCategories.deletedAt))
    .get()
  const sortOrder = (next?.max ?? -1) + 1
  const id = randomUUID()
  const now = utcNow()

  db.insert(tagCategories)
    .values({ id, name: trimmed, sortOrder, clock: null, createdAt: now, updatedAt: now })
    .run()

  return { id, name: trimmed, sortOrder, tagCount: 0 }
}

export function renameTagCategory(db: DataDb, id: string, name: string): void {
  db.update(tagCategories)
    .set({ name: name.trim(), updatedAt: utcNow() })
    .where(eq(tagCategories.id, id))
    .run()
}

export function deleteTagCategory(db: DataDb, id: string): void {
  db.transaction((tx) => {
    tx.update(tagDefinitions)
      .set({ categoryId: null })
      .where(eq(tagDefinitions.categoryId, id))
      .run()
    tx.update(tagCategories)
      .set({ deletedAt: utcNow(), updatedAt: utcNow() })
      .where(eq(tagCategories.id, id))
      .run()
  })
}

export function reorderTags(db: DataDb, assignments: TagAssignment[]): void {
  db.transaction((tx) => {
    for (const a of assignments) {
      tx.update(tagDefinitions)
        .set({ categoryId: a.categoryId, sortOrder: a.sortOrder })
        .where(eq(tagDefinitions.name, normalize(a.tag)))
        .run()
    }
  })
}

export function reorderCategories(db: DataDb, order: { id: string; sortOrder: number }[]): void {
  const now = utcNow()
  db.transaction((tx) => {
    for (const o of order) {
      tx.update(tagCategories)
        .set({ sortOrder: o.sortOrder, updatedAt: now })
        .where(and(eq(tagCategories.id, o.id), isNull(tagCategories.deletedAt)))
        .run()
    }
  })
}
```

- [ ] **Step 4: Extend the tag-definition queries**

In `apps/desktop/src/main/database/queries/tag-definitions.ts`, add `categoryId` and `sortOrder` to the two select shapes and to the return type of `getOrCreateTag`, and add one setter. Keep the existing normalization style.

```ts
export function setTagCategory(db: DataDb, name: string, categoryId: string | null): void {
  db.update(tagDefinitions)
    .set({ categoryId })
    .where(eq(tagDefinitions.name, name.toLowerCase().trim()))
    .run()
}
```

`getOrCreateTag` and `getAllTagDefinitions` both return `{ name, color, icon }` today. Widen both to `{ name, color, icon, categoryId, sortOrder }` and select the two new columns. The insert in `getOrCreateTag` leaves them at their defaults — do not pass them explicitly.

- [ ] **Step 5: Run the tests**

```bash
pnpm --filter @memry/desktop test:main -- queries/tag-categories
```

Expected: PASS, 7 tests.

- [ ] **Step 6: Run the full main-process suite to catch the widened return type**

```bash
pnpm --filter @memry/desktop test:main
```

Expected: PASS. If a caller of `getAllTagDefinitions` fails on the new fields, fix the caller — do not narrow the query back.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/main/database/queries
git commit -m "feat(tags): add category queries and tag category assignment"
```

---

### Task 3: Register the `tag_category` sync type

**Files:**

- Modify: `packages/contracts/src/sync-api.ts`
- Modify: `packages/contracts/src/sync-payloads.ts`
- Test: `packages/contracts/src/sync-api.test.ts` (create if absent)

**Interfaces:**

- Produces: `'tag_category'` as a member of `SyncItemType`. `TagCategorySyncPayloadSchema` / `TagCategorySyncPayload` with fields `name: string`, `sortOrder: number`, `clock?`, `createdAt?`, `updatedAt?`, `deletedAt?: string | null`. `TagDefinitionSyncPayloadSchema` gains optional `categoryId: string | null` and `sortOrder: number`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/contracts/src/sync-api.test.ts
import { describe, it, expect } from 'vitest'
import {
  SYNC_ITEM_TYPES,
  RECORD_SYNC_ITEM_TYPES,
  RECORD_CLOCK_REQUIRED_ITEM_TYPES
} from './sync-api'
import { TagCategorySyncPayloadSchema, TagDefinitionSyncPayloadSchema } from './sync-payloads'

describe('tag_category sync registration', () => {
  it('is a known sync item type in all three lists', () => {
    expect(SYNC_ITEM_TYPES).toContain('tag_category')
    expect(RECORD_SYNC_ITEM_TYPES).toContain('tag_category')
    expect(RECORD_CLOCK_REQUIRED_ITEM_TYPES).toContain('tag_category')
  })

  it('parses a minimal category payload', () => {
    const parsed = TagCategorySyncPayloadSchema.safeParse({ name: 'Work', sortOrder: 0 })
    expect(parsed.success).toBe(true)
  })

  it('accepts a tag payload without the new category fields', () => {
    const parsed = TagDefinitionSyncPayloadSchema.safeParse({ name: 'work', color: 'blue' })
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.categoryId).toBeUndefined()
  })

  it('accepts a tag payload with the new category fields', () => {
    const parsed = TagDefinitionSyncPayloadSchema.safeParse({
      name: 'work',
      color: 'blue',
      categoryId: 'abc',
      sortOrder: 3
    })
    expect(parsed.success && parsed.data.sortOrder).toBe(3)
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
pnpm --filter @memry/contracts test
```

Expected: FAIL — `tag_category` not in `SYNC_ITEM_TYPES`.

If `@memry/contracts` has no test script, this repo gates contracts tests separately; add the package to the turbo test pipeline as part of this step rather than skipping the test.

- [ ] **Step 3: Register the type**

In `packages/contracts/src/sync-api.ts`, add `'tag_category'` to `SYNC_ITEM_TYPES`, `RECORD_SYNC_ITEM_TYPES`, and `RECORD_CLOCK_REQUIRED_ITEM_TYPES`. Place it directly after `'tag_definition'` in each list so the three stay visually aligned.

- [ ] **Step 4: Add the payload schemas**

In `packages/contracts/src/sync-payloads.ts`, next to `TagDefinitionSyncPayloadSchema`:

```ts
export const TagCategorySyncPayloadSchema = z.object({
  name: z.string(),
  sortOrder: z.number().int(),
  clock: VectorClockSchema.optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  deletedAt: z.string().nullable().optional()
})
```

And add the type export next to the other `z.infer` exports:

```ts
export type TagCategorySyncPayload = z.infer<typeof TagCategorySyncPayloadSchema>
```

Then widen the tag payload in place:

```ts
export const TagDefinitionSyncPayloadSchema = z.object({
  name: z.string(),
  color: z.string(),
  icon: z.string().nullable().optional(),
  categoryId: z.string().nullable().optional(),
  sortOrder: z.number().int().optional(),
  clock: VectorClockSchema.optional(),
  createdAt: z.string().optional()
})
```

Both new fields are optional. That is what keeps a payload written by an older build parseable.

- [ ] **Step 5: Run the tests**

```bash
pnpm --filter @memry/contracts test
```

Expected: PASS, 4 tests.

- [ ] **Step 6: Find every exhaustive switch over `SyncItemType`**

```bash
pnpm typecheck
```

Expected: TypeScript errors at each non-exhaustive switch or record keyed by `SyncItemType`. Fix each one — that is the intended signal. Do not add a `default` branch to silence it.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src
git commit -m "feat(sync): register tag_category item type and payload"
```

---

### Task 4: `tag_category` sync handler

**Files:**

- Create: `apps/desktop/src/main/sync/item-handlers/tag-category-handler.ts`
- Modify: `apps/desktop/src/main/sync/item-handlers/index.ts`
- Modify: `packages/contracts/src/ipc-channels.ts` (one new event)
- Test: `apps/desktop/src/main/sync/item-handlers/tag-category-handler.test.ts`

**Interfaces:**

- Consumes: `tagCategories` (Task 1), `TagCategorySyncPayload` (Task 3).
- Produces: `tagCategoryHandler`, registered under `'tag_category'`. Emits `TagsChannels.events.CATEGORIES_CHANGED` (`'tags:categories-changed'`) after every applied change.

- [ ] **Step 1: Add the event channel**

In `packages/contracts/src/ipc-channels.ts`, inside `TagsChannels.events`:

```ts
/** Tag categories or their membership changed */
CATEGORIES_CHANGED: 'tags:categories-changed'
```

- [ ] **Step 2: Write the failing test**

Model it on `folder-config-handler.test.ts`, which is the closest existing handler test.

```ts
// apps/desktop/src/main/sync/item-handlers/tag-category-handler.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { tagCategoryHandler } from './tag-category-handler'
import { tagCategories } from '@memry/db-schema/schema/tag-categories'
import { eq } from 'drizzle-orm'
import { createTestDataDb, type TestDataDb } from '../../../test/helpers/test-data-db'

let db: TestDataDb
const emit = vi.fn()
const ctx = () => ({ db, emit })

beforeEach(() => {
  db = createTestDataDb()
  emit.mockClear()
})

describe('tagCategoryHandler', () => {
  it('inserts a category that does not exist locally', () => {
    const result = tagCategoryHandler.applyUpsert(
      ctx(),
      'cat-1',
      { name: 'Work', sortOrder: 2 },
      { deviceA: 1 }
    )

    expect(result).toBe('applied')
    const row = db.select().from(tagCategories).where(eq(tagCategories.id, 'cat-1')).get()
    expect(row?.name).toBe('Work')
    expect(row?.sortOrder).toBe(2)
    expect(emit).toHaveBeenCalledWith('tags:categories-changed', expect.anything())
  })

  it('skips a remote update when the local clock is strictly newer', () => {
    tagCategoryHandler.applyUpsert(ctx(), 'cat-1', { name: 'Work', sortOrder: 0 }, { deviceA: 5 })

    const result = tagCategoryHandler.applyUpsert(
      ctx(),
      'cat-1',
      { name: 'Stale', sortOrder: 9 },
      { deviceA: 2 }
    )

    expect(result).toBe('skipped')
    const row = db.select().from(tagCategories).where(eq(tagCategories.id, 'cat-1')).get()
    expect(row?.name).toBe('Work')
  })

  it('reports a conflict on concurrent edits and keeps the remote value', () => {
    tagCategoryHandler.applyUpsert(ctx(), 'cat-1', { name: 'Work', sortOrder: 0 }, { deviceA: 3 })

    const result = tagCategoryHandler.applyUpsert(
      ctx(),
      'cat-1',
      { name: 'Job', sortOrder: 1 },
      { deviceB: 4 }
    )

    expect(result).toBe('conflict')
    const row = db.select().from(tagCategories).where(eq(tagCategories.id, 'cat-1')).get()
    expect(row?.name).toBe('Job')
  })

  it('soft-deletes on delete rather than dropping the row', () => {
    tagCategoryHandler.applyUpsert(ctx(), 'cat-1', { name: 'Work', sortOrder: 0 }, { deviceA: 1 })

    const result = tagCategoryHandler.applyDelete(ctx(), 'cat-1', { deviceA: 2 })

    expect(result).toBe('applied')
    const row = db.select().from(tagCategories).where(eq(tagCategories.id, 'cat-1')).get()
    expect(row?.deletedAt).toBeTruthy()
  })

  it('builds a push payload that round-trips through the schema', () => {
    tagCategoryHandler.applyUpsert(ctx(), 'cat-1', { name: 'Work', sortOrder: 4 }, { deviceA: 1 })

    const json = tagCategoryHandler.buildPushPayload(db, 'cat-1', 'deviceA', 'update')

    expect(json).not.toBeNull()
    expect(JSON.parse(json!)).toMatchObject({ name: 'Work', sortOrder: 4 })
  })
})
```

- [ ] **Step 3: Run it to make sure it fails**

```bash
pnpm --filter @memry/desktop test:main -- tag-category-handler
```

Expected: FAIL — cannot resolve `./tag-category-handler`.

- [ ] **Step 4: Implement the handler**

```ts
// apps/desktop/src/main/sync/item-handlers/tag-category-handler.ts
import { eq, isNull } from 'drizzle-orm'
import { tagCategories } from '@memry/db-schema/schema/tag-categories'
import { utcNow } from '@memry/shared/utc'
import {
  TagCategorySyncPayloadSchema,
  type TagCategorySyncPayload
} from '@memry/contracts/sync-payloads'
import { TagsChannels } from '@memry/contracts/ipc-channels'
import type { VectorClock } from '@memry/contracts/sync-api'
import type { SyncQueueManager } from '../queue'
import { increment } from '../vector-clock'
import { createLogger } from '../../lib/logger'
import { BaseItemHandler } from './base-handler'
import type { ApplyContext, ApplyResult, DrizzleDb } from './types'

const log = createLogger('TagCategoryHandler')

class TagCategoryHandler extends BaseItemHandler<TagCategorySyncPayload> {
  readonly type = 'tag_category' as const
  readonly schema = TagCategorySyncPayloadSchema

  applyUpsert(
    ctx: ApplyContext,
    itemId: string,
    data: TagCategorySyncPayload,
    clock: VectorClock
  ): ApplyResult {
    return ctx.db.transaction((tx): ApplyResult => {
      const existing = tx.select().from(tagCategories).where(eq(tagCategories.id, itemId)).get()
      const remoteClock = Object.keys(clock).length > 0 ? clock : (data.clock ?? {})
      const now = utcNow()

      if (existing) {
        const resolution = this.resolveClock(existing.clock as VectorClock | null, remoteClock)
        if (resolution.action === 'skip') {
          log.info('Skipping remote tag category update, local is newer', { itemId })
          return 'skipped'
        }
        if (resolution.action === 'merge') {
          log.warn('Concurrent tag category edit, using last-write-wins', { itemId })
        }

        tx.update(tagCategories)
          .set({
            name: data.name,
            sortOrder: data.sortOrder,
            deletedAt: data.deletedAt ?? null,
            clock: resolution.mergedClock,
            updatedAt: data.updatedAt ?? now
          })
          .where(eq(tagCategories.id, itemId))
          .run()

        ctx.emit(TagsChannels.events.CATEGORIES_CHANGED, { categoryId: itemId })
        return resolution.action === 'merge' ? 'conflict' : 'applied'
      }

      tx.insert(tagCategories)
        .values({
          id: itemId,
          name: data.name,
          sortOrder: data.sortOrder,
          deletedAt: data.deletedAt ?? null,
          clock: remoteClock,
          createdAt: data.createdAt ?? now,
          updatedAt: data.updatedAt ?? now
        })
        .run()

      ctx.emit(TagsChannels.events.CATEGORIES_CHANGED, { categoryId: itemId })
      return 'applied'
    })
  }

  applyDelete(ctx: ApplyContext, itemId: string, clock?: VectorClock): 'applied' | 'skipped' {
    const existing = ctx.db.select().from(tagCategories).where(eq(tagCategories.id, itemId)).get()
    if (!existing) return 'skipped'

    if (clock && existing.clock) {
      const resolution = this.resolveClock(existing.clock as VectorClock | null, clock)
      if (resolution.action === 'skip' || resolution.action === 'merge') {
        log.info('Skipping remote tag category delete, local has unseen changes', { itemId })
        return 'skipped'
      }
    }

    // Soft delete: the row is the tombstone, and member tags must survive.
    ctx.db
      .update(tagCategories)
      .set({ deletedAt: utcNow(), updatedAt: utcNow() })
      .where(eq(tagCategories.id, itemId))
      .run()

    ctx.emit(TagsChannels.events.CATEGORIES_CHANGED, { categoryId: itemId })
    return 'applied'
  }

  fetchLocal(db: DrizzleDb, itemId: string): Record<string, unknown> | undefined {
    return db.select().from(tagCategories).where(eq(tagCategories.id, itemId)).get() as
      | Record<string, unknown>
      | undefined
  }

  buildPushPayload(
    db: DrizzleDb,
    itemId: string,
    _deviceId: string,
    _operation: string
  ): string | null {
    const row = db.select().from(tagCategories).where(eq(tagCategories.id, itemId)).get()
    if (!row) return null
    const payload: TagCategorySyncPayload = {
      name: row.name,
      sortOrder: row.sortOrder,
      deletedAt: row.deletedAt ?? null,
      clock: (row.clock as VectorClock) ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    }
    return JSON.stringify(payload)
  }

  seedUnclocked(db: DrizzleDb, deviceId: string, queue: SyncQueueManager): number {
    const items = db.select().from(tagCategories).where(isNull(tagCategories.clock)).all()
    for (const item of items) {
      const clock = increment({}, deviceId)
      db.update(tagCategories).set({ clock }).where(eq(tagCategories.id, item.id)).run()
      queue.enqueue({
        type: 'tag_category',
        itemId: item.id,
        operation: 'create',
        payload: JSON.stringify({ ...item, clock }),
        priority: 0
      })
    }
    return items.length
  }
}

export const tagCategoryHandler = new TagCategoryHandler()
```

- [ ] **Step 5: Register the handler**

In `apps/desktop/src/main/sync/item-handlers/index.ts`, add the import next to `tagDefinitionHandler` and the map entry directly after `['tag_definition', tagDefinitionHandler],`:

```ts
import { tagCategoryHandler } from './tag-category-handler'
```

```ts
  ['tag_category', tagCategoryHandler],
```

- [ ] **Step 6: Run the tests**

```bash
pnpm --filter @memry/desktop test:main -- tag-category-handler
```

Expected: PASS, 5 tests.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/main/sync packages/contracts/src/ipc-channels.ts
git commit -m "feat(sync): add tag_category handler"
```

---

### Task 5: Carry category fields on `tag_definition` sync

**Files:**

- Modify: `apps/desktop/src/main/sync/item-handlers/tag-definition-handler.ts`
- Test: `apps/desktop/src/main/sync/item-handlers/tag-definition-handler.test.ts` (create if absent)

**Interfaces:**

- Consumes: the widened `TagDefinitionSyncPayload` from Task 3.
- Produces: no new exports. Behavior: `categoryId` and `sortOrder` round-trip through push and apply, and a payload omitting them leaves the local values intact.

- [ ] **Step 1: Write the failing test**

The last case is the backward-compatibility guarantee the spec calls out. It must be a test, not an assumption.

```ts
// apps/desktop/src/main/sync/item-handlers/tag-definition-handler.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { tagDefinitionHandler } from './tag-definition-handler'
import { tagDefinitions } from '@memry/db-schema/schema/tag-definitions'
import { createTestDataDb, type TestDataDb } from '../../../test/helpers/test-data-db'

let db: TestDataDb
const emit = vi.fn()
const ctx = () => ({ db, emit })

beforeEach(() => {
  db = createTestDataDb()
  emit.mockClear()
})

describe('tagDefinitionHandler category fields', () => {
  it('applies categoryId and sortOrder from a remote payload', () => {
    tagDefinitionHandler.applyUpsert(
      ctx(),
      'work',
      { name: 'work', color: 'blue', categoryId: 'cat-1', sortOrder: 3 },
      { deviceA: 1 }
    )

    const row = db.select().from(tagDefinitions).where(eq(tagDefinitions.name, 'work')).get()
    expect(row?.categoryId).toBe('cat-1')
    expect(row?.sortOrder).toBe(3)
  })

  it('includes the category fields in the push payload', () => {
    tagDefinitionHandler.applyUpsert(
      ctx(),
      'work',
      { name: 'work', color: 'blue', categoryId: 'cat-1', sortOrder: 3 },
      { deviceA: 1 }
    )

    const json = tagDefinitionHandler.buildPushPayload(db, 'work', 'deviceA', 'update')

    expect(JSON.parse(json!)).toMatchObject({ categoryId: 'cat-1', sortOrder: 3 })
  })

  it('keeps the local category when an old-build payload omits it', () => {
    tagDefinitionHandler.applyUpsert(
      ctx(),
      'work',
      { name: 'work', color: 'blue', categoryId: 'cat-1', sortOrder: 3 },
      { deviceA: 1 }
    )

    // An older client only knows name/color/icon.
    tagDefinitionHandler.applyUpsert(
      ctx(),
      'work',
      { name: 'work', color: 'red' },
      { deviceA: 1, deviceB: 1 }
    )

    const row = db.select().from(tagDefinitions).where(eq(tagDefinitions.name, 'work')).get()
    expect(row?.color).toBe('red')
    expect(row?.categoryId).toBe('cat-1')
    expect(row?.sortOrder).toBe(3)
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
pnpm --filter @memry/desktop test:main -- tag-definition-handler
```

Expected: FAIL on the first test — `categoryId` is `null`.

- [ ] **Step 3: Carry the fields through the handler**

Three edits in `tag-definition-handler.ts`. In the `existing` branch of `applyUpsert`, extend the `.set({...})`:

```ts
            categoryId: data.categoryId !== undefined ? data.categoryId : existing.categoryId,
            sortOrder: data.sortOrder ?? existing.sortOrder,
```

In the insert branch, extend `.values({...})`:

```ts
          categoryId: data.categoryId ?? null,
          sortOrder: data.sortOrder ?? 0,
```

In `buildPushPayload`, extend the payload object:

```ts
      categoryId: tag.categoryId ?? null,
      sortOrder: tag.sortOrder,
```

The `!== undefined` check on `categoryId` is deliberate and mirrors the existing `icon` handling: `null` is a meaningful value (uncategorized) and must be distinguishable from "field absent".

- [ ] **Step 4: Run the tests**

```bash
pnpm --filter @memry/desktop test:main -- tag-definition-handler
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/sync/item-handlers
git commit -m "feat(sync): carry tag category assignment through tag_definition sync"
```

---

### Task 5b: `tag_category` push-side sync service

**Added during execution.** This plan was written assuming a category sync-enqueue
path already existed. It does not. Sync in this repo has two sides: the pull-side
`item-handlers/` (Task 4) and a **push-side per-type service** —
`tag-definition-sync.ts`, `folder-config-sync.ts`, and siblings — registered in
`local-mutations.ts` and bootstrapped in `runtime.ts`. No `tag_category` push
service exists, so `enqueueLocalSyncUpdate('tag_category', id)` typechecks and
silently no-ops. Without this task categories never leave the device they were
created on, which defeats the reason the design chose a synced table.

Compatibility: purely additive — a new per-type service beside the existing ones.
No protocol change, no schema change, no migration. Older builds already skip the
`tag_category` item type on pull.

**Files:**

- Create: `apps/desktop/src/main/sync/tag-category-sync.ts`
- Modify: `apps/desktop/src/main/sync/local-mutations.ts`
- Modify: `apps/desktop/src/main/sync/runtime.ts`
- Test: `apps/desktop/src/main/sync/tag-category-sync.test.ts`
- Test: `apps/desktop/src/main/sync/local-mutations.test.ts`

**Interfaces:**

- Consumes: `tagCategories` (Task 1); `RecordSyncController`, `incrementClock`,
  `withIncrementedClock` from `@memry/sync-core`; `SyncQueueManager` from `./queue`.
- Produces: `initTagCategorySyncService(deps)`, `getTagCategorySyncService()`,
  `resetTagCategorySyncService()`, and class `TagCategorySyncService` with
  `enqueueCreate(id)`, `enqueueUpdate(id)`, `enqueueDelete(id, snapshotPayload?)`.
  `deps` matches `TagDefinitionSyncDeps`: `{ queue, db, getDeviceId }`.

The full step-by-step brief for this task lives at
`.superpowers/sdd/task-5b-brief.md`. It mirrors `tag-definition-sync.ts` with three
differences: the type string, an id-keyed rather than name-keyed `load`, and a
delete-fallback payload that must satisfy `TagCategorySyncPayloadSchema` and carry
`deletedAt` so a receiving device applies a tombstone rather than a resurrection.

The task's decisive step is proving the wiring is live: a service that exists but
is never called from `runtime.ts` is the same bug as no service at all.

---

### Task 6: IPC surface

**Files:**

- Modify: `packages/contracts/src/ipc-channels.ts`
- Modify: `apps/desktop/src/main/ipc/tags-handlers.ts`
- Modify: `apps/desktop/src/renderer/src/services/tags-service.ts`
- Test: `apps/desktop/src/main/ipc/tags-handlers.test.ts`

**Interfaces:**

- Consumes: every query from Task 2.
- Produces, on `tagsService`:
  - `listCategories(): Promise<{ success: boolean; categories?: TagCategoryRow[]; error?: string }>`
  - `createCategory(name: string)`, `renameCategory(id, name)`, `deleteCategory(id)` — all returning `{ success, error? }`, `createCategory` also returning `category?: TagCategoryRow`
  - `reorder(payload: { tags?: TagAssignment[]; categories?: { id: string; sortOrder: number }[] })` — one call per drop
  - `onTagCategoriesChanged(cb: () => void): () => void`

- [ ] **Step 1: Add the channels**

In `TagsChannels.invoke`:

```ts
    /** List tag categories with their tag counts */
    LIST_CATEGORIES: 'tags:list-categories',
    /** Create a tag category */
    CREATE_CATEGORY: 'tags:create-category',
    /** Rename a tag category */
    RENAME_CATEGORY: 'tags:rename-category',
    /** Delete a tag category (its tags become uncategorized) */
    DELETE_CATEGORY: 'tags:delete-category',
    /** Apply a drag result: tag assignments and/or category order, in one transaction */
    REORDER: 'tags:reorder',
```

- [ ] **Step 2: Write the failing test**

Follow the existing structure of `tags-handlers.test.ts` — it already mocks `ipcMain` and the DB, so extend that file rather than creating a new one.

```ts
describe('tag category handlers', () => {
  it('lists categories', async () => {
    const handler = getInvokeHandler('tags:list-categories')
    const result = await handler({} as never)
    expect(result.success).toBe(true)
    expect(Array.isArray(result.categories)).toBe(true)
  })

  it('rejects a blank category name', async () => {
    const handler = getInvokeHandler('tags:create-category')
    const result = await handler({} as never, { name: '   ' })
    expect(result.success).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('applies tags and categories in a single reorder call', async () => {
    const create = getInvokeHandler('tags:create-category')
    const { category } = await create({} as never, { name: 'Work' })

    const reorder = getInvokeHandler('tags:reorder')
    const result = await reorder({} as never, {
      tags: [{ tag: 'meetings', categoryId: category.id, sortOrder: 0 }],
      categories: [{ id: category.id, sortOrder: 0 }]
    })

    expect(result.success).toBe(true)
  })

  it('emits tags:categories-changed after a reorder', async () => {
    const reorder = getInvokeHandler('tags:reorder')
    await reorder({} as never, { tags: [], categories: [] })
    expect(emitToWindows).toHaveBeenCalledWith('tags:categories-changed', expect.anything())
  })
})
```

- [ ] **Step 3: Run it to make sure it fails**

```bash
pnpm --filter @memry/desktop test:main -- tags-handlers
```

Expected: FAIL — no handler registered for `tags:list-categories`.

- [ ] **Step 4: Implement the main handlers**

In `apps/desktop/src/main/ipc/tags-handlers.ts`, following the file's existing registration and error-wrapping style:

```ts
ipcMain.handle(TagsChannels.invoke.LIST_CATEGORIES, () => {
  try {
    return { success: true, categories: listTagCategories(getDataDb()) }
  } catch (error) {
    log.error('Failed to list tag categories', error)
    return { success: false, error: extractErrorMessage(error, 'Failed to list tag categories') }
  }
})

ipcMain.handle(TagsChannels.invoke.CREATE_CATEGORY, (_e, { name }: { name: string }) => {
  try {
    if (!name?.trim()) return { success: false, error: 'Category name is required' }
    const category = createTagCategory(getDataDb(), name)
    enqueueCategorySync(category.id, 'create')
    emitToWindows(TagsChannels.events.CATEGORIES_CHANGED, { categoryId: category.id })
    return { success: true, category }
  } catch (error) {
    log.error('Failed to create tag category', error)
    return { success: false, error: extractErrorMessage(error, 'Failed to create tag category') }
  }
})
```

Repeat the same shape for `RENAME_CATEGORY` (`{ id, name }`), `DELETE_CATEGORY` (`{ id }`), and `REORDER` (`{ tags, categories }`). `REORDER` calls `reorderTags` and `reorderCategories` and enqueues one sync item per touched category and per touched tag.

`enqueueCategorySync` is a local helper in this file that bumps the row's vector clock with the current device id and enqueues a `tag_category` item — copy the enqueue helper the file already uses for `tag_definition` writes and change the `type`. If no such helper exists, look at how `updateTagColor`'s handler pushes its change and mirror it exactly; do not invent a second sync-enqueue path.

- [ ] **Step 5: Run the tests**

```bash
pnpm --filter @memry/desktop test:main -- tags-handlers
```

Expected: PASS.

- [ ] **Step 6: Add the renderer service methods**

In `apps/desktop/src/renderer/src/services/tags-service.ts`, matching the existing method style in that file:

```ts
  async listCategories() {
    return window.api.tags.listCategories()
  },
  async createCategory(name: string) {
    return window.api.tags.createCategory({ name })
  },
  async renameCategory(id: string, name: string) {
    return window.api.tags.renameCategory({ id, name })
  },
  async deleteCategory(id: string) {
    return window.api.tags.deleteCategory({ id })
  },
  async reorder(payload: {
    tags?: { tag: string; categoryId: string | null; sortOrder: number }[]
    categories?: { id: string; sortOrder: number }[]
  }) {
    return window.api.tags.reorder(payload)
  }
```

Add `onTagCategoriesChanged` next to the existing `onTagRenamed` / `onTagDeleted` exports, using the same subscribe-and-return-unsubscribe shape.

- [ ] **Step 7: Regenerate and check the IPC map**

```bash
pnpm ipc:generate
pnpm ipc:check
```

Expected: the generated invoke map gains the five channels; `ipc:check` passes.

- [ ] **Step 8: Run the phase gates**

```bash
pnpm lint && pnpm typecheck && pnpm test
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/contracts apps/desktop/src/main/ipc apps/desktop/src/renderer/src/services apps/desktop/src/preload
git commit -m "feat(tags): expose tag category IPC surface"
```

---

# Phase 2 — Hub page

### Task 7: Register the `tags` tab and the sidebar entry point

**Files:**

- Modify: `apps/desktop/src/renderer/src/contexts/tabs/types.ts:13`
- Modify: `apps/desktop/src/renderer/src/components/tabs/tab-icon.tsx:86`
- Modify: `apps/desktop/src/renderer/src/components/sidebar/sidebar-tag-list.tsx:272`
- Create: `apps/desktop/src/renderer/src/pages/tags-hub.tsx`
- Test: `apps/desktop/src/renderer/src/pages/tags-hub.test.tsx`

**Interfaces:**

- Produces: `TabType` includes `'tags'`; `'tags'` is in `SINGLETON_TAB_TYPES`; `TagsHubPage` default-exports a component taking no props.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/desktop/src/renderer/src/pages/tags-hub.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import TagsHubPage from './tags-hub'

vi.mock('@/hooks/use-tag-categories', () => ({
  useTagCategories: () => ({
    categories: [],
    uncategorized: [],
    isLoading: false,
    error: null,
    createCategory: vi.fn(),
    renameCategory: vi.fn(),
    deleteCategory: vi.fn(),
    createTag: vi.fn(),
    reorder: vi.fn()
  })
}))

describe('TagsHubPage', () => {
  it('renders the create affordances', () => {
    render(<TagsHubPage />)
    expect(screen.getByRole('button', { name: /new category/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /new tag/i })).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
pnpm --filter @memry/desktop test:renderer -- tags-hub
```

Expected: FAIL — cannot resolve `./tags-hub`.

- [ ] **Step 3: Add the tab type**

In `contexts/tabs/types.ts`, add to the `TabType` union after `'graph'`:

```ts
  | 'tags' // Tag hub (categories + tag chips)
```

And add `'tags'` to `SINGLETON_TAB_TYPES`.

- [ ] **Step 4: Register the tab icon**

In `components/tabs/tab-icon.tsx`, add to the icon record:

```ts
  tags: 'tag',
```

- [ ] **Step 5: Write the page shell**

```tsx
// apps/desktop/src/renderer/src/pages/tags-hub.tsx
import * as React from 'react'
import { useT } from '@memry/i18n/renderer'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useTagCategories } from '@/hooks/use-tag-categories'
import { InlineCreateRow } from '@/components/tags-hub/inline-create-row'

export function TagsHubPage(): React.JSX.Element {
  const { t } = useT('notes')
  const { categories, uncategorized, isLoading, error, createCategory, createTag } =
    useTagCategories()

  if (error) {
    return <div className="p-6 text-sm text-destructive">{error}</div>
  }

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-6">
        {isLoading ? (
          <div className="text-sm text-muted-foreground">{t('tagsHub.loading')}</div>
        ) : (
          <>
            {/* Category blocks land here in Task 9 */}
            <InlineCreateRow onCreateCategory={createCategory} onCreateTag={createTag} />
          </>
        )}
      </div>
    </ScrollArea>
  )
}

export default TagsHubPage
```

Create `components/tags-hub/inline-create-row.tsx` in Task 10; for this task it may be a minimal component that renders the two buttons with the accessible names the test asserts. Wire the real behavior in Task 10 rather than leaving a stub behind.

- [ ] **Step 6: Route the tab to the page**

Find where the tab content is switched on `TabType` (search `case 'graph':` in the renderer) and add a `case 'tags':` branch rendering `<TagsHubPage />`, following the lazy-import style used by its neighbors.

- [ ] **Step 7: Add the sidebar hub button**

In `sidebar-tag-list.tsx`, inside the `onActionsReady` effect (line 272), add a third button before the existing search button, using the same `Button variant="ghost" size="icon" className="h-5 w-5"` shape:

```tsx
<Button
  variant="ghost"
  size="icon"
  className="h-5 w-5"
  onClick={() =>
    openSidebarItem({ type: 'tags', title: t('tags.hubTitle'), path: '/tags', icon: 'tag' })
  }
  aria-label={t('tags.openHub')}
>
  <LayoutGrid className="h-3 w-3" />
</Button>
```

Import `LayoutGrid` from `@/lib/icons` and `useSidebarNavigation` from `@/hooks/use-sidebar-navigation`. Add `openSidebarItem` to the effect's dependency array.

- [ ] **Step 8: Add the i18n keys**

Add `tagsHub.loading`, `tags.hubTitle`, and `tags.openHub` to the English locale file that backs the `notes` namespace, then:

```bash
pnpm --filter @memry/desktop i18n:check
```

Expected: PASS. Missing non-English locales are warnings, not errors.

- [ ] **Step 9: Run the tests**

```bash
pnpm --filter @memry/desktop test:renderer -- tags-hub
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/desktop/src/renderer/src packages/i18n
git commit -m "feat(tags): add the tag hub tab and its sidebar entry point"
```

---

### Task 8: Hub data hook

**Files:**

- Create: `apps/desktop/src/renderer/src/hooks/use-tag-categories.ts`
- Test: `apps/desktop/src/renderer/src/hooks/use-tag-categories.test.ts`

**Interfaces:**

- Consumes: `tagsService` methods from Task 6 and `useNoteTagsQuery` for per-tag counts.
- Produces: `useTagCategories()` returning
  `{ categories: HubCategory[]; uncategorized: HubTag[]; isLoading: boolean; error: string | null; createCategory(name): Promise<void>; renameCategory(id, name): Promise<void>; deleteCategory(id): Promise<void>; createTag(name, color, categoryId): Promise<void>; reorder(payload): Promise<void> }`
  where `HubCategory = { id: string; name: string; sortOrder: number; tags: HubTag[] }` and `HubTag = { tag: string; color: string; icon: string | null; count: number; sortOrder: number }`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/renderer/src/hooks/use-tag-categories.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useTagCategories } from './use-tag-categories'

const listCategories = vi.fn()

vi.mock('@/services/tags-service', () => ({
  tagsService: {
    listCategories: (...a: unknown[]) => listCategories(...a),
    createCategory: vi.fn().mockResolvedValue({ success: true }),
    renameCategory: vi.fn().mockResolvedValue({ success: true }),
    deleteCategory: vi.fn().mockResolvedValue({ success: true }),
    reorder: vi.fn().mockResolvedValue({ success: true })
  },
  onTagCategoriesChanged: () => () => {}
}))

vi.mock('@/hooks/use-notes-query', () => ({
  useNoteTagsQuery: () => ({
    tags: [
      { tag: 'meetings', count: 12, color: 'blue', icon: null, categoryId: 'cat-1', sortOrder: 0 },
      { tag: 'idea', count: 22, color: 'red', icon: null, categoryId: null, sortOrder: 0 }
    ],
    isLoading: false,
    error: null
  })
}))

beforeEach(() => {
  listCategories.mockResolvedValue({
    success: true,
    categories: [{ id: 'cat-1', name: 'Work', sortOrder: 0, tagCount: 1 }]
  })
})

describe('useTagCategories', () => {
  it('groups tags under their category and leaves the rest uncategorized', async () => {
    const { result } = renderHook(() => useTagCategories())

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.categories).toHaveLength(1)
    expect(result.current.categories[0].tags.map((t) => t.tag)).toEqual(['meetings'])
    expect(result.current.uncategorized.map((t) => t.tag)).toEqual(['idea'])
  })

  it('treats a tag pointing at a missing category as uncategorized', async () => {
    listCategories.mockResolvedValue({ success: true, categories: [] })

    const { result } = renderHook(() => useTagCategories())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.categories).toHaveLength(0)
    expect(result.current.uncategorized.map((t) => t.tag).sort()).toEqual(['idea', 'meetings'])
  })

  it('surfaces a failed load as an error string', async () => {
    listCategories.mockResolvedValue({ success: false, error: 'boom' })

    const { result } = renderHook(() => useTagCategories())
    await waitFor(() => expect(result.current.error).toBe('boom'))
  })
})
```

The second test is the dangling-`category_id` guarantee from the spec. It must stay.

- [ ] **Step 2: Run it to make sure it fails**

```bash
pnpm --filter @memry/desktop test:renderer -- use-tag-categories
```

Expected: FAIL — cannot resolve `./use-tag-categories`.

- [ ] **Step 3: Extend the tag query with the new fields**

`useNoteTagsQuery` feeds the hub. Its row type must carry `categoryId` and `sortOrder`, which means `tags:get-all-with-counts` must select them. Update the query in `apps/desktop/src/main/database/queries/notes/index.ts` and the renderer type in `use-notes-query.ts` to include both.

- [ ] **Step 4: Implement the hook**

Group by `categoryId`, drop assignments whose category is missing, sort tags by `sortOrder` then name, sort categories by `sortOrder` then name, and refetch on the `tags:categories-changed` and `notes:tags-changed` events. Every mutation calls the service, then refetches; on a `success: false` result set `error` via `extractErrorMessage` and surface a `toast.error`. Use `createLogger('Hook:TagCategories')` for failures.

- [ ] **Step 5: Run the tests**

```bash
pnpm --filter @memry/desktop test:renderer -- use-tag-categories
```

Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/hooks apps/desktop/src/main/database/queries/notes
git commit -m "feat(tags): add the tag hub data hook"
```

---

### Task 9: Category blocks and tag chips

**Files:**

- Create: `apps/desktop/src/renderer/src/components/tags-hub/category-block.tsx`
- Create: `apps/desktop/src/renderer/src/components/tags-hub/tag-chip-item.tsx`
- Modify: `apps/desktop/src/renderer/src/pages/tags-hub.tsx`
- Test: `apps/desktop/src/renderer/src/components/tags-hub/category-block.test.tsx`

**Interfaces:**

- Consumes: `HubCategory`, `HubTag` from Task 8.
- Produces: `CategoryBlock` with props `{ id: string | null; name: string; tags: HubTag[]; onTagOpen(tag: string): void; onRename?(name: string): void; onDelete?(): void }` — `id: null` is the Uncategorized block, which has no rename or delete. `TagChipItem` with props `{ tag: HubTag; onOpen(): void }`.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/desktop/src/renderer/src/components/tags-hub/category-block.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CategoryBlock } from './category-block'

const tags = [
  { tag: 'meetings', color: 'blue', icon: null, count: 12, sortOrder: 0 },
  { tag: 'work/1:1', color: 'red', icon: null, count: 8, sortOrder: 1 }
]

describe('CategoryBlock', () => {
  it('shows the category name and its tag count', () => {
    render(<CategoryBlock id="cat-1" name="Work" tags={tags} onTagOpen={vi.fn()} />)
    expect(screen.getByText('Work')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('renders one chip per tag with its full name and item count', () => {
    render(<CategoryBlock id="cat-1" name="Work" tags={tags} onTagOpen={vi.fn()} />)
    expect(screen.getByText('work/1:1')).toBeInTheDocument()
    expect(screen.getByText('12')).toBeInTheDocument()
  })

  it('calls onTagOpen with the tag name when a chip is clicked', async () => {
    const onTagOpen = vi.fn()
    render(<CategoryBlock id="cat-1" name="Work" tags={tags} onTagOpen={onTagOpen} />)

    await userEvent.click(screen.getByRole('button', { name: /meetings/ }))

    expect(onTagOpen).toHaveBeenCalledWith('meetings')
  })

  it('offers no rename or delete on the uncategorized block', () => {
    render(<CategoryBlock id={null} name="Uncategorized" tags={tags} onTagOpen={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /rename/i })).not.toBeInTheDocument()
  })

  it('shows an empty hint when a category has no tags', () => {
    render(<CategoryBlock id="cat-1" name="Blog" tags={[]} onTagOpen={vi.fn()} />)
    expect(screen.getByText(/drag a tag here/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
pnpm --filter @memry/desktop test:renderer -- category-block
```

Expected: FAIL — cannot resolve `./category-block`.

- [ ] **Step 3: Implement the chip**

Reuse the existing chip visual language from `sidebar-tag-list.tsx:151-183` — `getTagColors(color, tag)`, a `backgroundColor: ${colors.text}1A` fill, the icon-or-dot leading slot via `NoteIconDisplay`, and the label. The hub chip differs in three ways: it always shows the count, it shows the tag's **full** name (never just the leaf segment), and it is a drop target. Keep it under 80 lines.

- [ ] **Step 4: Implement the block**

Heading row: name on the start side, tag count on the end side, hover-revealed rename and delete buttons (omitted entirely when `id === null`). Below it, a `flex flex-wrap gap-2` chip row. When `tags` is empty, render the drag hint instead of the row.

- [ ] **Step 5: Render the blocks in the page**

In `tags-hub.tsx`, map `categories` to `CategoryBlock`, then render the Uncategorized block with `id={null}`, then `InlineCreateRow`.

`onTagOpen` must call `openSidebarItem({ type: 'tag', title: tag, path: '/tags/' + tag, entityId: tag })`, and `'tag'` is not in `TabType` yet. Add it here — the two-line union and icon addition from Task 14 Step 3, nothing more:

```ts
  | 'tag' // Single tag page (table of tagged items)
```

Task 14 then builds the page behind it. Until Task 14 lands, clicking a chip opens a tab with no content, which is expected and not a bug to chase.

- [ ] **Step 6: Run the tests**

```bash
pnpm --filter @memry/desktop test:renderer -- category-block
pnpm --filter @memry/desktop test:renderer -- tags-hub
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/src
git commit -m "feat(tags): render category blocks and tag chips in the hub"
```

---

### Task 10: Inline creation

**Files:**

- Create: `apps/desktop/src/renderer/src/components/tags-hub/inline-create-row.tsx`
- Test: `apps/desktop/src/renderer/src/components/tags-hub/inline-create-row.test.tsx`

**Interfaces:**

- Produces: `InlineCreateRow` with props `{ onCreateCategory(name: string): Promise<void>; onCreateTag(name: string, color: string, categoryId: string | null): Promise<void>; categoryId?: string | null }`.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/desktop/src/renderer/src/components/tags-hub/inline-create-row.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { InlineCreateRow } from './inline-create-row'

describe('InlineCreateRow', () => {
  it('opens an inline input rather than a dialog', async () => {
    render(<InlineCreateRow onCreateCategory={vi.fn()} onCreateTag={vi.fn()} />)

    await userEvent.click(screen.getByRole('button', { name: /new category/i }))

    expect(screen.getByRole('textbox')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('creates a category on Enter', async () => {
    const onCreateCategory = vi.fn().mockResolvedValue(undefined)
    render(<InlineCreateRow onCreateCategory={onCreateCategory} onCreateTag={vi.fn()} />)

    await userEvent.click(screen.getByRole('button', { name: /new category/i }))
    await userEvent.type(screen.getByRole('textbox'), 'Blog{Enter}')

    expect(onCreateCategory).toHaveBeenCalledWith('Blog')
  })

  it('cancels on Escape without creating', async () => {
    const onCreateCategory = vi.fn()
    render(<InlineCreateRow onCreateCategory={onCreateCategory} onCreateTag={vi.fn()} />)

    await userEvent.click(screen.getByRole('button', { name: /new category/i }))
    await userEvent.type(screen.getByRole('textbox'), 'Blog{Escape}')

    expect(onCreateCategory).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('ignores a blank name', async () => {
    const onCreateCategory = vi.fn()
    render(<InlineCreateRow onCreateCategory={onCreateCategory} onCreateTag={vi.fn()} />)

    await userEvent.click(screen.getByRole('button', { name: /new category/i }))
    await userEvent.type(screen.getByRole('textbox'), '   {Enter}')

    expect(onCreateCategory).not.toHaveBeenCalled()
  })

  it('offers a color palette when creating a tag', async () => {
    render(<InlineCreateRow onCreateCategory={vi.fn()} onCreateTag={vi.fn()} />)

    await userEvent.click(screen.getByRole('button', { name: /new tag/i }))

    expect(screen.getByRole('textbox')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /color/i }).length).toBeGreaterThan(0)
  })

  it('passes the owning category id when creating a tag', async () => {
    const onCreateTag = vi.fn().mockResolvedValue(undefined)
    render(
      <InlineCreateRow onCreateCategory={vi.fn()} onCreateTag={onCreateTag} categoryId="cat-1" />
    )

    await userEvent.click(screen.getByRole('button', { name: /new tag/i }))
    await userEvent.type(screen.getByRole('textbox'), 'draft{Enter}')

    expect(onCreateTag).toHaveBeenCalledWith('draft', expect.any(String), 'cat-1')
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
pnpm --filter @memry/desktop test:renderer -- inline-create-row
```

Expected: FAIL — the component renders only two buttons.

- [ ] **Step 3: Implement it**

Local state is a single `mode: 'idle' | 'category' | 'tag'` plus `name` and, for tag mode, `color` seeded from `COLOR_NAMES[0]`. Enter submits when the trimmed name is non-empty; Escape returns to `idle` and clears. Reuse the color swatches from `COLOR_NAMES` / `getTagColors` in `@/components/note/tags-row/tag-colors`, giving each swatch an `aria-label` containing the word "color" so it is reachable by name. Autofocus the input when the mode changes away from `idle`.

`InlineCreateRow` appears twice in the hub: once per category block (with that block's `categoryId`) and once at the page bottom (with `categoryId` omitted, meaning uncategorized).

- [ ] **Step 4: Run the tests**

```bash
pnpm --filter @memry/desktop test:renderer -- inline-create-row
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/tags-hub
git commit -m "feat(tags): add inline category and tag creation to the hub"
```

---

### Task 11: Category rename and delete

**Files:**

- Modify: `apps/desktop/src/renderer/src/components/tags-hub/category-block.tsx`
- Test: `apps/desktop/src/renderer/src/components/tags-hub/category-block.test.tsx`

**Interfaces:**

- Consumes: `renameCategory`, `deleteCategory` from Task 8.
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Append to the existing `category-block.test.tsx`:

```tsx
it('renames inline on Enter', async () => {
  const onRename = vi.fn()
  render(
    <CategoryBlock id="cat-1" name="Work" tags={tags} onTagOpen={vi.fn()} onRename={onRename} />
  )

  await userEvent.click(screen.getByRole('button', { name: /rename/i }))
  const input = screen.getByRole('textbox')
  await userEvent.clear(input)
  await userEvent.type(input, 'Job{Enter}')

  expect(onRename).toHaveBeenCalledWith('Job')
})

it('warns that tags survive before deleting', async () => {
  const onDelete = vi.fn()
  render(
    <CategoryBlock id="cat-1" name="Work" tags={tags} onTagOpen={vi.fn()} onDelete={onDelete} />
  )

  await userEvent.click(screen.getByRole('button', { name: /delete/i }))

  expect(screen.getByText(/tags will move to uncategorized/i)).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: /^delete$/i }))
  expect(onDelete).toHaveBeenCalled()
})
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
pnpm --filter @memry/desktop test:renderer -- category-block
```

Expected: FAIL — no rename button.

- [ ] **Step 3: Implement rename**

Rename is inline, matching the create affordance: the heading text swaps for an input seeded with the current name, Enter commits, Escape reverts. No dialog.

- [ ] **Step 4: Implement delete**

Delete uses a small confirmation — reuse the app's existing `AlertDialog` from `@/components/ui`. The body must state that the tags themselves are not deleted and will move to Uncategorized, because that is the non-obvious part of the semantics.

- [ ] **Step 5: Run the tests**

```bash
pnpm --filter @memry/desktop test:renderer -- category-block
```

Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/components/tags-hub
git commit -m "feat(tags): rename and delete categories from the hub"
```

---

### Task 12: Drag and drop

**Files:**

- Modify: `apps/desktop/src/renderer/src/pages/tags-hub.tsx`
- Modify: `apps/desktop/src/renderer/src/components/tags-hub/category-block.tsx`
- Modify: `apps/desktop/src/renderer/src/components/tags-hub/tag-chip-item.tsx`
- Create: `apps/desktop/src/renderer/src/components/tags-hub/reorder.ts`
- Test: `apps/desktop/src/renderer/src/components/tags-hub/reorder.test.ts`

**Interfaces:**

- Produces: two pure functions in `reorder.ts`, which is where all the ordering arithmetic lives so it can be tested without dnd-kit:
  - `moveTag(state: HubState, tag: string, toCategoryId: string | null, toIndex: number): TagAssignment[]`
  - `moveCategory(categories: HubCategory[], fromIndex: number, toIndex: number): { id: string; sortOrder: number }[]`
    where `HubState = { categories: HubCategory[]; uncategorized: HubTag[] }`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/renderer/src/components/tags-hub/reorder.test.ts
import { describe, it, expect } from 'vitest'
import { moveTag, moveCategory } from './reorder'

const tag = (t: string, sortOrder: number) => ({
  tag: t,
  color: 'blue',
  icon: null,
  count: 1,
  sortOrder
})

const state = {
  categories: [
    { id: 'work', name: 'Work', sortOrder: 0, tags: [tag('meetings', 0), tag('okr', 1)] },
    { id: 'books', name: 'Books', sortOrder: 1, tags: [tag('general', 0)] }
  ],
  uncategorized: [tag('idea', 0)]
}

describe('moveTag', () => {
  it('moves a tag into another category at the requested index', () => {
    const result = moveTag(state, 'idea', 'work', 1)

    expect(result).toContainEqual({ tag: 'idea', categoryId: 'work', sortOrder: 1 })
    expect(result).toContainEqual({ tag: 'okr', categoryId: 'work', sortOrder: 2 })
  })

  it('reorders within a category without changing membership', () => {
    const result = moveTag(state, 'okr', 'work', 0)

    expect(result).toContainEqual({ tag: 'okr', categoryId: 'work', sortOrder: 0 })
    expect(result).toContainEqual({ tag: 'meetings', categoryId: 'work', sortOrder: 1 })
  })

  it('moves a tag out to uncategorized', () => {
    const result = moveTag(state, 'meetings', null, 0)

    expect(result).toContainEqual({ tag: 'meetings', categoryId: null, sortOrder: 0 })
    expect(result).toContainEqual({ tag: 'idea', categoryId: null, sortOrder: 1 })
  })

  it('emits contiguous sort orders for every touched category', () => {
    const result = moveTag(state, 'idea', 'work', 0)
    const work = result.filter((a) => a.categoryId === 'work').map((a) => a.sortOrder)
    expect(work.sort()).toEqual([0, 1, 2])
  })

  it('returns an empty list when the tag is unknown', () => {
    expect(moveTag(state, 'nope', 'work', 0)).toEqual([])
  })
})

describe('moveCategory', () => {
  it('renumbers categories from zero after a move', () => {
    const result = moveCategory(state.categories, 1, 0)
    expect(result).toEqual([
      { id: 'books', sortOrder: 0 },
      { id: 'work', sortOrder: 1 }
    ])
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
pnpm --filter @memry/desktop test:renderer -- tags-hub/reorder
```

Expected: FAIL — cannot resolve `./reorder`.

- [ ] **Step 3: Implement the pure reorder functions**

Both functions rebuild the affected lists and renumber from zero, returning only the rows that changed plus every row whose index shifted. Returning a contiguous renumbering of each touched category keeps the DB free of sort-order drift over many drags.

- [ ] **Step 4: Run the pure tests**

```bash
pnpm --filter @memry/desktop test:renderer -- tags-hub/reorder
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Wire dnd-kit in the page**

Wrap the blocks in a `DndContext` with `closestCenter` collision detection. Chips use `useSortable` inside a per-category `SortableContext` with `rectSortingStrategy` (chips wrap, so the rect strategy is the correct one — not `verticalListSortingStrategy`). Category blocks use a second `SortableContext` with `verticalListSortingStrategy`. On `onDragEnd`, call `moveTag` or `moveCategory` and pass the result straight to `reorder()` from Task 8. Apply the new order optimistically before awaiting, and refetch on failure.

Follow the dnd-kit setup already in `folder-table-view.tsx` for sensor configuration and keyboard accessibility rather than configuring sensors from scratch.

- [ ] **Step 6: Verify in the running app**

```bash
pnpm dev
```

Drag a chip between categories, drag a category block, then restart the app and confirm the order persisted. Confirm the drag is keyboard-operable: focus a chip, press Space, arrow, Space.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/src
git commit -m "feat(tags): drag and drop ordering for tags and categories"
```

---

### Task 13: Hub search

**Files:**

- Modify: `apps/desktop/src/renderer/src/pages/tags-hub.tsx`
- Create: `apps/desktop/src/renderer/src/components/tags-hub/filter.ts`
- Test: `apps/desktop/src/renderer/src/components/tags-hub/filter.test.ts`

**Interfaces:**

- Produces: `filterHub(state: HubState, query: string): HubState` — pure.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/renderer/src/components/tags-hub/filter.test.ts
import { describe, it, expect } from 'vitest'
import { filterHub } from './filter'

const tag = (t: string) => ({ tag: t, color: 'blue', icon: null, count: 1, sortOrder: 0 })

const state = {
  categories: [
    { id: 'work', name: 'Work', sortOrder: 0, tags: [tag('meetings'), tag('okr')] },
    { id: 'books', name: 'Books', sortOrder: 1, tags: [tag('general')] }
  ],
  uncategorized: [tag('work-backlog'), tag('idea')]
}

describe('filterHub', () => {
  it('returns everything for an empty query', () => {
    expect(filterHub(state, '')).toEqual(state)
  })

  it('keeps every tag of a category whose name matches', () => {
    const result = filterHub(state, 'work')
    expect(result.categories.find((c) => c.id === 'work')?.tags).toHaveLength(2)
  })

  it('keeps only matching tags in a non-matching category', () => {
    const result = filterHub(state, 'work')
    expect(result.uncategorized.map((t) => t.tag)).toEqual(['work-backlog'])
  })

  it('drops categories with no match at all', () => {
    const result = filterHub(state, 'work')
    expect(result.categories.map((c) => c.id)).toEqual(['work'])
  })

  it('is case-insensitive', () => {
    expect(filterHub(state, 'WORK').categories.map((c) => c.id)).toEqual(['work'])
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
pnpm --filter @memry/desktop test:renderer -- tags-hub/filter
```

Expected: FAIL — cannot resolve `./filter`.

- [ ] **Step 3: Implement the filter**

A category survives if its name matches or any of its tags match. When the category name matches, keep all its tags; otherwise keep only the matching ones. Uncategorized is filtered by tag name only.

- [ ] **Step 4: Wire the search input**

A single compact input at the top of the page, styled like the sidebar's filter input (`h-6 px-2 text-[11px] rounded-md border bg-transparent`). Escape clears it. Drag and drop is disabled while a query is active — reordering a filtered list would write misleading sort orders. Show the search-empty state when nothing matches.

- [ ] **Step 5: Run the tests**

```bash
pnpm --filter @memry/desktop test:renderer -- tags-hub
```

Expected: PASS.

- [ ] **Step 6: Run the phase gates**

```bash
pnpm lint && pnpm typecheck && pnpm test
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/src
git commit -m "feat(tags): search across categories and tags in the hub"
```

---

# Phase 3 — Tag page

### Task 14: Register the `tag` tab

**Files:**

- Modify: `apps/desktop/src/renderer/src/contexts/tabs/types.ts:13`
- Modify: `apps/desktop/src/renderer/src/components/tabs/tab-icon.tsx`
- Create: `apps/desktop/src/renderer/src/pages/tag-view.tsx`
- Test: `apps/desktop/src/renderer/src/pages/tag-view.test.tsx`

**Interfaces:**

- Produces: `TabType` includes `'tag'`; it is **not** a singleton. `TagViewPage` takes `{ tag: string; color?: string }`.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/desktop/src/renderer/src/pages/tag-view.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import TagViewPage from './tag-view'

vi.mock('@/hooks/use-tag-items', () => ({
  useTagItems: () => ({ items: [], total: 0, isLoading: false, error: null, refresh: vi.fn() })
}))

describe('TagViewPage', () => {
  it('shows the tag name and its total count in the header', () => {
    render(<TagViewPage tag="meetings" />)
    expect(screen.getByText('meetings')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
pnpm --filter @memry/desktop test:renderer -- tag-view
```

Expected: FAIL — cannot resolve `./tag-view`.

- [ ] **Step 3: Add the tab type and icon**

```ts
  | 'tag' // Single tag page (table of tagged items)
```

Do **not** add it to `SINGLETON_TAB_TYPES`. Tab identity comes from the tag name carried in `entityId`, the same way `note` and `canvas` tabs are keyed. Confirm the tab reducer dedupes on `entityId` for non-singleton types; if it dedupes on `path` instead, set `path` to `/tags/<tag>` and rely on that.

- [ ] **Step 4: Write the page shell**

Header only for this task: the tag chip via `getTagColors`, the tag name, the total count, and a `⋯` placeholder. The table arrives in Task 18.

- [ ] **Step 5: Route the tab**

Add a `case 'tag':` branch next to the `'tags'` branch from Task 7, passing `tab.entityId` as `tag`.

- [ ] **Step 6: Run the tests**

```bash
pnpm --filter @memry/desktop test:renderer -- tag-view
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/src
git commit -m "feat(tags): add the single tag tab"
```

---

### Task 15: Tag items backend

**Files:**

- Create: `apps/desktop/src/main/database/queries/tag-items.ts`
- Modify: `packages/contracts/src/ipc-channels.ts`
- Modify: `apps/desktop/src/main/ipc/tags-handlers.ts`
- Test: `apps/desktop/src/main/database/queries/tag-items.test.ts`

**Interfaces:**

- Produces: `listTagItems(db, tag: string): TagItem[]` where
  `TagItem = { id: string; kind: 'note' | 'task' | 'inbox'; title: string; emoji: string | null; path: string | null; tags: string[]; container: string | null; created: string; modified: string }`.
  `container` is the folder for a note, the project name for a task, and `null` for an inbox item. Channel: `tags:list-items`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/main/database/queries/tag-items.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { listTagItems } from './tag-items'
import { createTestDataDb, type TestDataDb } from '../../../test/helpers/test-data-db'
import { seedNote, seedTask, seedInboxItem } from '../../../test/helpers/seed'

let db: TestDataDb

beforeEach(() => {
  db = createTestDataDb()
})

describe('listTagItems', () => {
  it('returns notes, tasks and inbox items for a tag', () => {
    seedNote(db, { id: 'n1', title: 'Q3 kickoff', tags: ['meetings'] })
    seedTask(db, { id: 't1', title: '1:1 with Ali', tags: ['meetings'] })
    seedInboxItem(db, { id: 'i1', title: 'Meeting notes', tags: ['meetings'] })

    const items = listTagItems(db, 'meetings')

    expect(items.map((i) => i.kind).sort()).toEqual(['inbox', 'note', 'task'])
  })

  it('includes descendant tags', () => {
    seedNote(db, { id: 'n1', title: 'Own', tags: ['work'] })
    seedNote(db, { id: 'n2', title: 'Child', tags: ['work/meetings'] })

    expect(
      listTagItems(db, 'work')
        .map((i) => i.id)
        .sort()
    ).toEqual(['n1', 'n2'])
  })

  it('does not match a tag that merely shares a prefix', () => {
    seedNote(db, { id: 'n1', title: 'Own', tags: ['work'] })
    seedNote(db, { id: 'n2', title: 'Other', tags: ['workshop'] })

    expect(listTagItems(db, 'work').map((i) => i.id)).toEqual(['n1'])
  })

  it('matches case-insensitively', () => {
    seedNote(db, { id: 'n1', title: 'Own', tags: ['Work'] })
    expect(listTagItems(db, 'work')).toHaveLength(1)
  })

  it('returns an empty array for an unused tag', () => {
    expect(listTagItems(db, 'nothing')).toEqual([])
  })
})
```

The prefix test is the important one. Descendant matching is `tag = ?` OR `tag LIKE ? || '/%'` — never a bare `LIKE 'work%'`, which would wrongly match `workshop`.

If `apps/desktop/src/test/helpers/seed.ts` does not exist, search for the seeding helpers the existing query tests use (`rtk grep -rln "seedNote" apps/desktop/src`) and reuse them; only add helpers if none exist.

- [ ] **Step 2: Run it to make sure it fails**

```bash
pnpm --filter @memry/desktop test:main -- queries/tag-items
```

Expected: FAIL — cannot resolve `./tag-items`.

- [ ] **Step 3: Implement the query**

Three selects — `note_tags` joined to the notes cache, `task_tags` joined to tasks and their project, `inbox_item_tags` joined to inbox items — each filtered with the exact-or-descendant predicate, then concatenated. SQLite's `LIKE` is ASCII-only for case folding; the tag columns are `NOCASE` where it matters, but normalize the input with `.toLowerCase().trim()` regardless.

- [ ] **Step 4: Add the channel and handler**

Channel `LIST_ITEMS: 'tags:list-items'` in `TagsChannels.invoke`, and a handler in `tags-handlers.ts` returning `{ success: true, items }` with the same error wrapping as its neighbors.

- [ ] **Step 5: Run the tests and the IPC gate**

```bash
pnpm --filter @memry/desktop test:main -- queries/tag-items
pnpm ipc:generate && pnpm ipc:check
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main packages/contracts apps/desktop/src/preload
git commit -m "feat(tags): list notes, tasks and inbox items for a tag"
```

---

### Task 16: Give the table a row kind

**Files:**

- Modify: `apps/desktop/src/renderer/src/hooks/use-folder-view.ts:56`
- Modify: `apps/desktop/src/renderer/src/components/folder-view/folder-table-view.tsx`
- Test: `apps/desktop/src/renderer/src/components/folder-view/folder-table-view.test.tsx`

**Interfaces:**

- Produces: `NoteWithProperties` gains `kind?: 'note' | 'task' | 'inbox'`, defaulting to `'note'` when absent. `FolderTableView` renders a `kind` column only when a `kind` column is present in its `columns` prop.

- [ ] **Step 1: Write the failing test**

Append to the existing `folder-table-view.test.tsx`:

```tsx
it('renders the kind column when configured', () => {
  render(
    <FolderTableView
      notes={[
        { ...baseNote, id: 'n1', title: 'A note', kind: 'note' },
        { ...baseNote, id: 't1', title: 'A task', kind: 'task' }
      ]}
      columns={[
        { id: 'title', width: 300 },
        { id: 'kind', width: 100 }
      ]}
    />
  )

  expect(screen.getByText('Task')).toBeInTheDocument()
})

it('treats a row without a kind as a note', () => {
  render(
    <FolderTableView
      notes={[{ ...baseNote, id: 'n1', title: 'A note' }]}
      columns={[
        { id: 'title', width: 300 },
        { id: 'kind', width: 100 }
      ]}
    />
  )

  expect(screen.getByText('Note')).toBeInTheDocument()
})
```

Reuse whatever `baseNote` fixture the existing tests in that file already define; do not add a second fixture.

- [ ] **Step 2: Run it to make sure it fails**

```bash
pnpm --filter @memry/desktop test:renderer -- folder-table-view
```

Expected: FAIL — nothing renders "Task".

- [ ] **Step 3: Add the field**

In `use-folder-view.ts`, add to `NoteWithProperties`:

```ts
  /** Row kind. Absent means 'note' — folder views only ever contain notes. */
  kind?: 'note' | 'task' | 'inbox'
```

- [ ] **Step 4: Handle the column**

In `getColumnType`, map `'kind'` to the same property type used for plain text. In the cell renderer, render the localized label for `row.kind ?? 'note'` with the same status icon the tasks list uses for a task row.

This is the entire change to the folder view. Do not touch its data flow, its config persistence, or its other columns.

- [ ] **Step 5: Run the folder view suite**

```bash
pnpm --filter @memry/desktop test:renderer -- folder-view
```

Expected: PASS, including every pre-existing folder-view test. Any regression here means the change was not additive — revert and narrow it.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src
git commit -m "feat(folder-view): support a row kind so the table can be shared"
```

---

### Task 17: Tag page header actions

**Files:**

- Modify: `apps/desktop/src/renderer/src/pages/tag-view.tsx`
- Test: `apps/desktop/src/renderer/src/pages/tag-view.test.tsx`

**Interfaces:**

- Consumes: `TagRenameDialog`, `TagDeleteDialog`, `TagIconChip`, `COLOR_NAMES`, `getTagColors`, `tagsService` — all already exist and are reused unchanged.
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

```tsx
it('offers rename, color, icon and delete', async () => {
  render(<TagViewPage tag="meetings" />)
  await userEvent.click(screen.getByRole('button', { name: /tag actions/i }))

  expect(screen.getByRole('menuitem', { name: /rename/i })).toBeInTheDocument()
  expect(screen.getByRole('menuitem', { name: /color/i })).toBeInTheDocument()
  expect(screen.getByRole('menuitem', { name: /delete/i })).toBeInTheDocument()
})

it('closes the tab when the tag is deleted elsewhere', async () => {
  const closeTab = vi.fn()
  renderWithTabs(<TagViewPage tag="meetings" />, { closeTab })

  emitTagDeleted({ tag: 'meetings' })

  await waitFor(() => expect(closeTab).toHaveBeenCalled())
})
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
pnpm --filter @memry/desktop test:renderer -- tag-view
```

Expected: FAIL — no actions menu.

- [ ] **Step 3: Port the overflow menu**

Move `TagOverflowMenu` out of `tag-detail-view.tsx` into the tag page. It is self-contained (rename, color submenu, delete) and needs no changes beyond its import path. `tag-detail-view.tsx` is deleted in Task 20, so this is a move, not a duplication.

- [ ] **Step 4: Handle the rename and delete lifecycle**

Subscribe to `onTagRenamed` and `onTagDeleted`. On a rename that matches this tab's tag, update the tab's title and `entityId`. On a delete that matches, close the tab. This replaces the `goBack()` the drill-down used.

- [ ] **Step 5: Run the tests**

```bash
pnpm --filter @memry/desktop test:renderer -- tag-view
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src
git commit -m "feat(tags): tag page header actions"
```

---

### Task 18: Tag page table

**Files:**

- Create: `apps/desktop/src/renderer/src/hooks/use-tag-items.ts`
- Modify: `apps/desktop/src/renderer/src/pages/tag-view.tsx`
- Test: `apps/desktop/src/renderer/src/hooks/use-tag-items.test.ts`
- Test: `apps/desktop/src/renderer/src/pages/tag-view.test.tsx`

**Interfaces:**

- Consumes: `listTagItems` over IPC (Task 15), `FolderTableView` with `kind` (Task 16).
- Produces: `useTagItems({ tag })` returning `{ items: NoteWithProperties[]; total: number; isLoading: boolean; error: string | null; refresh(): Promise<void> }`. Rows are already adapted — `path` is the note path for notes and a synthetic `/tasks/<id>` or `/inbox/<id>` otherwise, `folder` carries `container`, `wordCount` is `0` for non-notes.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/renderer/src/hooks/use-tag-items.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useTagItems } from './use-tag-items'

const listItems = vi.fn()

vi.mock('@/services/tags-service', () => ({
  tagsService: { listItems: (...a: unknown[]) => listItems(...a) },
  onTagRenamed: () => () => {},
  onTagDeleted: () => () => {}
}))

beforeEach(() => {
  listItems.mockResolvedValue({
    success: true,
    items: [
      {
        id: 't1',
        kind: 'task',
        title: 'Ali ile 1:1',
        emoji: null,
        path: null,
        tags: ['meetings'],
        container: 'Project X',
        created: '2026-07-20T00:00:00Z',
        modified: '2026-07-22T00:00:00Z'
      }
    ]
  })
})

describe('useTagItems', () => {
  it('adapts a task into a table row', async () => {
    const { result } = renderHook(() => useTagItems({ tag: 'meetings' }))
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    const row = result.current.items[0]
    expect(row.kind).toBe('task')
    expect(row.folder).toBe('Project X')
    expect(row.path).toBe('/tasks/t1')
    expect(row.wordCount).toBe(0)
  })

  it('reports the total', async () => {
    const { result } = renderHook(() => useTagItems({ tag: 'meetings' }))
    await waitFor(() => expect(result.current.total).toBe(1))
  })

  it('surfaces a failure as an error string', async () => {
    listItems.mockResolvedValue({ success: false, error: 'boom' })
    const { result } = renderHook(() => useTagItems({ tag: 'meetings' }))
    await waitFor(() => expect(result.current.error).toBe('boom'))
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
pnpm --filter @memry/desktop test:renderer -- use-tag-items
```

Expected: FAIL — cannot resolve `./use-tag-items`.

- [ ] **Step 3: Implement the hook**

Fetch on mount and on `tag` change, adapt each `TagItem` into a `NoteWithProperties`, and expose `refresh`. Subscribe to `tags:notes-changed` and `notes:tags-changed` to refetch.

- [ ] **Step 4: Write the page test for the filter and routing**

```tsx
it('filters to a single kind', async () => {
  render(<TagViewPage tag="meetings" />)
  await userEvent.click(screen.getByRole('button', { name: /all/i }))
  await userEvent.click(screen.getByRole('menuitemradio', { name: /tasks/i }))

  expect(screen.queryByText('Q3 kickoff')).not.toBeInTheDocument()
})

it('opens a task in the tasks tab', async () => {
  const openSidebarItem = vi.fn()
  renderWithNavigation(<TagViewPage tag="meetings" />, { openSidebarItem })

  await userEvent.click(screen.getByText('Ali ile 1:1'))

  expect(openSidebarItem).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'tasks',
      viewState: expect.objectContaining({ openTaskId: 't1' })
    })
  )
})
```

- [ ] **Step 5: Render the table**

Columns: `title`, `kind`, `tags`, `folder`, `modified`. The kind filter is a `Picker` in the toolbar with All / Notes / Tasks / Inbox, filtering `items` client-side. `onNoteOpen` routes by the row's `kind`:

- `note` → `openSidebarItem({ type: 'note', path, entityId: id, title, emoji })`
- `task` → `openSidebarItem({ type: 'tasks', ..., viewState: { openTaskId: id, activeInternalTab: 'all', activeTab: 'all' } })` — the exact shape `tag-detail-view.tsx:158` uses today
- `inbox` → `openSidebarItem({ type: 'inbox', ..., viewState: { selectedItemId: id } })`

Keep the pin action from `useTagDetail` as a row action for note rows so pinning a note to a tag survives the drill-down's removal.

- [ ] **Step 6: Run the tests**

```bash
pnpm --filter @memry/desktop test:renderer -- tag-view
pnpm --filter @memry/desktop test:renderer -- use-tag-items
```

Expected: PASS.

- [ ] **Step 7: Run the phase gates**

```bash
pnpm lint && pnpm typecheck && pnpm test
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/renderer/src
git commit -m "feat(tags): show tagged notes, tasks and inbox items in a table"
```

---

# Phase 4 — Sidebar migration

### Task 19: Group the sidebar by category

**Files:**

- Modify: `apps/desktop/src/renderer/src/components/sidebar/sidebar-tag-list.tsx`
- Test: `apps/desktop/src/renderer/src/components/sidebar/sidebar-tag-list.test.tsx`

**Interfaces:**

- Consumes: `useTagCategories` from Task 8.
- Produces: `TagSortOption` gains `'manual'`, which becomes the default in `loadSortPreference`.

- [ ] **Step 1: Write the failing test**

Append to the existing `sidebar-tag-list.test.tsx`:

```tsx
it('groups tags under their category heading', () => {
  renderSidebarTagList()
  expect(screen.getByText('Work')).toBeInTheDocument()
  expect(screen.getByText('Uncategorized')).toBeInTheDocument()
})

it('defaults to manual sort', () => {
  localStorage.removeItem('sidebar-tags-sort')
  renderSidebarTagList()
  expect(screen.getByLabelText(/sort tags: manual/i)).toBeInTheDocument()
})

it('keeps the existing sort options working inside each category', async () => {
  renderSidebarTagList()
  await userEvent.click(screen.getByLabelText(/sort tags/i))
  await userEvent.click(screen.getByRole('option', { name: /a → z/i }))

  const work = within(screen.getByTestId('tag-group-work'))
  expect(work.getAllByRole('button').map((b) => b.textContent)).toEqual(['meetings', 'okr'])
})
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
pnpm --filter @memry/desktop test:renderer -- sidebar-tag-list
```

Expected: FAIL — no category headings.

- [ ] **Step 3: Add the Manual option**

Add `{ value: 'manual', label: 'Manual' }` as the first entry in `SORT_OPTIONS`, add its icon to `SORT_ICONS` (`GripVertical`), and change `loadSortPreference`'s fallback from `'count-desc'` to `'manual'`. Existing users keep whatever is already in `localStorage`.

- [ ] **Step 4: Group the tree**

Wrap the existing `buildTagTree` output per category: build the tree from that category's tags only, so the `/` tree still renders inside each group. Category headings are collapsible and their expanded state joins the existing `EXPANDED_STORAGE_KEY` set under a `category:<id>` key prefix. When `sortBy === 'manual'`, order by `sortOrder`; otherwise apply the existing comparator within each group.

Categories come from `useTagCategories`; a tag whose `categoryId` has no matching category falls into Uncategorized, matching the hub.

- [ ] **Step 5: Run the tests**

```bash
pnpm --filter @memry/desktop test:renderer -- sidebar-tag-list
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/components/sidebar
git commit -m "feat(sidebar): group tags by category with a manual order"
```

---

### Task 20: Open a tab on click and delete the drill-down

**Files:**

- Modify: `apps/desktop/src/renderer/src/components/sidebar/sidebar-tag-list.tsx`
- Modify: `apps/desktop/src/renderer/src/contexts/sidebar-drill-down.tsx`
- Modify: `apps/desktop/src/renderer/src/components/sidebar/sidebar-drill-down-container.tsx`
- Delete: `apps/desktop/src/renderer/src/components/sidebar/tag-detail-view.tsx`
- Delete: `apps/desktop/src/renderer/src/components/sidebar/tag-detail-view.test.tsx`
- Test: `apps/desktop/src/renderer/src/components/sidebar/sidebar-tag-list.test.tsx`

**Interfaces:**

- Produces: clicking a sidebar tag calls `openSidebarItem({ type: 'tag', title: tag, path: '/tags/' + tag, entityId: tag, color })`.

- [ ] **Step 1: Write the failing test**

```tsx
it('opens a tag tab instead of a drill-down', async () => {
  const openSidebarItem = vi.fn()
  renderSidebarTagList({ openSidebarItem })

  await userEvent.click(screen.getByRole('button', { name: /meetings/ }))

  expect(openSidebarItem).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'tag', entityId: 'meetings' })
  )
})
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
pnpm --filter @memry/desktop test:renderer -- sidebar-tag-list
```

Expected: FAIL — the click still pushes a drill-down.

- [ ] **Step 3: Change the click handler**

Replace the `onTagClick` prop plumbing with a direct `openSidebarItem` call. Remove the now-unused `selectedTag` prop and its callers if nothing else reads it.

- [ ] **Step 4: Remove the drill-down branch**

Delete the tag case from `sidebar-drill-down.tsx` and from `sidebar-drill-down-container.tsx`. Keep every other drill-down type intact.

- [ ] **Step 5: Delete the dead component**

```bash
git rm apps/desktop/src/renderer/src/components/sidebar/tag-detail-view.tsx \
       apps/desktop/src/renderer/src/components/sidebar/tag-detail-view.test.tsx
```

Then confirm nothing still imports it:

```bash
rtk grep -rn "tag-detail-view\|TagDetailView" apps/desktop/src
```

Expected: no matches. `useTagDetail` and `useTaskTagDetail` may still be referenced by the tag page — check before removing either.

- [ ] **Step 6: Run the tests**

```bash
pnpm --filter @memry/desktop test:renderer -- sidebar
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A apps/desktop/src/renderer/src
git commit -m "feat(sidebar): open a tag tab and remove the tag drill-down"
```

---

### Task 21: E2E, docs, and the release gates

**Files:**

- Create: `apps/desktop/e2e/tag-categories.spec.ts`
- Modify: `apps/docs/src/**` (routed by `docs:impact`)
- Modify: `CLAUDE.md` if any command in it changed (it should not)

- [ ] **Step 1: Write the E2E spec**

```ts
// apps/desktop/e2e/tag-categories.spec.ts
import { test, expect } from './fixtures'

test('clicking a sidebar tag opens a tag tab with its items', async ({ app }) => {
  await app.sidebar.expandSection('Tags')
  await app.sidebar.clickTag('meetings')

  await expect(app.tabs.active()).toHaveText(/meetings/)
  await expect(app.page.getByRole('table')).toBeVisible()
})

test('a category created in the hub persists across a restart', async ({ app }) => {
  await app.sidebar.openTagHub()
  await app.page.getByRole('button', { name: /new category/i }).click()
  await app.page.getByRole('textbox').fill('Work')
  await app.page.keyboard.press('Enter')

  await app.restart()

  await app.sidebar.openTagHub()
  await expect(app.page.getByText('Work')).toBeVisible()
})
```

Use whatever fixture and page-object shape the existing specs in `apps/desktop/e2e/` already use — read one before writing this. The onboarding tour blocks the suite; make sure the fixture disables it the way the other specs do.

- [ ] **Step 2: Run the E2E suite**

```bash
pnpm test:e2e
```

Expected: PASS. A stale build is the usual cause of a failure here — rebuild before assuming a real regression.

- [ ] **Step 3: Update the docs**

```bash
pnpm docs:impact --base origin/main --strict
```

If it reports `missing-docs`, add real pages under `apps/docs/src/**` covering tag categories, the hub, and the tag page — or run `pnpm docs:ai-update --base origin/main` and then edit what it produces. Do not use `MEMRY_DOCS_IMPACT_SKIP=1`; this change is user-visible and genuinely needs docs.

- [ ] **Step 4: Build the docs**

```bash
pnpm docs:build
```

Expected: PASS.

- [ ] **Step 5: Run every gate**

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm ipc:generate && pnpm ipc:check
pnpm --filter @memry/desktop i18n:check
pnpm check:architecture
pnpm check:contracts
git diff --check
```

Expected: all PASS.

- [ ] **Step 6: Verify the mixed-version story by hand**

Run two dev profiles against one vault:

```bash
pnpm --filter @memry/desktop dev:a
```

```bash
pnpm --filter @memry/desktop dev:b
```

Create a category and drag tags on A, confirm the same grouping and order appear on B. This is the only check that exercises the real sync path end to end; the handler tests cover the merge logic but not the queue and transport.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "test(tags): e2e coverage and docs for tag categories"
```

---

## Self-review notes

**Spec coverage:** Data model → Task 1. Migration → Task 1. Category queries → Task 2. Sync registration → Task 3. Category handler → Task 4. Tag payload extension and the old-build compatibility case → Task 5. IPC → Tasks 6 and 15. Hub layout, counts, chips → Tasks 7–9. Inline creation → Task 10. Category rename and delete semantics → Task 11. Drag and drop → Task 12. Search → Task 13. Tag tab → Task 14. Descendant inclusion → Task 15. Shared table → Tasks 16 and 18. Header actions and pinning → Tasks 17 and 18. Sidebar grouping, Manual sort, drill-down deletion → Tasks 19 and 20. E2E and docs → Task 21.

**Open items deliberately left to the implementer:** whether `test-data-db` and `seed` helpers already exist under `apps/desktop/src/test/helpers` (Tasks 2 and 15 both say to search first and reuse), and whether the tab reducer dedupes non-singleton tabs on `entityId` or `path` (Task 14 covers both branches). Neither changes the design.
