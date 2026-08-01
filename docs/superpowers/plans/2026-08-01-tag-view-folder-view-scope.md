# Tag View as a Scoped Folder View — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clicking a tag opens the folder view scoped to that tag, and the standalone tag page is deleted.

**Architecture:** A `ViewScope` discriminated union (`folder` | `tag`) replaces the `folderPath` string threaded through four IPC channels, the `useFolderView` hook and the folder view page. Under tag scope the main process sources rows from the existing `listTagItems` query and enriches note rows with the same property batch-fetch the folder path already uses. Saved views persist to `.folder.md` for folders and to a new `tag_definitions.views` column for tags.

**Tech Stack:** Electron + React 19, TypeScript, Drizzle ORM over better-sqlite3 (dual data/index DBs), Zod v4 IPC contracts, Vitest, i18next.

## Global Constraints

- **Worktree:** all work happens in `/Users/h4yfans/workspace/memry/.worktrees/tag-view-folder-view-scope` on branch `tag-view-folder-view-scope`. Never `cd` to the main checkout or another worktree.
- **Base:** `origin/tag-categories` (`013a9afb3`). This branch stacks on PR #901; it does not target `main` directly.
- **Production compatibility is mandatory.** Existing installs must keep working. DB changes are additive, hand-written migrations only — Drizzle snapshots are broken past 0021.
- **Logging:** `createLogger('Scope')`, never raw `console.*`.
- **User-facing errors:** `extractErrorMessage(err, fallback)` from `@/lib/ipc-error`.
- **Tailwind logical properties** in new/edited markup: `ms-*`/`me-*`, `ps-*`/`pe-*`, `start-*`/`end-*`, `text-start`/`text-end`, `border-s`/`border-e`, `rounded-s-*`/`rounded-e-*`.
- **After any contract edit:** `pnpm ipc:generate` then `pnpm ipc:check`.
- `getIndexDatabase` is imported into `folder-view-handlers.ts` under the alias `getDataDb`. It is the **index** DB. Do not "fix" the alias in this work; do not assume it means the data DB.
- Every task ends green: `pnpm --filter @memry/desktop typecheck:web` and `typecheck:node` as relevant, plus the task's own tests.

---

## File Structure

**Contract**

- Modify `packages/contracts/src/folder-view-api.ts` — `ViewScope`, `ViewScopeSchema`, `scopeKey`, request schemas for the four scoped channels.

**Main process**

- Create `apps/desktop/src/main/database/drizzle-data/0041_tag_definition_views.sql`
- Modify `packages/db-schema/src/schema/tag-definitions.ts` — `views` column
- Modify `apps/desktop/src/main/database/queries/tag-definitions.ts` — `readTagViews` / `writeTagViews`
- Modify `apps/desktop/src/main/sync/item-handlers/tag-definition-handler.ts` — `undefined` vs `null` merge guard
- Modify `apps/desktop/src/main/ipc/folder-view-handlers.ts` — scope dispatch in four handlers

**Preload / services**

- Modify `apps/desktop/src/preload/api/folder-view.ts`
- Modify the renderer folder-view service and `apps/desktop/src/main/ipc/generated-ipc-invoke-map.ts` (generated)

**Renderer**

- Modify `apps/desktop/src/renderer/src/hooks/use-folder-view.ts` — `scope` option, scope-keyed query keys
- Modify `apps/desktop/src/renderer/src/pages/folder-view.tsx` — `scope` prop, tag header, row opening by kind, tab lifecycle
- Modify `apps/desktop/src/renderer/src/components/folder-view/filter-builder.tsx` — `lockedCondition`
- Modify `apps/desktop/src/renderer/src/components/folder-view/bulk-action-bar.tsx` — pin to tag
- Modify `apps/desktop/src/renderer/src/components/folder-view/note-card-pieces.tsx` — kind icon
- Move `apps/desktop/src/renderer/src/pages/tag-view/tag-overflow-menu.tsx` → `apps/desktop/src/renderer/src/components/folder-view/tag-overflow-menu.tsx`

**Deleted**

- `apps/desktop/src/renderer/src/pages/tag-view.tsx`, `pages/tag-view.test.tsx`, `pages/tag-view/`
- `apps/desktop/src/renderer/src/hooks/use-tag-items.ts`, `use-tag-items.test.ts`
- `TAGS.LIST_ITEMS` channel + its handler and preload/service wiring

---

### Task 1: `ViewScope` in the contract

**Files:**

- Modify: `packages/contracts/src/folder-view-api.ts`
- Test: `packages/contracts/src/folder-view-api.test.ts` (create if absent)

**Interfaces:**

- Produces: `ViewScope`, `ViewScopeSchema`, `scopeKey(scope: ViewScope): string`, and scoped request schemas `GetViewsRequestSchema`, `SetViewRequestSchema`, `DeleteViewRequestSchema`, `ListWithPropertiesRequestSchema`, `GetAvailablePropertiesRequestSchema` — each now taking `scope` instead of `folderPath`.

Note: `GET_CONFIG` and `SET_CONFIG` stay folder-only. They read and write `.folder.md`, which a tag has no equivalent of.

- [ ] **Step 1: Write the failing test**

Create `packages/contracts/src/folder-view-api.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { ViewScopeSchema, scopeKey } from './folder-view-api'

describe('ViewScope', () => {
  it('accepts a folder scope, including the empty root path', () => {
    expect(ViewScopeSchema.parse({ kind: 'folder', path: '' })).toEqual({
      kind: 'folder',
      path: ''
    })
    expect(ViewScopeSchema.parse({ kind: 'folder', path: 'projects' })).toEqual({
      kind: 'folder',
      path: 'projects'
    })
  })

  it('accepts a tag scope but rejects an empty tag', () => {
    expect(ViewScopeSchema.parse({ kind: 'tag', tag: 'araba' })).toEqual({
      kind: 'tag',
      tag: 'araba'
    })
    expect(ViewScopeSchema.safeParse({ kind: 'tag', tag: '' }).success).toBe(false)
  })

  it('rejects an unknown kind', () => {
    expect(ViewScopeSchema.safeParse({ kind: 'project', id: 'x' }).success).toBe(false)
  })

  it('produces stable, collision-free cache keys', () => {
    expect(scopeKey({ kind: 'folder', path: 'work' })).toBe('folder:work')
    expect(scopeKey({ kind: 'folder', path: '' })).toBe('folder:')
    expect(scopeKey({ kind: 'tag', tag: 'work' })).toBe('tag:work')
  })

  it('folds tag case, because tags are case-preserving but match case-insensitively', () => {
    expect(scopeKey({ kind: 'tag', tag: 'Araba' })).toBe(scopeKey({ kind: 'tag', tag: 'araba' }))
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @memry/contracts test -- folder-view-api
```

Expected: FAIL — `ViewScopeSchema` and `scopeKey` are not exported.

- [ ] **Step 3: Implement**

In `packages/contracts/src/folder-view-api.ts`, after the `PropertyType` block:

```typescript
// ============================================================================
// View Scope — what a folder view is looking at
// ============================================================================

/**
 * What a folder view is scoped to. A folder view over a directory and a
 * folder view over a tag are the same page with a different row source.
 */
export type ViewScope = { kind: 'folder'; path: string } | { kind: 'tag'; tag: string }

export const ViewScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('folder'), path: z.string() }),
  z.object({ kind: z.literal('tag'), tag: z.string().min(1) })
])

/**
 * Stable cache/query key for a scope. Tag names are case-preserving but
 * match case-insensitively (see migration 0034), so the key folds case for
 * tags and preserves it for paths.
 */
export function scopeKey(scope: ViewScope): string {
  return scope.kind === 'folder' ? `folder:${scope.path}` : `tag:${scope.tag.toLowerCase()}`
}
```

Then replace `folderPath` with `scope` in exactly these five request schemas — leave `GetConfigRequestSchema` and `SetConfigRequestSchema` alone:

```typescript
export const GetViewsRequestSchema = z.object({
  scope: ViewScopeSchema
})

export const SetViewRequestSchema = z.object({
  scope: ViewScopeSchema,
  view: ViewConfigSchema
})

export const DeleteViewRequestSchema = z.object({
  scope: ViewScopeSchema,
  viewName: z.string()
})

export const ListWithPropertiesRequestSchema = z.object({
  scope: ViewScopeSchema,
  /** Property IDs to fetch (in addition to built-in fields) */
  properties: z.array(z.string()).optional(),
  /** Pagination limit */
  limit: z.number().int().min(1).max(1000).default(500),
  /** Pagination offset */
  offset: z.number().int().min(0).default(0)
})

export const GetAvailablePropertiesRequestSchema = z.object({
  scope: ViewScopeSchema
})
```

Update `FolderViewClientAPI` to match:

```typescript
  getViews(scope: ViewScope): Promise<GetViewsResponse>

  setView(scope: ViewScope, view: ViewConfig): Promise<SetViewResponse>

  deleteView(scope: ViewScope, viewName: string): Promise<DeleteViewResponse>

  listWithProperties(
    options: z.infer<typeof ListWithPropertiesRequestSchema>
  ): Promise<ListWithPropertiesResponse>

  getAvailableProperties(scope: ViewScope): Promise<GetAvailablePropertiesResponse>
```

- [ ] **Step 4: Run the test**

```bash
pnpm --filter @memry/contracts test -- folder-view-api
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

The rest of the repo does not compile yet — that is expected and is resolved by Tasks 4–9. Commit the contract alone so the type surface is one reviewable unit.

```bash
git add packages/contracts/src/folder-view-api.ts packages/contracts/src/folder-view-api.test.ts
git commit -m "feat(folder-view): introduce ViewScope for folder and tag scoping"
```

---

### Task 2: Persist saved views for a tag

**Files:**

- Create: `apps/desktop/src/main/database/drizzle-data/0041_tag_definition_views.sql`
- Modify: `packages/db-schema/src/schema/tag-definitions.ts`
- Modify: `apps/desktop/src/main/database/queries/tag-definitions.ts`
- Test: `apps/desktop/src/main/database/queries/tag-definitions.test.ts`

**Interfaces:**

- Consumes: `ViewConfig` from `@memry/contracts/folder-view-api`.
- Produces: `readTagViews(db: DataDb, tag: string): ViewConfig[] | null` and `writeTagViews(db: DataDb, tag: string, views: ViewConfig[] | null): void`.

The column is plain `TEXT`, parsed at the query layer. Typing it as JSON in `db-schema` would make that package depend on `contracts`, which `pnpm check:architecture` forbids.

- [ ] **Step 1: Write the migration**

Create `apps/desktop/src/main/database/drizzle-data/0041_tag_definition_views.sql`:

```sql
-- Saved folder-view configurations for a tag.
-- Additive and nullable: existing rows keep NULL, which the handler reads as
-- "no saved views" and resolves to DEFAULT_VIEW, exactly as a folder with no
-- views in its .folder.md does.
ALTER TABLE tag_definitions ADD COLUMN views TEXT;
```

- [ ] **Step 2: Add the schema column**

In `packages/db-schema/src/schema/tag-definitions.ts`, add to the `tagDefinitions` table after `sortOrder`:

```typescript
views: text('views')
```

- [ ] **Step 3: Write the failing test**

Append to `apps/desktop/src/main/database/queries/tag-definitions.test.ts`:

```typescript
describe('tag views', () => {
  it('returns null for a tag that has never saved a view', () => {
    upsertTagDefinition(db, { name: 'araba', color: 'red' })
    expect(readTagViews(db, 'araba')).toBeNull()
  })

  it('round-trips a saved view', () => {
    upsertTagDefinition(db, { name: 'araba', color: 'red' })
    const views: ViewConfig[] = [
      { name: 'Open tasks', type: 'table', default: true, columns: [{ id: 'title', width: 250 }] }
    ]
    writeTagViews(db, 'araba', views)
    expect(readTagViews(db, 'araba')).toEqual(views)
  })

  it('matches the tag case-insensitively, like every other tag lookup', () => {
    upsertTagDefinition(db, { name: 'Araba', color: 'red' })
    writeTagViews(db, 'araba', [{ name: 'A', type: 'table' }])
    expect(readTagViews(db, 'ARABA')).toEqual([{ name: 'A', type: 'table' }])
  })

  it('clears saved views when given null', () => {
    upsertTagDefinition(db, { name: 'araba', color: 'red' })
    writeTagViews(db, 'araba', [{ name: 'A', type: 'table' }])
    writeTagViews(db, 'araba', null)
    expect(readTagViews(db, 'araba')).toBeNull()
  })

  it('returns null rather than throwing on corrupt JSON', () => {
    upsertTagDefinition(db, { name: 'araba', color: 'red' })
    db.run(sql`UPDATE tag_definitions SET views = '{not json' WHERE name = 'araba'`)
    expect(readTagViews(db, 'araba')).toBeNull()
  })
})
```

Add the imports the test needs at the top of the file: `readTagViews`, `writeTagViews` from `./tag-definitions`, `type ViewConfig` from `@memry/contracts/folder-view-api`, and `sql` from `drizzle-orm`.

- [ ] **Step 4: Run it and watch it fail**

```bash
pnpm --filter @memry/desktop test:main -- tag-definitions
```

Expected: FAIL — `readTagViews` is not exported.

- [ ] **Step 5: Implement**

In `apps/desktop/src/main/database/queries/tag-definitions.ts`:

```typescript
/**
 * Saved folder-view configurations for a tag.
 *
 * Folders keep theirs in `.folder.md`; a tag has no directory, so they live
 * on the tag_definitions row and sync with the tag definition itself.
 * Corrupt JSON reads as "no saved views" rather than throwing — a bad blob
 * must not make the tag unopenable.
 */
export function readTagViews(db: DataDb, tag: string): ViewConfig[] | null {
  const row = db
    .select({ views: tagDefinitions.views })
    .from(tagDefinitions)
    .where(eq(tagDefinitions.name, tag))
    .get()

  if (!row?.views) return null
  try {
    const parsed = JSON.parse(row.views)
    return Array.isArray(parsed) ? (parsed as ViewConfig[]) : null
  } catch {
    log.warn('Discarding corrupt saved views for tag', { tag })
    return null
  }
}

export function writeTagViews(db: DataDb, tag: string, views: ViewConfig[] | null): void {
  db.update(tagDefinitions)
    .set({ views: views && views.length > 0 ? JSON.stringify(views) : null })
    .where(eq(tagDefinitions.name, tag))
    .run()
}
```

`tagDefinitions.name` is `nocaseText`, so the case-insensitive test passes without a `lower()` call.

- [ ] **Step 6: Run the tests**

```bash
pnpm --filter @memry/desktop test:main -- tag-definitions
```

Expected: PASS, 5 new tests.

- [ ] **Step 7: Verify the migration applies to an existing vault**

```bash
pnpm --filter @memry/desktop db:push
```

Expected: applies `0041` with no error and no data loss.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/main/database/drizzle-data/0041_tag_definition_views.sql packages/db-schema/src/schema/tag-definitions.ts apps/desktop/src/main/database/queries/tag-definitions.ts apps/desktop/src/main/database/queries/tag-definitions.test.ts
git commit -m "feat(tags): persist saved views on the tag definition"
```

---

### Task 3: Stop an older client from wiping saved views

**Files:**

- Modify: `apps/desktop/src/main/sync/item-handlers/tag-definition-handler.ts`
- Test: `apps/desktop/src/main/sync/item-handlers/tag-definition-handler.test.ts`

**Interfaces:**

- Consumes: `readTagViews` / `writeTagViews` from Task 2.

This is the compatibility hazard the spec calls out. A client that predates Task 2 pushes a `tag_definition` payload with no `views` key at all. If the pull path treats "absent" as "empty", every device loses its saved views the first time an old client touches the tag. `project_links` already shipped this bug once.

- [ ] **Step 1: Write the failing test**

Append to `apps/desktop/src/main/sync/item-handlers/tag-definition-handler.test.ts`:

```typescript
describe('views merge on pull', () => {
  it('keeps local views when the payload omits the field (older client)', async () => {
    upsertTagDefinition(db, { name: 'araba', color: 'red' })
    writeTagViews(db, 'araba', [{ name: 'Mine', type: 'table' }])

    await handler.applyRemote(db, {
      name: 'araba',
      color: 'blue',
      clock: { deviceB: 2 }
      // no `views` key — this is the whole point
    })

    expect(readTagViews(db, 'araba')).toEqual([{ name: 'Mine', type: 'table' }])
  })

  it('clears local views when the payload explicitly sends null', async () => {
    upsertTagDefinition(db, { name: 'araba', color: 'red' })
    writeTagViews(db, 'araba', [{ name: 'Mine', type: 'table' }])

    await handler.applyRemote(db, {
      name: 'araba',
      color: 'blue',
      views: null,
      clock: { deviceB: 2 }
    })

    expect(readTagViews(db, 'araba')).toBeNull()
  })

  it('overwrites local views when the payload sends its own', async () => {
    upsertTagDefinition(db, { name: 'araba', color: 'red' })
    writeTagViews(db, 'araba', [{ name: 'Mine', type: 'table' }])

    await handler.applyRemote(db, {
      name: 'araba',
      color: 'blue',
      views: [{ name: 'Theirs', type: 'list' }],
      clock: { deviceB: 2 }
    })

    expect(readTagViews(db, 'araba')).toEqual([{ name: 'Theirs', type: 'list' }])
  })

  it('includes views in the pushed payload', () => {
    upsertTagDefinition(db, { name: 'araba', color: 'red' })
    writeTagViews(db, 'araba', [{ name: 'Mine', type: 'table' }])

    const payload = handler.buildPayload(db, 'araba')

    expect(payload.views).toEqual([{ name: 'Mine', type: 'table' }])
  })
})
```

Adapt `handler.applyRemote` / `handler.buildPayload` to whatever the existing tests in this file already call — read the file's existing describe blocks first and mirror their setup exactly rather than inventing a harness.

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @memry/desktop test:main -- tag-definition-handler
```

Expected: FAIL — the first test loses the local views.

- [ ] **Step 3: Implement**

Add `views` to the payload type and schema for the tag definition sync item, typed as `ViewConfig[] | null | undefined`. In the apply path, branch on presence rather than truthiness:

```typescript
// `undefined` means the sending client does not know about this field —
// keep whatever is local. `null` is an explicit clear. Anything else wins.
// Collapsing these two into a falsy check silently destroys saved views
// whenever an older client syncs the tag.
if (remote.views !== undefined) {
  writeTagViews(db, remote.name, remote.views)
}
```

In the build path, attach the local value:

```typescript
views: readTagViews(db, name)
```

- [ ] **Step 4: Run the tests**

```bash
pnpm --filter @memry/desktop test:main -- tag-definition-handler
```

Expected: PASS, 4 new tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/sync/item-handlers/tag-definition-handler.ts apps/desktop/src/main/sync/item-handlers/tag-definition-handler.test.ts
git commit -m "fix(sync): preserve tag views when a payload omits the field"
```

---

### Task 4: Scope-aware row listing

**Files:**

- Modify: `apps/desktop/src/main/ipc/folder-view-handlers.ts:209-313`
- Test: `apps/desktop/src/main/ipc/folder-view-handlers.test.ts`

**Interfaces:**

- Consumes: `ViewScope` (Task 1), `listTagItems` from `../database/queries/tag-items`.
- Produces: `LIST_WITH_PROPERTIES` accepting `{ scope, properties?, limit, offset }`.

The folder branch keeps today's body verbatim, reading `scope.path` where it read `input.folderPath`. The tag branch is new.

The property enrichment is the point of this task. `adaptTagItem` in the old renderer hook wrote `properties: {}`; carrying that over would give the tag page a folder view with every property column permanently blank.

- [ ] **Step 1: Write the failing test**

Append to `apps/desktop/src/main/ipc/folder-view-handlers.test.ts`:

```typescript
describe('list-with-properties under tag scope', () => {
  it('returns notes, tasks and inbox items carrying the tag', async () => {
    const result = await invoke(FolderViewChannels.invoke.LIST_WITH_PROPERTIES, {
      scope: { kind: 'tag', tag: 'araba' },
      limit: 500,
      offset: 0
    })

    expect(result.notes.map((r) => r.kind).sort()).toEqual(['inbox', 'note', 'task'])
  })

  it('fills real properties on note rows', async () => {
    const result = await invoke(FolderViewChannels.invoke.LIST_WITH_PROPERTIES, {
      scope: { kind: 'tag', tag: 'araba' },
      limit: 500,
      offset: 0
    })

    const noteRow = result.notes.find((r) => r.kind === 'note')!
    expect(noteRow.properties).toEqual({ status: 'active' })
  })

  it('leaves properties empty on task and inbox rows', async () => {
    const result = await invoke(FolderViewChannels.invoke.LIST_WITH_PROPERTIES, {
      scope: { kind: 'tag', tag: 'araba' },
      limit: 500,
      offset: 0
    })

    for (const row of result.notes.filter((r) => r.kind !== 'note')) {
      expect(row.properties).toEqual({})
    }
  })

  it('includes descendant tags but not same-prefix siblings', async () => {
    // fixture: 'araba/lastik' matches, 'arabalar' must not
    const result = await invoke(FolderViewChannels.invoke.LIST_WITH_PROPERTIES, {
      scope: { kind: 'tag', tag: 'araba' },
      limit: 500,
      offset: 0
    })

    const titles = result.notes.map((r) => r.title)
    expect(titles).toContain('Lastik notu')
    expect(titles).not.toContain('Arabalar notu')
  })

  it('still lists a folder by path', async () => {
    const result = await invoke(FolderViewChannels.invoke.LIST_WITH_PROPERTIES, {
      scope: { kind: 'folder', path: 'projects' },
      limit: 500,
      offset: 0
    })

    expect(result.notes.length).toBeGreaterThan(0)
    expect(result.notes.every((r) => r.kind === undefined || r.kind === 'note')).toBe(true)
  })
})
```

Seed the fixture using the file's existing seeding helpers. The rows needed: one note tagged `araba` with property `status = "active"`, one task tagged `araba`, one inbox item tagged `araba`, one note titled `Lastik notu` tagged `araba/lastik`, and one note titled `Arabalar notu` tagged `arabalar`.

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @memry/desktop test:main -- folder-view-handlers
```

Expected: FAIL — the handler still reads `input.folderPath`, which is now `undefined`.

- [ ] **Step 3: Extract the property fetch so both branches share it**

Above `registerFolderViewHandlers`, add:

```typescript
/**
 * Batch-fetch every property value for the given notes.
 * Shared by both scopes — a tag view is worthless if its property columns
 * are blank, so tag rows go through exactly the same fetch folders use.
 */
async function fetchPropertiesFor(
  db: ReturnType<typeof getDataDb>,
  noteIds: string[]
): Promise<Map<string, Record<string, unknown>>> {
  const propertiesMap = new Map<string, Record<string, unknown>>()
  for (const noteId of noteIds) {
    const propsResult = await db
      .select({ name: noteProperties.name, value: noteProperties.value })
      .from(noteProperties)
      .where(eq(noteProperties.noteId, noteId))

    const props: Record<string, unknown> = {}
    propsResult.forEach((row) => {
      try {
        props[row.name] = row.value ? JSON.parse(row.value) : null
      } catch {
        props[row.name] = row.value
      }
    })
    propertiesMap.set(noteId, props)
  }
  return propertiesMap
}
```

Replace the inline loop at the old lines 273–291 with `const propertiesMap = await fetchPropertiesFor(db, noteIds)`.

- [ ] **Step 4: Add the tag branch**

Inside the `LIST_WITH_PROPERTIES` handler, immediately after the `getDataDb()` guard:

```typescript
if (input.scope.kind === 'tag') {
  const items = listTagItems(db, getDataDatabase(), input.scope.tag)
  const noteIds = items.filter((i) => i.kind === 'note').map((i) => i.id)
  const propertiesMap = await fetchPropertiesFor(db, noteIds)

  const rows: NoteWithProperties[] = items.map((item) => ({
    id: item.id,
    // Tasks and inbox items have no note path; synthesise a stable one so
    // row identity and any path-keyed UI still work.
    path:
      item.kind === 'note'
        ? (item.path ?? '')
        : item.kind === 'task'
          ? `/tasks/${item.id}`
          : `/inbox/${item.id}`,
    title: item.title,
    emoji: item.emoji,
    // `container` is the note's parent folder or the task's project name.
    folder: item.container ?? '',
    tags: item.tags,
    created: item.created,
    modified: item.modified,
    // TagItem carries no word count for any kind.
    wordCount: 0,
    properties: propertiesMap.get(item.id) ?? {},
    kind: item.kind
  }))

  const page = rows.slice(input.offset, input.offset + input.limit)
  return { notes: page, total: rows.length, hasMore: input.offset + page.length < rows.length }
}
```

Then rename the remaining folder-branch references from `input.folderPath` to `input.scope.path`. Import `listTagItems` and the data-DB accessor at the top of the file; `listTagItems` needs both connections (notes from index, tasks/inbox from data).

- [ ] **Step 5: Run the tests**

```bash
pnpm --filter @memry/desktop test:main -- folder-view-handlers
```

Expected: PASS, including the pre-existing folder-scope tests.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/ipc/folder-view-handlers.ts apps/desktop/src/main/ipc/folder-view-handlers.test.ts
git commit -m "feat(folder-view): list tag-scoped rows with real note properties"
```

---

### Task 5: Scope-aware available properties

**Files:**

- Modify: `apps/desktop/src/main/ipc/folder-view-handlers.ts:315-396`
- Test: `apps/desktop/src/main/ipc/folder-view-handlers.test.ts`

**Interfaces:**

- Produces: `GET_AVAILABLE_PROPERTIES` accepting `{ scope }`, returning a `kind` built-in **only** under tag scope.

`kind` must not join the global `BUILT_IN_COLUMNS` constant: under folder scope every row is a note, so the column and its filter would be dead weight in the column selector.

- [ ] **Step 1: Write the failing test**

```typescript
describe('get-available-properties under tag scope', () => {
  it('offers kind as a filterable built-in', async () => {
    const result = await invoke(FolderViewChannels.invoke.GET_AVAILABLE_PROPERTIES, {
      scope: { kind: 'tag', tag: 'araba' }
    })

    expect(result.builtIn.map((c) => c.id)).toContain('kind')
  })

  it('does not offer kind for a folder, where every row is a note', async () => {
    const result = await invoke(FolderViewChannels.invoke.GET_AVAILABLE_PROPERTIES, {
      scope: { kind: 'folder', path: 'projects' }
    })

    expect(result.builtIn.map((c) => c.id)).not.toContain('kind')
  })

  it("counts properties across the tag's notes, not a folder", async () => {
    const result = await invoke(FolderViewChannels.invoke.GET_AVAILABLE_PROPERTIES, {
      scope: { kind: 'tag', tag: 'araba' }
    })

    expect(result.properties).toContainEqual({ name: 'status', type: 'text', usageCount: 1 })
  })

  it('returns no formulas for a tag, which has no .folder.md', async () => {
    const result = await invoke(FolderViewChannels.invoke.GET_AVAILABLE_PROPERTIES, {
      scope: { kind: 'tag', tag: 'araba' }
    })

    expect(result.formulas).toEqual([])
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @memry/desktop test:main -- folder-view-handlers
```

Expected: FAIL — no `kind` built-in.

- [ ] **Step 3: Implement**

Inside the handler, after the existing `builtIn` construction:

```typescript
// Only a tag view mixes row kinds, so only it gets the column — and with
// it, `kind` filtering through the normal Filter By path.
const builtInForScope =
  input.scope.kind === 'tag'
    ? [...builtIn, { id: 'kind' as const, displayName: 'Kind', type: 'text' as const }]
    : builtIn
```

Return `builtInForScope` from every return path in this handler. For the tag branch, collect note ids from `listTagItems` instead of the folder `LIKE` query, run the same `propCounts` loop over them, and return `formulas: []` — formulas live in `.folder.md`, which a tag does not have.

`GetAvailablePropertiesResponse.builtIn` is typed `Array<{ id: BuiltInColumn; ... }>`. Widen it to `Array<{ id: BuiltInColumn | 'kind'; ... }>` in `folder-view-api.ts`.

- [ ] **Step 4: Run the tests**

```bash
pnpm --filter @memry/desktop test:main -- folder-view-handlers
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/ipc/folder-view-handlers.ts apps/desktop/src/main/ipc/folder-view-handlers.test.ts packages/contracts/src/folder-view-api.ts
git commit -m "feat(folder-view): scope available properties and offer kind for tags"
```

---

### Task 6: Scope-aware saved views

**Files:**

- Modify: `apps/desktop/src/main/ipc/folder-view-handlers.ts:138-207`
- Test: `apps/desktop/src/main/ipc/folder-view-handlers.test.ts`

**Interfaces:**

- Consumes: `readTagViews` / `writeTagViews` (Task 2).
- Produces: `GET_VIEWS`, `SET_VIEW`, `DELETE_VIEW` accepting `scope`.

- [ ] **Step 1: Write the failing test**

```typescript
describe('saved views under tag scope', () => {
  it('falls back to the default view when the tag has none', async () => {
    const result = await invoke(FolderViewChannels.invoke.GET_VIEWS, {
      scope: { kind: 'tag', tag: 'araba' }
    })

    expect(result.views).toEqual([DEFAULT_VIEW])
    expect(result.defaultIndex).toBe(0)
  })

  it('round-trips a saved view through the tag definition', async () => {
    await invoke(FolderViewChannels.invoke.SET_VIEW, {
      scope: { kind: 'tag', tag: 'araba' },
      view: { name: 'Open tasks', type: 'table', default: true }
    })

    const result = await invoke(FolderViewChannels.invoke.GET_VIEWS, {
      scope: { kind: 'tag', tag: 'araba' }
    })

    expect(result.views.map((v) => v.name)).toEqual(['Open tasks'])
  })

  it('deleting the last view falls back to the default again', async () => {
    await invoke(FolderViewChannels.invoke.SET_VIEW, {
      scope: { kind: 'tag', tag: 'araba' },
      view: { name: 'Open tasks', type: 'table', default: true }
    })
    await invoke(FolderViewChannels.invoke.DELETE_VIEW, {
      scope: { kind: 'tag', tag: 'araba' },
      viewName: 'Open tasks'
    })

    const result = await invoke(FolderViewChannels.invoke.GET_VIEWS, {
      scope: { kind: 'tag', tag: 'araba' }
    })

    expect(result.views).toEqual([DEFAULT_VIEW])
  })

  it('keeps folder and tag views in separate stores', async () => {
    await invoke(FolderViewChannels.invoke.SET_VIEW, {
      scope: { kind: 'tag', tag: 'araba' },
      view: { name: 'Tag view', type: 'table', default: true }
    })

    const folderResult = await invoke(FolderViewChannels.invoke.GET_VIEWS, {
      scope: { kind: 'folder', path: 'araba' }
    })

    expect(folderResult.views.map((v) => v.name)).not.toContain('Tag view')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @memry/desktop test:main -- folder-view-handlers
```

Expected: FAIL.

- [ ] **Step 3: Implement**

Introduce two helpers next to the handlers so the three view handlers stay thin and the `.folder.md` / `tag_definitions` split lives in exactly one place:

```typescript
async function readScopedViews(scope: ViewScope): Promise<ViewConfig[] | null> {
  if (scope.kind === 'tag') return readTagViews(getDataDatabase(), scope.tag)
  const folderConfig = await readFolderConfig(scope.path)
  return folderConfig?.views ?? null
}

async function writeScopedViews(scope: ViewScope, views: ViewConfig[] | null): Promise<void> {
  if (scope.kind === 'tag') {
    writeTagViews(getDataDatabase(), scope.tag, views)
    return
  }
  const currentConfig = (await readFolderConfig(scope.path)) || {}
  await writeFolderConfig(scope.path, { ...currentConfig, views: views ?? undefined })
}
```

Rewrite `GET_VIEWS`, `SET_VIEW` and `DELETE_VIEW` in terms of these, preserving today's semantics exactly: the empty/absent fallback to `[DEFAULT_VIEW]`, the single-default invariant when a view is saved with `default: true`, and promoting `filtered[0]` to default when the current default is deleted.

- [ ] **Step 4: Run the tests**

```bash
pnpm --filter @memry/desktop test:main -- folder-view-handlers
```

Expected: PASS, and every pre-existing folder view test still green.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/ipc/folder-view-handlers.ts apps/desktop/src/main/ipc/folder-view-handlers.test.ts
git commit -m "feat(folder-view): store saved views per scope"
```

---

### Task 7: Preload, service and generated IPC map

**Files:**

- Modify: `apps/desktop/src/preload/api/folder-view.ts`
- Modify: the renderer folder-view service module
- Modify: `apps/desktop/src/main/ipc/generated-ipc-invoke-map.ts` (regenerated, not hand-edited)

- [ ] **Step 1: Update the preload signatures**

Change `getViews`, `setView`, `deleteView` and `getAvailableProperties` to take `scope: ViewScope`, forwarding it as `{ scope, ... }`. `listWithProperties` already forwards an options object; only its inner field name changes.

- [ ] **Step 2: Regenerate and check**

```bash
pnpm ipc:generate && pnpm ipc:check
```

Expected: the invoke map regenerates and `ipc:check` reports no drift.

- [ ] **Step 3: Typecheck both sides**

```bash
pnpm --filter @memry/desktop typecheck:node
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/preload apps/desktop/src/main/ipc/generated-ipc-invoke-map.ts apps/desktop/src/renderer/src/services
git commit -m "feat(folder-view): thread ViewScope through preload and services"
```

---

### Task 8: `useFolderView` takes a scope

**Files:**

- Modify: `apps/desktop/src/renderer/src/hooks/use-folder-view.ts:88-260`
- Test: `apps/desktop/src/renderer/src/hooks/use-folder-view.test.tsx`

**Interfaces:**

- Produces: `useFolderView({ scope, ... })`; `folderViewKeys.*` keyed by `scopeKey(scope)`.

Cache isolation is the thing to get right. A folder named `araba` and a tag named `araba` must not share a cache entry.

- [ ] **Step 1: Write the failing test**

```typescript
it('keys caches by scope so a folder and a same-named tag never collide', () => {
  expect(folderViewKeys.notes({ kind: 'folder', path: 'araba' })).not.toEqual(
    folderViewKeys.notes({ kind: 'tag', tag: 'araba' })
  )
})

it('requests tag-scoped rows through the folder view channel', async () => {
  renderHook(() => useFolderView({ scope: { kind: 'tag', tag: 'araba' } }), { wrapper })

  await waitFor(() => {
    expect(listWithPropertiesMock).toHaveBeenCalledWith(
      expect.objectContaining({ scope: { kind: 'tag', tag: 'araba' } })
    )
  })
})

it('never calls folderExists for a tag scope', async () => {
  renderHook(() => useFolderView({ scope: { kind: 'tag', tag: 'araba' } }), { wrapper })

  await waitFor(() => expect(listWithPropertiesMock).toHaveBeenCalled())
  expect(folderExistsMock).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @memry/desktop test:renderer -- use-folder-view
```

Expected: FAIL.

- [ ] **Step 3: Implement**

Replace `folderPath: string` in `UseFolderViewOptions` with `scope: ViewScope`. Rewrite every entry of `folderViewKeys` to take a `ViewScope` and interpolate `scopeKey(scope)`. Gate the `folderExists` query on `scope.kind === 'folder'` — a tag has no directory, and asking will always answer "no", which would render the folder view's missing-folder empty state over a perfectly valid tag.

- [ ] **Step 4: Write the failing live-refresh test**

`useTagItems` subscribed to two events and refetched on both. It is being deleted, so that behaviour has to land here or the tag page silently goes stale — a note tagged from the editor would never appear until the tab is reopened.

```typescript
it('refetches when a note gains or loses this tag', async () => {
  renderHook(() => useFolderView({ scope: { kind: 'tag', tag: 'araba' } }), { wrapper })
  await waitFor(() => expect(listWithPropertiesMock).toHaveBeenCalledTimes(1))

  act(() => emitTagNotesChanged({ tag: 'araba' }))

  await waitFor(() => expect(listWithPropertiesMock).toHaveBeenCalledTimes(2))
})

it('ignores a change to a different tag', async () => {
  renderHook(() => useFolderView({ scope: { kind: 'tag', tag: 'araba' } }), { wrapper })
  await waitFor(() => expect(listWithPropertiesMock).toHaveBeenCalledTimes(1))

  act(() => emitTagNotesChanged({ tag: 'bisiklet' }))

  await new Promise((r) => setTimeout(r, 50))
  expect(listWithPropertiesMock).toHaveBeenCalledTimes(1)
})

it('refetches on the untargeted tags-changed signal', async () => {
  renderHook(() => useFolderView({ scope: { kind: 'tag', tag: 'araba' } }), { wrapper })
  await waitFor(() => expect(listWithPropertiesMock).toHaveBeenCalledTimes(1))

  act(() => emitTagsChanged())

  await waitFor(() => expect(listWithPropertiesMock).toHaveBeenCalledTimes(2))
})

it('does not subscribe to tag events under folder scope', async () => {
  renderHook(() => useFolderView({ scope: { kind: 'folder', path: 'projects' } }), { wrapper })
  await waitFor(() => expect(listWithPropertiesMock).toHaveBeenCalled())

  expect(onTagNotesChangedMock).not.toHaveBeenCalled()
})
```

- [ ] **Step 5: Implement the subscriptions**

Under tag scope only, subscribe to both events and invalidate this scope's queries:

```typescript
// Ported from the deleted `useTagItems`. `tags:notes-changed` carries the
// tag (pin/unpin, tag added or removed on a note, task/inbox tag changes);
// `notes:tags-changed` carries none — inline tag editing fires it — so it
// invalidates unconditionally.
useEffect(() => {
  if (scope.kind !== 'tag') return
  const unsubscribe = onTagNotesChanged((event) => {
    if (event.tag.toLowerCase() === scope.tag.toLowerCase()) {
      void queryClient.invalidateQueries({ queryKey: folderViewKeys.notes(scope) })
    }
  })
  return unsubscribe
}, [scope, queryClient])

useEffect(() => {
  if (scope.kind !== 'tag') return
  const unsubscribe = onTagsChanged(() => {
    void queryClient.invalidateQueries({ queryKey: folderViewKeys.notes(scope) })
  })
  return unsubscribe
}, [scope, queryClient])
```

`scope` is an object literal from the caller, so it is a new reference every render. Memoise it at the page level, or depend on `scopeKey(scope)` instead, or these effects resubscribe on every render.

- [ ] **Step 6: Run the tests**

```bash
pnpm --filter @memry/desktop test:renderer -- use-folder-view
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/src/hooks/use-folder-view.ts apps/desktop/src/renderer/src/hooks/use-folder-view.test.tsx
git commit -m "feat(folder-view): key the view hook by scope and keep tag rows live"
```

---

### Task 9: The page takes a scope and grows a tag header

**Files:**

- Modify: `apps/desktop/src/renderer/src/pages/folder-view.tsx`
- Move: `apps/desktop/src/renderer/src/pages/tag-view/tag-overflow-menu.tsx` → `apps/desktop/src/renderer/src/components/folder-view/tag-overflow-menu.tsx`
- Test: `apps/desktop/src/renderer/src/pages/folder-view.test.tsx`

**Interfaces:**

- Consumes: `useFolderView({ scope })` (Task 8).
- Produces: `FolderViewPage({ scope })`.

Under tag scope the header swaps its identity block — `TagIconChip`, a colored tag chip, an item count, and `TagOverflowMenu` at the end — while the search/sort/filter/properties/group/views cluster stays exactly where it is.

Port the rename and delete flows from `tag-view.tsx:193-273` verbatim: rename and delete both close the tab, and `onTagRenamed` / `onTagDeleted` subscriptions close it when the change arrives from another window. The tab's identity is the tag name at open time and there is no tabs-context action to repoint an existing tab's `entityId`, which is why closing is correct rather than relabelling.

- [ ] **Step 1: Write the failing tests**

```typescript
describe('tag scope', () => {
  it('renders the tag chip and item count instead of a breadcrumb', async () => {
    render(<FolderViewPage scope={{ kind: 'tag', tag: 'araba' }} />, { wrapper })
    expect(await screen.findByText('araba')).toBeInTheDocument()
  })

  it('closes the tab when the tag is renamed from another window', async () => {
    render(<FolderViewPage scope={{ kind: 'tag', tag: 'araba' }} />, { wrapper })
    await screen.findByText('araba')

    act(() => emitTagRenamed({ oldName: 'araba', newName: 'oto' }))

    await waitFor(() => expect(closeTabMock).toHaveBeenCalledWith('tab-1'))
  })

  it('closes the tab when the tag is deleted from another window', async () => {
    render(<FolderViewPage scope={{ kind: 'tag', tag: 'araba' }} />, { wrapper })
    await screen.findByText('araba')

    act(() => emitTagDeleted({ tag: 'araba' }))

    await waitFor(() => expect(closeTabMock).toHaveBeenCalledWith('tab-1'))
  })

  it('still renders a folder breadcrumb under folder scope', async () => {
    render(<FolderViewPage scope={{ kind: 'folder', path: 'projects' }} />, { wrapper })
    expect(await screen.findByText('projects')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

```bash
pnpm --filter @memry/desktop test:renderer -- folder-view
```

Expected: FAIL — the page still takes `folderPath`.

- [ ] **Step 3: Implement**

Swap the prop, thread `scope` into `useFolderView`, branch the header identity block on `scope.kind`, and mount `TagRenameDialog` / `TagDeleteDialog` plus the two lifecycle subscriptions under tag scope only. Update the tab renderer so a `type: 'tag'` tab renders `<FolderViewPage scope={{ kind: 'tag', tag }} />`.

Memoise the `scope` object here — `useMemo(() => ({ kind: 'tag', tag }), [tag])`. Task 8's event subscriptions depend on it, and an inline literal is a fresh reference every render, which would tear down and rebuild both subscriptions continuously.

The "new" button under tag scope creates a note in the default folder with the tag already applied, so the row appears in the view the user is standing in. Add a test:

```typescript
it('applies the scoped tag to a note created from the header', async () => {
  render(<FolderViewPage scope={{ kind: 'tag', tag: 'araba' }} />, { wrapper })
  await userEvent.click(await screen.findByRole('button', { name: /new/i }))

  expect(createNoteMock).toHaveBeenCalledWith(expect.objectContaining({ tags: ['araba'] }))
})
```

- [ ] **Step 4: Run the tests**

```bash
pnpm --filter @memry/desktop test:renderer -- folder-view
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/pages/folder-view.tsx apps/desktop/src/renderer/src/pages/folder-view.test.tsx apps/desktop/src/renderer/src/components/folder-view/tag-overflow-menu.tsx
git commit -m "feat(folder-view): render the tag scope header"
```

---

### Task 10: The locked tag condition

**Files:**

- Modify: `apps/desktop/src/renderer/src/components/folder-view/filter-builder.tsx`
- Test: `apps/desktop/src/renderer/src/components/folder-view/filter-builder.test.tsx`

**Interfaces:**

- Produces: `FilterBuilderProps.lockedCondition?: { label: string; color?: string }`.

The locked row is **display only**. The tag scoping is already applied server-side by `listTagItems`; injecting it into the filter expression would double-apply it and would require the client-side expression evaluator to understand tag semantics. It renders, it cannot be removed, and it never reaches `onFiltersChange`.

- [ ] **Step 1: Write the failing test**

```typescript
it('renders the locked condition with no remove control', () => {
  render(
    <FilterBuilder
      availableProperties={[]}
      builtInColumns={[]}
      onFiltersChange={vi.fn()}
      lockedCondition={{ label: 'tag = araba' }}
    />
  )

  const lockedRow = screen.getByTestId('locked-filter-row')
  expect(lockedRow).toHaveTextContent('tag = araba')
  expect(within(lockedRow).queryByRole('button', { name: /remove/i })).not.toBeInTheDocument()
})

it('never emits the locked condition as part of the filter expression', async () => {
  const onFiltersChange = vi.fn()
  render(
    <FilterBuilder
      availableProperties={[{ name: 'status', type: 'text', usageCount: 1 }]}
      builtInColumns={[]}
      onFiltersChange={onFiltersChange}
      lockedCondition={{ label: 'tag = araba' }}
    />
  )

  await addFilterRow({ property: 'status', operator: '==', value: 'active' })

  await waitFor(() => {
    expect(onFiltersChange).toHaveBeenCalledWith('status == "active"')
  })
  expect(JSON.stringify(onFiltersChange.mock.calls)).not.toContain('araba')
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @memry/desktop test:renderer -- filter-builder
```

Expected: FAIL — the prop does not exist.

- [ ] **Step 3: Implement**

Add the prop to `FilterBuilderProps` and render the locked row above the editable rows, with `data-testid="locked-filter-row"`, no remove button, and the tag's color when supplied. Leave the expression-building code untouched.

Pass `lockedCondition` from the folder view toolbar under tag scope only. Leave the filter button's badge counting the expression, which by construction excludes the locked row.

- [ ] **Step 4: Run the tests**

```bash
pnpm --filter @memry/desktop test:renderer -- filter-builder
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/folder-view/filter-builder.tsx apps/desktop/src/renderer/src/components/folder-view/filter-builder.test.tsx apps/desktop/src/renderer/src/components/folder-view/folder-view-toolbar.tsx
git commit -m "feat(folder-view): show the tag scope as a locked filter condition"
```

---

### Task 11: Row opening by kind

**Files:**

- Modify: `apps/desktop/src/renderer/src/pages/folder-view.tsx`
- Test: `apps/desktop/src/renderer/src/pages/folder-view.test.tsx`

Port `handleNoteOpen` from `tag-view.tsx:106-154`. The three branches each carry a detail that is easy to lose:

- Task rows pass no `selectedProjectId` — `TagItem` carries a container _name_, not a project id, so the Tasks page falls back to its default project scope.
- Inbox rows pass `focusInboxItemId` **and** a fresh `focusedAt` token. Inbox's focus effect keys off `focusedAt`; without a new value it will not re-fire on a second open of the same item.

- [ ] **Step 1: Write the failing tests**

```typescript
it('opens a note row as a note tab', async () => {
  render(<FolderViewPage scope={{ kind: 'tag', tag: 'araba' }} />, { wrapper })
  await userEvent.click(await screen.findByText('Araba notu'))

  expect(openSidebarItemMock).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'note', entityId: 'note-1' })
  )
})

it('opens a task row in the Tasks page', async () => {
  render(<FolderViewPage scope={{ kind: 'tag', tag: 'araba' }} />, { wrapper })
  await userEvent.click(await screen.findByText('Araba görevi'))

  expect(openSidebarItemMock).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'tasks',
      viewState: expect.objectContaining({ openTaskId: 'task-1' })
    })
  )
})

it('opens an inbox row with a fresh focus token each time', async () => {
  render(<FolderViewPage scope={{ kind: 'tag', tag: 'araba' }} />, { wrapper })
  const row = await screen.findByText('Araba gelen kutusu')

  await userEvent.click(row)
  await userEvent.click(row)

  const [first, second] = openSidebarItemMock.mock.calls.map((c) => c[0].viewState.focusedAt)
  expect(first).toBeDefined()
  expect(second).not.toBe(first)
})
```

- [ ] **Step 2: Run and watch fail**

```bash
pnpm --filter @memry/desktop test:renderer -- folder-view
```

- [ ] **Step 3: Implement** — port the handler, branching on `row.kind ?? 'note'`, and wire it as the page's `onNoteOpen` under tag scope. Folder scope keeps its existing note-only handler.

- [ ] **Step 4: Run the tests**

```bash
pnpm --filter @memry/desktop test:renderer -- folder-view
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/pages/folder-view.tsx apps/desktop/src/renderer/src/pages/folder-view.test.tsx
git commit -m "feat(folder-view): open tag rows by kind"
```

---

### Task 12: Pin to tag, and guarding note-only actions

**Files:**

- Modify: `apps/desktop/src/renderer/src/components/folder-view/bulk-action-bar.tsx`
- Test: `apps/desktop/src/renderer/src/components/folder-view/bulk-action-bar.test.tsx`

Port `handlePinSelected` from `tag-view.tsx:162-182`. Only note rows can be pinned, and only note rows can be deleted or moved — a task or inbox row in the selection must not silently take a note action.

- [ ] **Step 1: Write the failing tests**

```typescript
it('pins only the selected note rows to the tag', async () => {
  render(<BulkActionBar {...props} scope={{ kind: 'tag', tag: 'araba' }} selectedRows={[noteRow, taskRow]} />)

  await userEvent.click(screen.getByRole('button', { name: /pin/i }))

  expect(pinNoteToTagMock).toHaveBeenCalledTimes(1)
  expect(pinNoteToTagMock).toHaveBeenCalledWith({ noteId: 'note-1', tag: 'araba' })
})

it('hides the pin action under folder scope', () => {
  render(<BulkActionBar {...props} scope={{ kind: 'folder', path: 'projects' }} selectedRows={[noteRow]} />)

  expect(screen.queryByRole('button', { name: /pin/i })).not.toBeInTheDocument()
})

it('disables delete and move when a non-note row is selected', () => {
  render(<BulkActionBar {...props} scope={{ kind: 'tag', tag: 'araba' }} selectedRows={[noteRow, taskRow]} />)

  expect(screen.getByRole('button', { name: /delete/i })).toBeDisabled()
  expect(screen.getByRole('button', { name: /move/i })).toBeDisabled()
})
```

- [ ] **Step 2: Run and watch fail**

```bash
pnpm --filter @memry/desktop test:renderer -- bulk-action-bar
```

- [ ] **Step 3: Implement** — add the `scope` prop, the pin action under tag scope, and the note-only guard on delete/move. Move the `tagView.pin.*` i18n keys to whatever namespace the bulk bar uses.

- [ ] **Step 4: Run the tests**

```bash
pnpm --filter @memry/desktop test:renderer -- bulk-action-bar
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/folder-view/bulk-action-bar.tsx apps/desktop/src/renderer/src/components/folder-view/bulk-action-bar.test.tsx
git commit -m "feat(folder-view): pin selected notes to the scoped tag"
```

---

### Task 13: Kind icon on list and grid cards

**Files:**

- Modify: `apps/desktop/src/renderer/src/components/folder-view/note-card-pieces.tsx`
- Test: `apps/desktop/src/renderer/src/components/folder-view/note-card-pieces.test.tsx` (create)

Without this, a task and a note are visually identical in the list and grid views, which under tag scope is actively misleading — two of the three view types would lie about what the row is.

- [ ] **Step 1: Write the failing test**

```typescript
it('marks a task row with a task icon', () => {
  render(<NoteCardKindIcon kind="task" />)
  expect(screen.getByTestId('kind-icon-task')).toBeInTheDocument()
})

it('renders nothing for a plain note, which needs no disambiguation', () => {
  const { container } = render(<NoteCardKindIcon kind={undefined} />)
  expect(container).toBeEmptyDOMElement()
})
```

- [ ] **Step 2: Run and watch fail**

```bash
pnpm --filter @memry/desktop test:renderer -- note-card-pieces
```

- [ ] **Step 3: Implement** — export `NoteCardKindIcon`, render it in the list and grid cards, and return `null` for `undefined`/`'note'`.

- [ ] **Step 4: Run the tests**

```bash
pnpm --filter @memry/desktop test:renderer -- note-card-pieces
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/folder-view/note-card-pieces.tsx apps/desktop/src/renderer/src/components/folder-view/note-card-pieces.test.tsx apps/desktop/src/renderer/src/components/folder-view/folder-list-view.tsx apps/desktop/src/renderer/src/components/folder-view/folder-gallery-view.tsx
git commit -m "feat(folder-view): distinguish row kinds on list and grid cards"
```

---

### Task 14: Delete the old tag view

**Files:**

- Delete: `apps/desktop/src/renderer/src/pages/tag-view.tsx`, `pages/tag-view.test.tsx`, `pages/tag-view/`
- Delete: `apps/desktop/src/renderer/src/hooks/use-tag-items.ts`, `hooks/use-tag-items.test.ts`
- Modify: `packages/contracts/src/ipc-channels.ts` (drop `TAGS.LIST_ITEMS`), `apps/desktop/src/main/ipc/tags-handlers.ts:582`, the tags preload/service `listItems` member
- Modify: the i18n `notes` namespace — remove `tagView.kindFilter.*`

`listTagItems` in `apps/desktop/src/main/database/queries/tag-items.ts` **stays**. It is now the tag-scope row source inside the folder view handler.

- [ ] **Step 1: Delete the files**

```bash
git rm -r apps/desktop/src/renderer/src/pages/tag-view.tsx apps/desktop/src/renderer/src/pages/tag-view.test.tsx apps/desktop/src/renderer/src/pages/tag-view apps/desktop/src/renderer/src/hooks/use-tag-items.ts apps/desktop/src/renderer/src/hooks/use-tag-items.test.ts
```

- [ ] **Step 2: Remove the dead channel**

Drop `LIST_ITEMS` from the `TAGS` channel block, delete its handler at `tags-handlers.ts:582`, and remove `listItems` from the tags preload API and renderer service.

- [ ] **Step 3: Prove nothing references them**

```bash
rtk grep -rn "use-tag-items\|useTagItems\|TagViewPage\|list-items\|LIST_ITEMS\|tagView.kindFilter" apps packages
```

Expected: no matches.

- [ ] **Step 4: Regenerate the IPC map and check i18n**

```bash
pnpm ipc:generate && pnpm ipc:check && pnpm --filter @memry/desktop i18n:check
```

Expected: all pass. `i18n:check` gates English only; missing translations in other locales are warnings.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(tags): remove the standalone tag view"
```

---

### Task 15: Full verification

- [ ] **Step 1: Static checks**

```bash
pnpm lint && pnpm typecheck && pnpm check:architecture && pnpm check:contracts && git diff --check
```

Expected: all clean.

- [ ] **Step 2: Unit tests**

```bash
pnpm test:desktop
```

Expected: PASS.

- [ ] **Step 3: E2E**

```bash
pnpm test:e2e
```

Expected: PASS. The tag rename/color/icon specs migrated in commit `0b80cfe08` exercise this page; if they assert on the old header, update them to the new one rather than deleting the coverage.

- [ ] **Step 4: Manual check against a real vault**

```bash
pnpm dev
```

Open a tag with notes, tasks and inbox items. Confirm: rows of all three kinds appear; a property column can be added and shows values on note rows; the locked `tag = …` row cannot be removed; filtering by `kind` works; saving a view persists across a restart; renaming the tag closes the tab.

- [ ] **Step 5: Docs gate**

```bash
base_commit=$(git merge-base origin/tag-categories HEAD)
pnpm docs:impact --base "$base_commit" --strict
```

If it reports `missing-docs`, update `apps/docs/src/**` or run `pnpm docs:ai-update --base "$base_commit"`, then re-run and finish with `pnpm docs:build`.

- [ ] **Step 6: Commit any fixes**

```bash
git add -A
git commit -m "chore(folder-view): verification fixes"
```

---

## Risks

- **`listTagItems` needs both DB connections.** Notes come from index.db, tasks and inbox from data.db. `folder-view-handlers.ts` currently imports only `getIndexDatabase` (aliased `getDataDb`); Task 4 must import the data DB accessor as well.
- **Pagination changes shape under tag scope.** The folder branch paginates in SQL; the tag branch materialises all rows and slices. For realistic tag sizes this is fine, but `total` becomes exact for tags while the folder branch keeps its existing approximation. Do not "fix" the folder branch here.
- **`e2e` specs from `0b80cfe08`** target the tag page's current header. Expect to update selectors in Task 15.
