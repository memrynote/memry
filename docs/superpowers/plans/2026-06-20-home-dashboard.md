# Home Dashboard — Implementation Plan (Plan 1: Foundation)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A customizable, multi-board "Home" tab where the user adds, removes, drags, and resizes widget cards (preset S/M/L), persisted in the local data DB — shipping with two working widgets (Recently edited, Bookmarks).

**Architecture:** New `'home'` singleton tab renders `pages/home.tsx` = a board switcher + a CSS-Grid board. A board's layout **is the order of its `widgets` array** (no x/y coordinates); CSS Grid `grid-auto-flow: dense` packs them and each `size` maps to a fixed col/row span. Reorder = `@dnd-kit` sortable (already installed). Boards persist as rows in `data.db` (`home_pages` table) through an IPC chain mirrored from the existing **bookmarks** feature.

**Tech Stack:** Electron + React 19 + Vite renderer · TanStack Query · `@dnd-kit/core`+`/sortable` (installed) · Drizzle ORM + better-sqlite3 · Zod contracts · `nanoid`.

## Global Constraints

- **No new runtime dependency.** Grid uses CSS Grid + the already-installed `@dnd-kit/*`. (Spec decision 2.)
- **Prettier:** single quotes, no semicolons, 100-char width, no trailing commas.
- **Logging:** `createLogger('Scope')` from `electron-log`; never raw `console.*`.
- **User-facing errors:** `extractErrorMessage(err, fallback)` from `@/lib/ipc-error`.
- **IPC boundary:** all renderer↔main types go through `@memry/contracts`. After editing contracts/preload/handlers run `pnpm ipc:generate` then `pnpm ipc:check`.
- **RTL-safe Tailwind:** new code uses logical classes only — `ms-*`/`me-*`, `ps-*`/`pe-*`, `start-*`/`end-*`, `text-start`/`text-end`, `border-s`/`border-e`, `rounded-s-*`/`rounded-e-*`. The renderer pre-commit guard scans the **whole staged file**; never introduce `ml-*`/`mr-*`/`pl-*`/`pr-*`/`left-*`/`right-*`/`text-left`/`text-right`.
- **Native modules for Node-side tests:** run `pnpm --filter @memry/desktop rebuild:node` before vitest if you hit `better-sqlite3` `ERR_DLOPEN_FAILED`.
- **Renderer tests** run via `vitest run --config config/vitest.config.ts --project renderer <file>`; **main tests** via `--project main`.
- **Reference module to mirror for the CRUD chain:** bookmarks —
  `packages/db-schema/src/schema/bookmarks.ts`,
  `apps/desktop/src/main/database/queries/bookmarks.ts`,
  `packages/contracts/src/bookmarks-api.ts` + `ipc-channels.ts` (`BookmarksChannels`),
  `apps/desktop/src/main/ipc/bookmarks-handlers.ts`,
  `apps/desktop/src/preload/api/bookmarks.ts`,
  `apps/desktop/src/renderer/src/hooks/use-bookmarks.ts`.

## Shared types (defined in Task 4, consumed everywhere)

```ts
// apps/desktop/src/renderer/src/lib/home/types.ts
export type WidgetSize = 'S' | 'M' | 'L'

export interface WidgetInstance {
  id: string
  type: WidgetType
  size: WidgetSize
  config: Record<string, unknown>
}

export interface HomePage {
  id: string
  name: string
  icon?: string
  position: number
  widgets: WidgetInstance[]
}

// WidgetType is the union of registry keys; in Plan 1:
export type WidgetType = 'recently-edited' | 'bookmarks'
```

The contract layer (Task 2) re-declares the same `WidgetInstance`/`HomePage` shape in Zod so renderer and main agree; keep field names identical.

---

## Task 1: `home_pages` table + data-DB queries

**Files:**

- Create: `packages/db-schema/src/schema/home-pages.ts`
- Modify: `packages/db-schema/src/data-schema.ts` (add export line), `packages/db-schema/src/schema/index.ts` (add export line)
- Create: `apps/desktop/src/main/database/queries/home-pages.ts`
- Test: `apps/desktop/src/main/database/queries/home-pages.test.ts`

**Interfaces:**

- Produces: table `home_pages`; types `HomePageRow = typeof homePages.$inferSelect`, `NewHomePageRow = typeof homePages.$inferInsert`; query fns `listHomePages(db)`, `getHomePage(db,id)`, `insertHomePage(db,row)`, `updateHomePage(db,id,patch)`, `deleteHomePage(db,id)`, `reorderHomePages(db,ids)`. `widgets` is stored as a JSON **string** column; callers parse/stringify.

- [ ] **Step 1: Write the schema** (`packages/db-schema/src/schema/home-pages.ts`) — mirrors `schema/bookmarks.ts`:

```ts
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

export const homePages = sqliteTable(
  'home_pages',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    icon: text('icon'),
    position: integer('position').notNull().default(0),
    // JSON-encoded WidgetInstance[]; parsed by the caller.
    widgets: text('widgets').notNull().default('[]'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (table) => [index('idx_home_pages_position').on(table.position)]
)

export type HomePageRow = typeof homePages.$inferSelect
export type NewHomePageRow = typeof homePages.$inferInsert
```

- [ ] **Step 2: Register the schema** — add `export * from './schema/home-pages.ts'` to `packages/db-schema/src/data-schema.ts` and `export * from './home-pages.ts'` to `packages/db-schema/src/schema/index.ts` (match the existing bookmarks lines).

- [ ] **Step 3: Generate the migration**

Run: `pnpm --filter @memry/desktop db:generate`
Expected: a new migration SQL file creating `home_pages` is emitted. Do **not** hand-edit unrelated index migrations (known gotcha — `db:generate` can restage them; only commit the `home_pages` migration).

- [ ] **Step 4: Write failing query tests** (`home-pages.test.ts`) — copy the harness from `bookmarks.test.ts` (in-memory data DB). Cover: insert→list returns it; update name persists; reorder reassigns positions; delete removes.

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { createTestDataDb } from '../test-helpers' // same helper bookmarks.test.ts uses
import {
  listHomePages,
  insertHomePage,
  updateHomePage,
  deleteHomePage,
  reorderHomePages
} from './home-pages'

describe('home-pages queries', () => {
  let db: ReturnType<typeof createTestDataDb>
  beforeEach(() => {
    db = createTestDataDb()
  })

  it('inserts and lists a board ordered by position', () => {
    insertHomePage(db, { id: 'b1', name: 'Work', position: 0, widgets: '[]' })
    insertHomePage(db, { id: 'b2', name: 'Personal', position: 1, widgets: '[]' })
    const rows = listHomePages(db)
    expect(rows.map((r) => r.id)).toEqual(['b1', 'b2'])
  })

  it('updates name and widgets', () => {
    insertHomePage(db, { id: 'b1', name: 'Work', position: 0, widgets: '[]' })
    updateHomePage(db, 'b1', { name: 'Focus', widgets: '[{"id":"w1"}]' })
    expect(getHomePage(db, 'b1')?.name).toBe('Focus')
  })

  it('reorders boards by id list', () => {
    insertHomePage(db, { id: 'b1', name: 'A', position: 0, widgets: '[]' })
    insertHomePage(db, { id: 'b2', name: 'B', position: 1, widgets: '[]' })
    reorderHomePages(db, ['b2', 'b1'])
    expect(listHomePages(db).map((r) => r.id)).toEqual(['b2', 'b1'])
  })

  it('deletes a board', () => {
    insertHomePage(db, { id: 'b1', name: 'A', position: 0, widgets: '[]' })
    deleteHomePage(db, 'b1')
    expect(listHomePages(db)).toHaveLength(0)
  })
})
```

(If `createTestDataDb`/`getHomePage` names differ in `bookmarks.test.ts`, match that file's actual helper/import names.)

- [ ] **Step 5: Run tests, verify they fail**

Run: `pnpm --filter @memry/desktop rebuild:node && vitest run --config config/vitest.config.ts --project main apps/desktop/src/main/database/queries/home-pages.test.ts`
Expected: FAIL — query module not found.

- [ ] **Step 6: Implement queries** (`home-pages.ts`) — mirror `bookmarks.ts`:

```ts
import { asc, eq } from 'drizzle-orm'
import {
  homePages,
  type HomePageRow,
  type NewHomePageRow
} from '@memry/db-schema/schema/home-pages'
import type { DataDb } from '../types'

export function listHomePages(db: DataDb): HomePageRow[] {
  return db.select().from(homePages).orderBy(asc(homePages.position)).all()
}

export function getHomePage(db: DataDb, id: string): HomePageRow | undefined {
  return db.select().from(homePages).where(eq(homePages.id, id)).get()
}

export function insertHomePage(db: DataDb, row: NewHomePageRow): HomePageRow {
  return db.insert(homePages).values(row).returning().get()
}

export function updateHomePage(
  db: DataDb,
  id: string,
  patch: Partial<Pick<NewHomePageRow, 'name' | 'icon' | 'position' | 'widgets'>>
): HomePageRow | undefined {
  return db
    .update(homePages)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(eq(homePages.id, id))
    .returning()
    .get()
}

export function deleteHomePage(db: DataDb, id: string): boolean {
  return db.delete(homePages).where(eq(homePages.id, id)).run().changes > 0
}

export function reorderHomePages(db: DataDb, ids: string[]): void {
  db.transaction((tx) => {
    ids.forEach((id, position) => {
      tx.update(homePages).set({ position }).where(eq(homePages.id, id)).run()
    })
  })
}
```

- [ ] **Step 7: Run tests, verify they pass**

Run: `vitest run --config config/vitest.config.ts --project main apps/desktop/src/main/database/queries/home-pages.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 8: Commit**

```bash
git add packages/db-schema apps/desktop/src/main/database
git commit -m "feat(home): home_pages table + data-db queries"
```

---

## Task 2: Contract, IPC channels, handler, preload

**Files:**

- Create: `packages/contracts/src/home-page-api.ts`
- Modify: `packages/contracts/src/ipc-channels.ts` (add `HomePagesChannels`)
- Create: `apps/desktop/src/main/ipc/home-page-handlers.ts`
- Modify: the IPC handler registration file that wires `bookmarks-handlers` (find with `grep -rln "registerBookmarksHandlers\|bookmarks-handlers" apps/desktop/src/main/ipc`) — register `home-page` handlers the same way.
- Create: `apps/desktop/src/preload/api/home-pages.ts`
- Modify: `apps/desktop/src/preload/index.ts` (expose `homePages`), `apps/desktop/src/preload/index.d.ts` (add `homePages` to `WindowAPI`)
- Test: `apps/desktop/src/main/ipc/home-page-handlers.test.ts`

**Interfaces:**

- Consumes: query fns from Task 1.
- Produces: `window.api.homePages.{ list(): Promise<HomePage[]>; get(id): Promise<HomePage|null>; create(input): Promise<HomePage>; update(input): Promise<HomePage>; delete(id): Promise<{success:boolean}>; reorder(ids): Promise<{success:boolean}> }`. The handler **parses/stringifies** the `widgets` JSON so the renderer sees `widgets: WidgetInstance[]`.

- [ ] **Step 1: Write the contract** (`home-page-api.ts`) — mirror `bookmarks-api.ts`:

```ts
import { z } from 'zod'
import { HomePagesChannels } from './ipc-channels'
export { HomePagesChannels }

export const WidgetSizeSchema = z.enum(['S', 'M', 'L'])

export const WidgetInstanceSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  size: WidgetSizeSchema,
  config: z.record(z.string(), z.unknown()).default({})
})
export type WidgetInstance = z.infer<typeof WidgetInstanceSchema>

export const HomePageSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  icon: z.string().optional(),
  position: z.number().int().min(0),
  widgets: z.array(WidgetInstanceSchema)
})
export type HomePage = z.infer<typeof HomePageSchema>

export const HomePageCreateSchema = z.object({
  name: z.string().min(1),
  icon: z.string().optional(),
  position: z.number().int().min(0).default(0),
  widgets: z.array(WidgetInstanceSchema).default([])
})

export const HomePageUpdateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  icon: z.string().optional(),
  position: z.number().int().min(0).optional(),
  widgets: z.array(WidgetInstanceSchema).optional()
})

export const HomePageReorderSchema = z.object({
  ids: z.array(z.string().min(1))
})
```

> Note (Zod v4 gotcha): use `z.record(z.string(), z.unknown())`, never `z.record(z.unknown())` (throws in safeParse).

- [ ] **Step 2: Add channels** — in `ipc-channels.ts`, add next to `BookmarksChannels`:

```ts
export const HomePagesChannels = {
  LIST: 'home-pages:list',
  GET: 'home-pages:get',
  CREATE: 'home-pages:create',
  UPDATE: 'home-pages:update',
  DELETE: 'home-pages:delete',
  REORDER: 'home-pages:reorder'
} as const
```

Also add `'home-pages:*'` to any `HomePagesInvokeChannel`/union exports that mirror `BookmarksInvokeChannel` in this file.

- [ ] **Step 3: Write failing handler test** (`home-page-handlers.test.ts`) — mirror `bookmarks-handlers.test.ts`. Verify create→list round-trips with `widgets` parsed to an array, and update replaces widgets.

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { createTestDataDb } from '../database/test-helpers'
import { makeHomePageHandlers } from './home-page-handlers'

describe('home-page handlers', () => {
  let h: ReturnType<typeof makeHomePageHandlers>
  beforeEach(() => {
    h = makeHomePageHandlers(createTestDataDb())
  })

  it('creates and lists a board with parsed widgets', async () => {
    await h.create({ name: 'Work', position: 0, widgets: [] })
    const boards = await h.list()
    expect(boards).toHaveLength(1)
    expect(Array.isArray(boards[0].widgets)).toBe(true)
  })

  it('updates widgets array', async () => {
    const board = await h.create({ name: 'Work', position: 0, widgets: [] })
    await h.update({
      id: board.id,
      widgets: [{ id: 'w1', type: 'bookmarks', size: 'M', config: {} }]
    })
    const boards = await h.list()
    expect(boards[0].widgets[0].type).toBe('bookmarks')
  })
})
```

(Expose handler logic as a `makeHomePageHandlers(db)` factory so it is unit-testable without Electron `ipcMain`, mirroring how `bookmarks-handlers.test.ts` constructs its handlers. The `registerHomePageHandlers(ipcMain, db)` wrapper just binds these to channels.)

- [ ] **Step 4: Run test, verify it fails**

Run: `vitest run --config config/vitest.config.ts --project main apps/desktop/src/main/ipc/home-page-handlers.test.ts`
Expected: FAIL — `home-page-handlers` not found.

- [ ] **Step 5: Implement handler** (`home-page-handlers.ts`):

```ts
import { ipcMain } from 'electron'
import { nanoid } from 'nanoid'
import { HomePagesChannels } from '@memry/contracts/ipc-channels'
import {
  HomePageCreateSchema,
  HomePageUpdateSchema,
  HomePageReorderSchema,
  type HomePage,
  type WidgetInstance
} from '@memry/contracts/home-page-api'
import {
  listHomePages,
  getHomePage,
  insertHomePage,
  updateHomePage,
  deleteHomePage,
  reorderHomePages
} from '../database/queries/home-pages'
import type { DataDb } from '../database/types'
import type { HomePageRow } from '@memry/db-schema/schema/home-pages'

function rowToHomePage(row: HomePageRow): HomePage {
  return {
    id: row.id,
    name: row.name,
    icon: row.icon ?? undefined,
    position: row.position,
    widgets: JSON.parse(row.widgets) as WidgetInstance[]
  }
}

export function makeHomePageHandlers(db: DataDb) {
  return {
    list: async (): Promise<HomePage[]> => listHomePages(db).map(rowToHomePage),
    get: async (id: string): Promise<HomePage | null> => {
      const row = getHomePage(db, id)
      return row ? rowToHomePage(row) : null
    },
    create: async (input: unknown): Promise<HomePage> => {
      const data = HomePageCreateSchema.parse(input)
      const row = insertHomePage(db, {
        id: nanoid(),
        name: data.name,
        icon: data.icon ?? null,
        position: data.position,
        widgets: JSON.stringify(data.widgets)
      })
      return rowToHomePage(row)
    },
    update: async (input: unknown): Promise<HomePage> => {
      const data = HomePageUpdateSchema.parse(input)
      const row = updateHomePage(db, data.id, {
        name: data.name,
        icon: data.icon,
        position: data.position,
        widgets: data.widgets ? JSON.stringify(data.widgets) : undefined
      })
      if (!row) throw new Error(`Home page ${data.id} not found`)
      return rowToHomePage(row)
    },
    delete: async (id: string): Promise<{ success: boolean }> => ({
      success: deleteHomePage(db, id)
    }),
    reorder: async (input: unknown): Promise<{ success: boolean }> => {
      const { ids } = HomePageReorderSchema.parse(input)
      reorderHomePages(db, ids)
      return { success: true }
    }
  }
}

export function registerHomePageHandlers(db: DataDb): void {
  const h = makeHomePageHandlers(db)
  ipcMain.handle(HomePagesChannels.LIST, () => h.list())
  ipcMain.handle(HomePagesChannels.GET, (_e, id: string) => h.get(id))
  ipcMain.handle(HomePagesChannels.CREATE, (_e, input) => h.create(input))
  ipcMain.handle(HomePagesChannels.UPDATE, (_e, input) => h.update(input))
  ipcMain.handle(HomePagesChannels.DELETE, (_e, id: string) => h.delete(id))
  ipcMain.handle(HomePagesChannels.REORDER, (_e, input) => h.reorder(input))
}
```

Then call `registerHomePageHandlers(dataDb)` from the same place `registerBookmarksHandlers` is invoked (the grep target above). Add this handler module to the IPC handlers mock in `apps/desktop/src/main/ipc/index.test.ts` (known gotcha: new handler must be added to that test's mock list).

- [ ] **Step 6: Write preload** (`preload/api/home-pages.ts`) — mirror `preload/api/bookmarks.ts`:

```ts
import { ipcRenderer } from 'electron'
import { HomePagesChannels } from '@memry/contracts/ipc-channels'
import type { HomePage } from '@memry/contracts/home-page-api'

export const homePages = {
  list: (): Promise<HomePage[]> => ipcRenderer.invoke(HomePagesChannels.LIST),
  get: (id: string): Promise<HomePage | null> => ipcRenderer.invoke(HomePagesChannels.GET, id),
  create: (input: {
    name: string
    icon?: string
    position?: number
    widgets?: HomePage['widgets']
  }): Promise<HomePage> => ipcRenderer.invoke(HomePagesChannels.CREATE, input),
  update: (input: {
    id: string
    name?: string
    icon?: string
    position?: number
    widgets?: HomePage['widgets']
  }): Promise<HomePage> => ipcRenderer.invoke(HomePagesChannels.UPDATE, input),
  delete: (id: string): Promise<{ success: boolean }> =>
    ipcRenderer.invoke(HomePagesChannels.DELETE, id),
  reorder: (ids: string[]): Promise<{ success: boolean }> =>
    ipcRenderer.invoke(HomePagesChannels.REORDER, { ids })
}
```

Wire `homePages` into the exposed API in `preload/index.ts` and add it to the `WindowAPI` interface in the hand-maintained `preload/index.d.ts` (known gotcha — `window.api` types are hand-maintained there).

- [ ] **Step 7: Regenerate + validate IPC, run handler test**

Run:

```bash
pnpm ipc:generate
pnpm ipc:check
vitest run --config config/vitest.config.ts --project main apps/desktop/src/main/ipc/home-page-handlers.test.ts
```

Expected: `ipc:check` passes; handler test PASS (2 tests).

- [ ] **Step 8: Commit**

```bash
git add packages/contracts apps/desktop/src/main/ipc apps/desktop/src/preload
git commit -m "feat(home): home-page contract, IPC handlers, preload"
```

---

## Task 3: `'home'` tab type + empty Home page + default landing

**Files:**

- Modify: `apps/desktop/src/renderer/src/contexts/tabs/types.ts` (`TabType` union + `SINGLETON_TAB_TYPES`)
- Modify: `apps/desktop/src/renderer/src/contexts/tabs/helpers.ts` (`TAB_ICONS`, `TAB_PATHS`, `createDefaultTab`)
- Modify: `apps/desktop/src/renderer/src/components/split-view/tab-content.tsx` (`case 'home'`)
- Create: `apps/desktop/src/renderer/src/pages/home.tsx` (placeholder for now)
- Test: `apps/desktop/src/renderer/src/contexts/tabs/helpers.test.ts` (add cases; create if absent mirroring an existing tabs test)

**Interfaces:**

- Produces: tab type `'home'`; `createDefaultTab()` returns a `home` tab.
- Consumes: nothing yet (page is a placeholder until Task 8).

- [ ] **Step 1: Failing test** — `createDefaultTab().type === 'home'` and `SINGLETON_TAB_TYPES` includes `'home'`:

```ts
import { describe, it, expect } from 'vitest'
import { createDefaultTab } from './helpers'
import { SINGLETON_TAB_TYPES } from './types'

describe('home tab', () => {
  it('home is a singleton tab type', () => {
    expect(SINGLETON_TAB_TYPES).toContain('home')
  })
  it('default tab is home', () => {
    expect(createDefaultTab().type).toBe('home')
  })
})
```

- [ ] **Step 2: Run, verify fail**

Run: `vitest run --config config/vitest.config.ts --project renderer apps/desktop/src/renderer/src/contexts/tabs/helpers.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**
  - `types.ts`: add `| 'home'` to the `TabType` union; add `'home'` to `SINGLETON_TAB_TYPES`.
  - `helpers.ts`: `TAB_ICONS.home = 'home'`; `TAB_PATHS.home = '/home'`; change `createDefaultTab()` to build a `home` tab (title `'Home'`, type `'home'`, icon `'home'`, path `'/home'`) instead of `inbox`.
  - `tab-content.tsx`: add `const LazyHomePage = lazy(() => import('@/pages/home'))` near the other lazy imports and `case 'home': return <LazyHomePage />` in the switch.

- [ ] **Step 4: Placeholder page** (`pages/home.tsx`):

```tsx
export default function HomePage(): React.JSX.Element {
  return <div className="p-6 text-muted-foreground">Home</div>
}
```

- [ ] **Step 5: Run test, verify pass; then fix any default-tab snapshot tests**

Run: `vitest run --config config/vitest.config.ts --project renderer apps/desktop/src/renderer/src/contexts/tabs`
Expected: PASS. Other tabs tests that assert the default tab is `inbox` will now fail — update them to expect `home` (search: `grep -rln "type: 'inbox'\|'inbox'" apps/desktop/src/renderer/src/contexts/tabs` and fix the default-tab assertions only).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/contexts/tabs apps/desktop/src/renderer/src/components/split-view/tab-content.tsx apps/desktop/src/renderer/src/pages/home.tsx
git commit -m "feat(home): register home tab as default landing"
```

---

## Task 4: Widget sizes + pure layout reducer

**Files:**

- Create: `apps/desktop/src/renderer/src/lib/home/types.ts` (the Shared types block above)
- Create: `apps/desktop/src/renderer/src/lib/home/widget-sizes.ts`
- Create: `apps/desktop/src/renderer/src/lib/home/layout-reducer.ts`
- Test: `apps/desktop/src/renderer/src/lib/home/layout-reducer.test.ts`

**Interfaces:**

- Produces: `SIZE_SPANS: Record<WidgetSize,{cols:number;rows:number}>`; pure fns `addWidget(page,widget)`, `removeWidget(page,id)`, `moveWidget(page,activeId,overId)`, `resizeWidget(page,id,size)`, `configureWidget(page,id,config)` — each returns a **new** `HomePage`.
- Consumes: `HomePage`, `WidgetInstance`, `WidgetSize` from `types.ts`.

- [ ] **Step 1: Failing tests** (`layout-reducer.test.ts`):

```ts
import { describe, it, expect } from 'vitest'
import {
  addWidget,
  removeWidget,
  moveWidget,
  resizeWidget,
  configureWidget
} from './layout-reducer'
import type { HomePage, WidgetInstance } from './types'

const w = (id: string): WidgetInstance => ({ id, type: 'bookmarks', size: 'M', config: {} })
const page = (...widgets: WidgetInstance[]): HomePage => ({
  id: 'b1',
  name: 'B',
  position: 0,
  widgets
})

describe('layout-reducer', () => {
  it('addWidget appends', () => {
    expect(addWidget(page(), w('a')).widgets.map((x) => x.id)).toEqual(['a'])
  })
  it('removeWidget drops by id', () => {
    expect(removeWidget(page(w('a'), w('b')), 'a').widgets.map((x) => x.id)).toEqual(['b'])
  })
  it('moveWidget reorders active before/after over', () => {
    expect(moveWidget(page(w('a'), w('b'), w('c')), 'c', 'a').widgets.map((x) => x.id)).toEqual([
      'c',
      'a',
      'b'
    ])
  })
  it('resizeWidget changes only the target size', () => {
    const out = resizeWidget(page(w('a'), w('b')), 'a', 'L')
    expect(out.widgets.find((x) => x.id === 'a')?.size).toBe('L')
    expect(out.widgets.find((x) => x.id === 'b')?.size).toBe('M')
  })
  it('configureWidget shallow-merges config', () => {
    const out = configureWidget(page({ ...w('a'), config: { x: 1 } }), 'a', { y: 2 })
    expect(out.widgets[0].config).toEqual({ x: 1, y: 2 })
  })
  it('reducers do not mutate the input', () => {
    const p = page(w('a'))
    addWidget(p, w('b'))
    expect(p.widgets).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run, verify fail**

Run: `vitest run --config config/vitest.config.ts --project renderer apps/desktop/src/renderer/src/lib/home/layout-reducer.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** `widget-sizes.ts`:

```ts
import type { WidgetSize } from './types'

export const SIZE_SPANS: Record<WidgetSize, { cols: number; rows: number }> = {
  S: { cols: 1, rows: 1 },
  M: { cols: 2, rows: 2 },
  L: { cols: 4, rows: 2 }
}
```

and `layout-reducer.ts`:

```ts
import type { HomePage, WidgetInstance, WidgetSize } from './types'

export function addWidget(page: HomePage, widget: WidgetInstance): HomePage {
  return { ...page, widgets: [...page.widgets, widget] }
}

export function removeWidget(page: HomePage, id: string): HomePage {
  return { ...page, widgets: page.widgets.filter((w) => w.id !== id) }
}

export function moveWidget(page: HomePage, activeId: string, overId: string): HomePage {
  if (activeId === overId) return page
  const from = page.widgets.findIndex((w) => w.id === activeId)
  const to = page.widgets.findIndex((w) => w.id === overId)
  if (from === -1 || to === -1) return page
  const next = [...page.widgets]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return { ...page, widgets: next }
}

export function resizeWidget(page: HomePage, id: string, size: WidgetSize): HomePage {
  return {
    ...page,
    widgets: page.widgets.map((w) => (w.id === id ? { ...w, size } : w))
  }
}

export function configureWidget(
  page: HomePage,
  id: string,
  config: Record<string, unknown>
): HomePage {
  return {
    ...page,
    widgets: page.widgets.map((w) =>
      w.id === id ? { ...w, config: { ...w.config, ...config } } : w
    )
  }
}
```

- [ ] **Step 4: Run, verify pass**

Run: `vitest run --config config/vitest.config.ts --project renderer apps/desktop/src/renderer/src/lib/home/layout-reducer.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/lib/home
git commit -m "feat(home): widget sizes + pure layout reducer"
```

---

## Task 5: Widget registry + `createWidget` factory

**Files:**

- Create: `apps/desktop/src/renderer/src/lib/home/widget-registry.tsx`
- Test: `apps/desktop/src/renderer/src/lib/home/widget-registry.test.tsx`

**Interfaces:**

- Produces: `WidgetComponentProps`, `WidgetConfigEditorProps`, `WidgetDefinition`, `WIDGET_REGISTRY: Record<WidgetType, WidgetDefinition>`, `createWidget(type): WidgetInstance`.
- Consumes: `WidgetInstance`, `WidgetType`, `WidgetSize` from `types.ts`. Widget components are added in Task 9; in this task the registry starts **empty** and `createWidget` throws for unknown types (its real entries arrive in Task 9).

- [ ] **Step 1: Failing test** (self-contained — registers its own fake widget, no dependency on Task 9):

```tsx
import { describe, it, expect, beforeEach } from 'vitest'
import { createWidget, registerWidget, WIDGET_REGISTRY } from './widget-registry'

const fakeDef = {
  type: 'recently-edited' as const,
  titleKey: 'Fake',
  icon: 'clock',
  sizes: ['M'] as const,
  defaultSize: 'M' as const,
  defaultConfig: { seed: 1 },
  Component: () => null
}

describe('widget-registry', () => {
  beforeEach(() => {
    for (const k of Object.keys(WIDGET_REGISTRY)) delete WIDGET_REGISTRY[k]
    registerWidget(fakeDef)
  })

  it('createWidget builds an instance from a registered type', () => {
    const inst = createWidget('recently-edited')
    expect(inst.type).toBe('recently-edited')
    expect(inst.size).toBe('M')
    expect(inst.config).toEqual({ seed: 1 })
    expect(inst.id).toEqual(expect.any(String))
  })
  it('createWidget returns a fresh config object (not the registry reference)', () => {
    expect(createWidget('recently-edited').config).not.toBe(fakeDef.defaultConfig)
  })
  it('createWidget throws for an unknown type', () => {
    expect(() => createWidget('nope' as never)).toThrow()
  })
})
```

- [ ] **Step 2: Implement** `widget-registry.tsx`:

```tsx
import { nanoid } from 'nanoid'
import type { FC } from 'react'
import type { WidgetInstance, WidgetSize, WidgetType } from './types'

export interface WidgetComponentProps {
  config: Record<string, unknown>
  size: WidgetSize
}

export interface WidgetConfigEditorProps {
  config: Record<string, unknown>
  onChange: (config: Record<string, unknown>) => void
}

export interface WidgetDefinition {
  type: WidgetType
  titleKey: string
  icon: string
  sizes: WidgetSize[]
  defaultSize: WidgetSize
  defaultConfig: Record<string, unknown>
  Component: FC<WidgetComponentProps>
  ConfigEditor?: FC<WidgetConfigEditorProps>
}

// Entries are populated in Task 9 (real widgets) via registerWidget().
export const WIDGET_REGISTRY: Record<string, WidgetDefinition> = {}

export function registerWidget(def: WidgetDefinition): void {
  WIDGET_REGISTRY[def.type] = def
}

export function createWidget(type: WidgetType): WidgetInstance {
  const def = WIDGET_REGISTRY[type]
  if (!def) throw new Error(`Unknown widget type: ${type}`)
  return { id: nanoid(), type, size: def.defaultSize, config: { ...def.defaultConfig } }
}
```

- [ ] **Step 3: Run, verify pass**

Run: `vitest run --config config/vitest.config.ts --project renderer apps/desktop/src/renderer/src/lib/home/widget-registry.test.tsx`
Expected: PASS (3 tests). The test self-registers a fake widget, so it is independent of Task 9. At runtime the registry is populated by importing the widgets barrel (Task 9 adds `import '@/components/home/widgets'` to `home.tsx`).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/src/lib/home/widget-registry.tsx apps/desktop/src/renderer/src/lib/home/widget-registry.test.tsx
git commit -m "feat(home): widget registry + createWidget factory"
```

---

## Task 6: `use-home-boards` renderer hook

**Files:**

- Create: `apps/desktop/src/renderer/src/hooks/use-home-boards.ts`
- Test: `apps/desktop/src/renderer/src/hooks/use-home-boards.test.tsx`

**Interfaces:**

- Consumes: `window.api.homePages.*` (Task 2); `HomePage` from contracts.
- Produces:

  ```ts
  useHomeBoards(): {
    boards: HomePage[]
    activeBoard: HomePage | null
    activeBoardId: string | null
    setActiveBoardId: (id: string) => void
    isLoading: boolean
    createBoard: (name: string) => Promise<HomePage>
    renameBoard: (id: string, name: string) => Promise<void>
    deleteBoard: (id: string) => Promise<void>
    reorderBoards: (ids: string[]) => Promise<void>
    updateWidgets: (boardId: string, widgets: WidgetInstance[]) => Promise<void>
  }
  ```

  Active board id persisted to `localStorage` key `memry-home-active-board`; falls back to `boards[0]?.id`.

- [ ] **Step 1: Failing test** — mock `window.api.homePages`, assert list loads, `createBoard` invalidates, `updateWidgets` calls `update`. Mirror an existing hook test that mocks `window.api` (e.g. `use-bookmarks.test.tsx`). Wrap in a `QueryClientProvider`.

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useHomeBoards } from './use-home-boards'

const board = { id: 'b1', name: 'Work', position: 0, widgets: [] }

beforeEach(() => {
  ;(globalThis as any).window.api = {
    homePages: {
      list: vi.fn().mockResolvedValue([board]),
      create: vi.fn().mockResolvedValue({ ...board, id: 'b2', name: 'New' }),
      update: vi.fn().mockResolvedValue(board),
      delete: vi.fn().mockResolvedValue({ success: true }),
      reorder: vi.fn().mockResolvedValue({ success: true })
    }
  }
})

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
)

describe('useHomeBoards', () => {
  it('loads boards and defaults active to first', async () => {
    const { result } = renderHook(() => useHomeBoards(), { wrapper })
    await waitFor(() => expect(result.current.boards).toHaveLength(1))
    expect(result.current.activeBoardId).toBe('b1')
  })
  it('updateWidgets calls api.update', async () => {
    const { result } = renderHook(() => useHomeBoards(), { wrapper })
    await waitFor(() => expect(result.current.boards).toHaveLength(1))
    await act(() => result.current.updateWidgets('b1', []))
    expect(window.api.homePages.update).toHaveBeenCalledWith({ id: 'b1', widgets: [] })
  })
})
```

- [ ] **Step 2: Run, verify fail.** Run: `vitest run --config config/vitest.config.ts --project renderer apps/desktop/src/renderer/src/hooks/use-home-boards.test.tsx` → FAIL.

- [ ] **Step 3: Implement** `use-home-boards.ts`:

```ts
import { useCallback, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { HomePage, WidgetInstance } from '@memry/contracts/home-page-api'

const ACTIVE_KEY = 'memry-home-active-board'
const homeBoardsKey = ['home-boards'] as const

export function useHomeBoards() {
  const qc = useQueryClient()
  const { data: boards = [], isLoading } = useQuery({
    queryKey: homeBoardsKey,
    queryFn: () => window.api.homePages.list()
  })

  const [activeBoardId, setActiveBoardIdState] = useState<string | null>(() =>
    localStorage.getItem(ACTIVE_KEY)
  )
  const setActiveBoardId = useCallback((id: string) => {
    localStorage.setItem(ACTIVE_KEY, id)
    setActiveBoardIdState(id)
  }, [])

  const invalidate = () => qc.invalidateQueries({ queryKey: homeBoardsKey })

  const create = useMutation({
    mutationFn: (name: string) =>
      window.api.homePages.create({ name, position: boards.length, widgets: [] }),
    onSuccess: invalidate
  })
  const update = useMutation({
    mutationFn: (input: { id: string; name?: string; widgets?: WidgetInstance[] }) =>
      window.api.homePages.update(input),
    onSuccess: invalidate
  })
  const remove = useMutation({
    mutationFn: (id: string) => window.api.homePages.delete(id),
    onSuccess: invalidate
  })
  const reorder = useMutation({
    mutationFn: (ids: string[]) => window.api.homePages.reorder(ids),
    onSuccess: invalidate
  })

  const resolvedActiveId =
    activeBoardId && boards.some((b) => b.id === activeBoardId)
      ? activeBoardId
      : (boards[0]?.id ?? null)
  const activeBoard = boards.find((b) => b.id === resolvedActiveId) ?? null

  return {
    boards,
    activeBoard,
    activeBoardId: resolvedActiveId,
    setActiveBoardId,
    isLoading,
    createBoard: (name: string) => create.mutateAsync(name),
    renameBoard: (id: string, name: string) =>
      update.mutateAsync({ id, name }).then(() => undefined),
    deleteBoard: (id: string) => remove.mutateAsync(id).then(() => undefined),
    reorderBoards: (ids: string[]) => reorder.mutateAsync(ids).then(() => undefined),
    updateWidgets: (boardId: string, widgets: WidgetInstance[]) =>
      update.mutateAsync({ id: boardId, widgets }).then(() => undefined)
  } as {
    boards: HomePage[]
    activeBoard: HomePage | null
    activeBoardId: string | null
    setActiveBoardId: (id: string) => void
    isLoading: boolean
    createBoard: (name: string) => Promise<HomePage>
    renameBoard: (id: string, name: string) => Promise<void>
    deleteBoard: (id: string) => Promise<void>
    reorderBoards: (ids: string[]) => Promise<void>
    updateWidgets: (boardId: string, widgets: WidgetInstance[]) => Promise<void>
  }
}
```

- [ ] **Step 4: Run, verify pass** (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/hooks/use-home-boards.ts apps/desktop/src/renderer/src/hooks/use-home-boards.test.tsx
git commit -m "feat(home): use-home-boards renderer hook"
```

---

## Task 7: WidgetFrame + BoardGrid + add/remove/resize/reorder

**Files:**

- Create: `apps/desktop/src/renderer/src/components/home/widget-frame.tsx`
- Create: `apps/desktop/src/renderer/src/components/home/board-grid.tsx`
- Create: `apps/desktop/src/renderer/src/components/home/widget-gallery.tsx`
- Test: `apps/desktop/src/renderer/src/components/home/board-grid.test.tsx`

**Interfaces:**

- Consumes: `SIZE_SPANS`, reducer fns (Task 4), `WIDGET_REGISTRY` + `createWidget` (Task 5).
- Produces: `<BoardGrid board={HomePage} onChange={(next: HomePage) => void} editing={boolean} />`. `BoardGrid` renders each `WidgetInstance` inside `WidgetFrame` using `WIDGET_REGISTRY[w.type].Component`; reorder via `@dnd-kit` `DndContext`+`SortableContext` (`rectSortingStrategy`); size menu + remove call the reducer then `onChange`. `WidgetGallery` lists `WIDGET_REGISTRY` entries; selecting one calls `onChange(addWidget(board, createWidget(type)))`.

- [ ] **Step 1: Failing render test** — render a board with one registered widget, assert the widget title renders; click remove → `onChange` called with a board whose `widgets` is empty.

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { BoardGrid } from './board-grid'
import { registerWidget } from '@/lib/home/widget-registry'
import type { HomePage } from '@/lib/home/types'

registerWidget({
  type: 'bookmarks',
  titleKey: 'Bookmarks',
  icon: 'bookmark',
  sizes: ['M'],
  defaultSize: 'M',
  defaultConfig: {},
  Component: () => <div>BM</div>
})

const board: HomePage = {
  id: 'b1',
  name: 'B',
  position: 0,
  widgets: [{ id: 'w1', type: 'bookmarks', size: 'M', config: {} }]
}

describe('BoardGrid', () => {
  it('renders a widget and removes it', () => {
    const onChange = vi.fn()
    render(<BoardGrid board={board} onChange={onChange} editing />)
    expect(screen.getByText('BM')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Remove widget'))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ widgets: [] }))
  })
})
```

- [ ] **Step 2: Run, verify fail.** → FAIL (components missing).

- [ ] **Step 3: Implement `widget-frame.tsx`** — shared chrome:

```tsx
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { ReactNode } from 'react'
import { SIZE_SPANS } from '@/lib/home/widget-sizes'
import type { WidgetInstance, WidgetSize } from '@/lib/home/types'

interface WidgetFrameProps {
  widget: WidgetInstance
  title: string
  sizes: WidgetSize[]
  editing: boolean
  onResize: (size: WidgetSize) => void
  onRemove: () => void
  children: ReactNode
}

export function WidgetFrame({
  widget,
  title,
  sizes,
  editing,
  onResize,
  onRemove,
  children
}: WidgetFrameProps): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id: widget.id,
    disabled: !editing
  })
  const span = SIZE_SPANS[widget.size]
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        gridColumn: `span ${span.cols}`,
        gridRow: `span ${span.rows}`
      }}
      className="flex flex-col overflow-hidden rounded-xl border bg-card"
    >
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2 text-xs font-medium text-muted-foreground">
        <span className="truncate">{title}</span>
        {editing && (
          <span className="flex items-center gap-1">
            {sizes.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => onResize(s)}
                className={widget.size === s ? 'font-semibold text-foreground' : ''}
              >
                {s}
              </button>
            ))}
            <button type="button" aria-label="Remove widget" onClick={onRemove}>
              ×
            </button>
            <span {...attributes} {...listeners} aria-label="Drag widget" className="cursor-grab">
              ⠿
            </span>
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">{children}</div>
    </div>
  )
}
```

- [ ] **Step 4: Implement `board-grid.tsx`:**

```tsx
import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, rectSortingStrategy } from '@dnd-kit/sortable'
import { WidgetFrame } from './widget-frame'
import { WIDGET_REGISTRY } from '@/lib/home/widget-registry'
import { moveWidget, removeWidget, resizeWidget } from '@/lib/home/layout-reducer'
import type { HomePage, WidgetSize } from '@/lib/home/types'

interface BoardGridProps {
  board: HomePage
  onChange: (next: HomePage) => void
  editing: boolean
}

export function BoardGrid({ board, onChange, editing }: BoardGridProps): React.JSX.Element {
  const handleDragEnd = (e: DragEndEvent) => {
    if (e.over && e.active.id !== e.over.id) {
      onChange(moveWidget(board, String(e.active.id), String(e.over.id)))
    }
  }
  return (
    <DndContext collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={board.widgets.map((w) => w.id)} strategy={rectSortingStrategy}>
        <div
          className="grid auto-rows-[7rem] gap-3"
          style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gridAutoFlow: 'dense' }}
        >
          {board.widgets.map((w) => {
            const def = WIDGET_REGISTRY[w.type]
            if (!def) return null
            const { Component } = def
            return (
              <WidgetFrame
                key={w.id}
                widget={w}
                title={def.titleKey}
                sizes={def.sizes}
                editing={editing}
                onResize={(s: WidgetSize) => onChange(resizeWidget(board, w.id, s))}
                onRemove={() => onChange(removeWidget(board, w.id))}
              >
                <Component config={w.config} size={w.size} />
              </WidgetFrame>
            )
          })}
        </div>
      </SortableContext>
    </DndContext>
  )
}
```

> Responsive columns and i18n of `titleKey` are polish — do them only if trivial; `grid-template-columns` may move to a CSS class. Keep `auto-rows` height aligned with `SIZE_SPANS` rows.

- [ ] **Step 5: Implement `widget-gallery.tsx`** — a popover/menu listing `Object.values(WIDGET_REGISTRY)`; on select call `onAdd(type)`:

```tsx
import { WIDGET_REGISTRY } from '@/lib/home/widget-registry'
import type { WidgetType } from '@/lib/home/types'

interface WidgetGalleryProps {
  onAdd: (type: WidgetType) => void
}

export function WidgetGallery({ onAdd }: WidgetGalleryProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      {Object.values(WIDGET_REGISTRY).map((def) => (
        <button key={def.type} type="button" onClick={() => onAdd(def.type)} className="text-start">
          {def.titleKey}
        </button>
      ))}
    </div>
  )
}
```

- [ ] **Step 6: Run, verify pass** (BoardGrid test PASS).

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/src/components/home
git commit -m "feat(home): board grid, widget frame, widget gallery"
```

---

## Task 8: Board switcher + multi-board CRUD + first-run seed (wire `home.tsx`)

**Files:**

- Create: `apps/desktop/src/renderer/src/components/home/board-switcher.tsx`
- Modify: `apps/desktop/src/renderer/src/pages/home.tsx` (replace placeholder)
- Test: `apps/desktop/src/renderer/src/pages/home.test.tsx`

**Interfaces:**

- Consumes: `useHomeBoards` (Task 6), `BoardGrid`/`WidgetGallery` (Task 7), `addWidget`+`createWidget`.
- Produces: the full Home page. On empty boards it **seeds** one default board.

- [ ] **Step 1: Failing test** — mock `useHomeBoards` to return one board with no widgets; assert the board name renders and an "Add widget" control exists; with empty `boards`, assert `createBoard` is called once (seed).

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import HomePage from './home'

const createBoard = vi.fn().mockResolvedValue({ id: 'b1', name: 'Home', position: 0, widgets: [] })
vi.mock('@/hooks/use-home-boards', () => ({
  useHomeBoards: () => ({
    boards: [],
    activeBoard: null,
    activeBoardId: null,
    setActiveBoardId: vi.fn(),
    isLoading: false,
    createBoard,
    renameBoard: vi.fn(),
    deleteBoard: vi.fn(),
    reorderBoards: vi.fn(),
    updateWidgets: vi.fn()
  })
}))

describe('HomePage seed', () => {
  it('seeds a default board when none exist', async () => {
    render(<HomePage />)
    await waitFor(() => expect(createBoard).toHaveBeenCalledWith('Home'))
  })
})
```

- [ ] **Step 2: Run, verify fail.** → FAIL.

- [ ] **Step 3: Implement `board-switcher.tsx`** — chips per board (ordered), `+` to create:

```tsx
import type { HomePage } from '@/lib/home/types'

interface BoardSwitcherProps {
  boards: HomePage[]
  activeBoardId: string | null
  onSelect: (id: string) => void
  onCreate: () => void
}

export function BoardSwitcher({
  boards,
  activeBoardId,
  onSelect,
  onCreate
}: BoardSwitcherProps): React.JSX.Element {
  return (
    <div className="flex items-center gap-1 border-b px-3 py-2">
      {boards.map((b) => (
        <button
          key={b.id}
          type="button"
          onClick={() => onSelect(b.id)}
          className={
            b.id === activeBoardId ? 'font-semibold text-foreground' : 'text-muted-foreground'
          }
        >
          {b.name}
        </button>
      ))}
      <button type="button" aria-label="New board" onClick={onCreate} className="ms-1">
        +
      </button>
    </div>
  )
}
```

- [ ] **Step 4: Implement `home.tsx`:**

```tsx
import { useEffect, useRef } from 'react'
import { BoardSwitcher } from '@/components/home/board-switcher'
import { BoardGrid } from '@/components/home/board-grid'
import { WidgetGallery } from '@/components/home/widget-gallery'
import { useHomeBoards } from '@/hooks/use-home-boards'
import { addWidget } from '@/lib/home/layout-reducer'
import { createWidget as makeWidget } from '@/lib/home/widget-registry'
import type { HomePage, WidgetType } from '@/lib/home/types'

const DEFAULT_WIDGETS: WidgetType[] = ['recently-edited', 'bookmarks']

export default function HomePage(): React.JSX.Element {
  const {
    boards,
    activeBoard,
    activeBoardId,
    setActiveBoardId,
    isLoading,
    createBoard,
    updateWidgets
  } = useHomeBoards()

  // First-run seed: exactly once when no boards exist.
  const seeded = useRef(false)
  useEffect(() => {
    if (isLoading || boards.length > 0 || seeded.current) return
    seeded.current = true
    void (async () => {
      const board = await createBoard('Home')
      await updateWidgets(
        board.id,
        DEFAULT_WIDGETS.map((t) => makeWidget(t))
      )
      setActiveBoardId(board.id)
    })()
  }, [isLoading, boards.length, createBoard, updateWidgets, setActiveBoardId])

  const handleChange = (next: HomePage) => {
    void updateWidgets(next.id, next.widgets)
  }

  return (
    <div className="flex h-full flex-col">
      <BoardSwitcher
        boards={boards}
        activeBoardId={activeBoardId}
        onSelect={setActiveBoardId}
        onCreate={() => void createBoard('New board')}
      />
      {activeBoard && (
        <div className="min-h-0 flex-1 overflow-auto p-4">
          <div className="mb-3">
            <WidgetGallery
              onAdd={(type) => handleChange(addWidget(activeBoard, makeWidget(type)))}
            />
          </div>
          <BoardGrid board={activeBoard} onChange={handleChange} editing />
        </div>
      )}
    </div>
  )
}
```

> `makeWidget` (the registry factory) is the only widget factory; `addWidget` (reducer) just appends. Keep imports to exactly what's used (lint + renderer guard reject unused symbols).

- [ ] **Step 5: Run, verify pass.** → PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/components/home/board-switcher.tsx apps/desktop/src/renderer/src/pages/home.tsx apps/desktop/src/renderer/src/pages/home.test.tsx
git commit -m "feat(home): board switcher + first-run seed"
```

---

## Task 9: Starter widgets — Recently edited + Bookmarks

**Files:**

- Create: `apps/desktop/src/renderer/src/components/home/widgets/recently-edited-widget.tsx`
- Create: `apps/desktop/src/renderer/src/components/home/widgets/bookmarks-widget.tsx`
- Create: `apps/desktop/src/renderer/src/components/home/widgets/index.ts` (registers both via `registerWidget`)
- Modify: `apps/desktop/src/renderer/src/pages/home.tsx` (import the widgets barrel so registration runs)
- Test: `apps/desktop/src/renderer/src/components/home/widgets/recently-edited-widget.test.tsx`

**Interfaces:**

- Consumes: `useNotesList` (`@/hooks/use-notes-query`), `useBookmarks` (`@/hooks/use-bookmarks`), `WidgetComponentProps`, `registerWidget`, tab `openTab` (`useTabContext`).
- Produces: registered widget types `'recently-edited'` and `'bookmarks'`. This is what makes Task 5's registry test green.

- [ ] **Step 1: Failing test** — render `RecentlyEditedWidget` with a mocked `useNotesList` returning two notes; assert both titles render.

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { RecentlyEditedWidget } from './recently-edited-widget'

vi.mock('@/hooks/use-notes-query', () => ({
  useNotesList: () => ({
    notes: [
      { id: 'n1', title: 'Alpha' },
      { id: 'n2', title: 'Beta' }
    ],
    isLoading: false
  })
}))
vi.mock('@/contexts/tabs/context', () => ({ useTabContext: () => ({ openTab: vi.fn() }) }))

describe('RecentlyEditedWidget', () => {
  it('lists recent notes', () => {
    render(<RecentlyEditedWidget config={{}} size="M" />)
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run, verify fail.** → FAIL.

- [ ] **Step 3: Implement `recently-edited-widget.tsx`:**

```tsx
import { useNotesList } from '@/hooks/use-notes-query'
import { useTabContext } from '@/contexts/tabs/context'
import type { WidgetComponentProps } from '@/lib/home/widget-registry'

export function RecentlyEditedWidget({ size }: WidgetComponentProps): React.JSX.Element {
  const limit = size === 'L' ? 12 : size === 'M' ? 6 : 3
  const { notes, isLoading } = useNotesList({ sortBy: 'modified', sortOrder: 'desc' })
  const { openTab } = useTabContext()
  if (isLoading) return <div className="text-xs text-muted-foreground">Loading…</div>
  return (
    <ul className="flex flex-col gap-1">
      {notes.slice(0, limit).map((n) => (
        <li key={n.id}>
          <button
            type="button"
            className="w-full truncate text-start text-sm hover:underline"
            onClick={() => openTab({ type: 'note', entityId: n.id, title: n.title })}
          >
            {n.title}
          </button>
        </li>
      ))}
    </ul>
  )
}
```

> Match the real `useNotesList` return shape and `openTab` signature from `use-notes-query.ts` and `contexts/tabs/context.tsx`; adjust `entityId`/`title`/`note` fields to the actual `NoteListItem` and `openTab(tab, options?)` types. Do not invent fields.

- [ ] **Step 4: Implement `bookmarks-widget.tsx`** — same pattern over `useBookmarks`:

```tsx
import { useBookmarks } from '@/hooks/use-bookmarks'
import { useTabContext } from '@/contexts/tabs/context'
import type { WidgetComponentProps } from '@/lib/home/widget-registry'

export function BookmarksWidget({ config, size }: WidgetComponentProps): React.JSX.Element {
  const itemType = typeof config.itemType === 'string' ? config.itemType : undefined
  const limit = size === 'L' ? 12 : size === 'M' ? 6 : 3
  const { bookmarks, isLoading } = useBookmarks({ itemType })
  const { openTab } = useTabContext()
  if (isLoading) return <div className="text-xs text-muted-foreground">Loading…</div>
  return (
    <ul className="flex flex-col gap-1">
      {bookmarks.slice(0, limit).map((b) => (
        <li key={b.id}>
          <button
            type="button"
            className="w-full truncate text-start text-sm hover:underline"
            onClick={() =>
              openTab({
                type: b.itemType === 'task' ? 'tasks' : 'note',
                entityId: b.itemId,
                title: b.itemTitle ?? 'Untitled'
              })
            }
          >
            {b.itemTitle ?? 'Untitled'}
          </button>
        </li>
      ))}
    </ul>
  )
}
```

> Verify `useBookmarks` options + `BookmarkWithItem` fields against `use-bookmarks.ts`; adjust the `openTab` mapping to the real tab shape for each `itemType`.

- [ ] **Step 5: Implement `widgets/index.ts`** — register both:

```ts
import { registerWidget } from '@/lib/home/widget-registry'
import { RecentlyEditedWidget } from './recently-edited-widget'
import { BookmarksWidget } from './bookmarks-widget'

registerWidget({
  type: 'recently-edited',
  titleKey: 'Recently edited',
  icon: 'clock',
  sizes: ['S', 'M'],
  defaultSize: 'M',
  defaultConfig: {},
  Component: RecentlyEditedWidget
})

registerWidget({
  type: 'bookmarks',
  titleKey: 'Bookmarks',
  icon: 'bookmark',
  sizes: ['S', 'M'],
  defaultSize: 'M',
  defaultConfig: {},
  Component: BookmarksWidget
})
```

Add `import '@/components/home/widgets'` at the top of `pages/home.tsx` so registration runs when Home mounts.

- [ ] **Step 6: Run widget + registry tests, verify pass**

Run: `vitest run --config config/vitest.config.ts --project renderer apps/desktop/src/renderer/src/components/home apps/desktop/src/renderer/src/lib/home/widget-registry.test.tsx`
Expected: PASS (Task 5's registry test is now green too).

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/src/components/home/widgets apps/desktop/src/renderer/src/pages/home.tsx
git commit -m "feat(home): recently-edited + bookmarks widgets"
```

---

## Final verification (run before declaring Plan 1 done)

- [ ] `pnpm --filter @memry/desktop typecheck:web` → 0 errors
- [ ] `pnpm --filter @memry/desktop typecheck:node` → 0 errors
- [ ] `pnpm ipc:check` → passes
- [ ] `vitest run --config config/vitest.config.ts --project renderer apps/desktop/src/renderer/src/lib/home apps/desktop/src/renderer/src/components/home apps/desktop/src/renderer/src/hooks/use-home-boards.test.tsx apps/desktop/src/renderer/src/contexts/tabs` → all green
- [ ] `vitest run --config config/vitest.config.ts --project main apps/desktop/src/main/database/queries/home-pages.test.ts apps/desktop/src/main/ipc/home-page-handlers.test.ts` → all green
- [ ] `pnpm lint` → no new errors (RTL-logical-class guard clean on every new file)
- [ ] `git diff --check`
- [ ] **Manual GUI QA:** launch `pnpm dev`, confirm app lands on Home, default board seeds with Recently-edited + Bookmarks, add/remove/resize/drag widgets persist across reload, create a second board and switch between them.
- [ ] Docs: run `pnpm docs:ai-update --base <base_commit>` (or update `apps/docs/src`), then `pnpm docs:impact --base <base_commit> --strict` and `pnpm docs:build`.

---

## Roadmap — follow-up plans (write each when its predecessor lands)

- **Plan 2 — More widgets:** Quick actions (capture / new note / today's journal / quick-access), Today (calendar events + timed reminders on an hour rail via `useCalendarRange` + `useReminders`), Most-used tags (confirm a tags-with-count source first; demote if none). Each is a `registerWidget` + a card; no new plumbing.
- **Plan 3 — Cross-device sync (spec decision 5/7):** promote `home-page` to a synced item — add `'home-page'` to `SYNC_ITEM_TYPES`, `ENCRYPTABLE_ITEM_TYPES`, `RECORD_SYNC_ITEM_TYPES`, `RECORD_CLOCK_REQUIRED_ITEM_TYPES` in `packages/contracts/src/sync-api.ts`; add a handler in `apps/desktop/src/main/sync/item-handlers/home-page-handler.ts` via the `getHandler(type)` registry; whole-document last-writer-wins. Follow the repo's `adding-sync-item-type` skill/checklist end-to-end. Resolve every newly-exhaustive `switch`/array the union change surfaces.
- **Plan 4 — Embed widgets:** make `pages/folder-view.tsx` (already takes `folderPath`), the tasks view, and the inbox list embeddable (accept config props, shed page chrome), then add Folder/Tasks/Inbox widgets with `ConfigEditor`s. Biggest unknown; scope one widget per task, with a read-only-summary fallback if a component resists clean embedding.
