# Project all-in-one hub — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user link notes to a project and see them in a Project Home "Notes" section, syncing with zero backward-compat risk, while deleting a project keeps its notes.

**Architecture:** A new `project_links` table stores many-to-many membership (note/event/file → project). Links sync **embedded inside the existing project payload** and are reconciled wholesale on pull, exactly like `statuses` do today — so there is no new `SyncItemType` and no server change. A nullable `projects.home_note_id` column adds the "overview note." Phase 1 ships notes end-to-end; events, overview note, and files follow in later plans.

**Tech Stack:** TypeScript, better-sqlite3 + Drizzle ORM (data DB), Zod (sync payload schemas), Electron IPC (`@memry/contracts`), Vitest, React renderer.

**Spec:** `docs/superpowers/specs/2026-07-20-project-all-in-one-hub-design.md`

## Global Constraints

- Backward compatibility is MANDATORY. Additive only: one hand-written migration adds a table + a nullable column. No DB reset, no data migration of existing rows.
- Data DB migrations are hand-written (Drizzle snapshots are broken past 0021). A new `.sql` file MUST also get an entry in `apps/desktop/src/main/database/drizzle-data/meta/_journal.json`, or `migrate()` will not apply it (and tests will not see the table).
- No new `SyncItemType`. `item_type` stays `'project'`. The server stores an encrypted blob in R2 and never parses the payload — no server change, no deploy ordering.
- New sync payload fields are `.optional()`. Link reconciliation MUST be guarded by `if (data.links)` so an older client's payload (no `links` key) never wipes local links — identical to the existing `if (data.statuses)` guard.
- Tasks keep their single `projectId` FK and cascade-delete. Deleting a project drops its `project_links` rows and its tasks, but notes/events/files survive.
- New renderer code uses logical Tailwind props (`ms/me`, `ps/pe`, `start/end`, `text-start/end`, `border-s/e`, `rounded-s/e`), never physical (`ml/mr`, `pl/pr`, `left/right`).
- Logging via `createLogger('Scope')`; user-facing errors via `extractErrorMessage(err, fallback)`.
- After editing IPC contracts/handlers: run `pnpm ipc:generate` then `pnpm ipc:check`.
- Test commands run a single file via: `pnpm --filter @memry/desktop test:main -- <path-substring>`.

---

### Task 1: `project_links` table + `home_note_id` column + migration

**Files:**

- Create: `packages/db-schema/src/schema/project-links.ts`
- Modify: `packages/db-schema/src/schema/projects.ts` (add `homeNoteId`)
- Modify: `packages/db-schema/src/data-schema.ts` (export `project_links`)
- Create: `apps/desktop/src/main/database/drizzle-data/0036_project_links.sql`
- Modify: `apps/desktop/src/main/database/drizzle-data/meta/_journal.json` (register migration)
- Test: `apps/desktop/src/main/database/project-links-schema.test.ts`

**Interfaces:**

- Produces: Drizzle table `projectLinks` with columns `{ id: string, projectId: string, itemType: string, itemId: string, position: number, createdAt: string }`; new nullable `projects.homeNoteId: string | null`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/main/database/project-links-schema.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { projects } from '@memry/db-schema/schema/projects'
import { projectLinks } from '@memry/db-schema/schema/project-links'
import { eq } from 'drizzle-orm'

describe('project_links schema', () => {
  let t: TestDatabaseResult
  afterEach(() => t?.close())

  it('#then stores a link and cascades on project delete', () => {
    t = createTestDataDb()
    t.db.insert(projects).values({ id: 'p1', name: 'P1', color: '#000', position: 0 }).run()
    t.db
      .insert(projectLinks)
      .values({ id: 'l1', projectId: 'p1', itemType: 'note', itemId: 'n1', position: 0 })
      .run()

    expect(t.db.select().from(projectLinks).all()).toHaveLength(1)

    t.db.delete(projects).where(eq(projects.id, 'p1')).run()
    expect(t.db.select().from(projectLinks).all()).toHaveLength(0)
  })

  it('#then projects.home_note_id is nullable and settable', () => {
    t = createTestDataDb()
    t.db.insert(projects).values({ id: 'p2', name: 'P2', color: '#000', position: 0 }).run()
    t.db.update(projects).set({ homeNoteId: 'note-9' }).where(eq(projects.id, 'p2')).run()
    const row = t.db.select().from(projects).where(eq(projects.id, 'p2')).get()
    expect(row?.homeNoteId).toBe('note-9')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:main -- project-links-schema`
Expected: FAIL — cannot resolve `@memry/db-schema/schema/project-links` (module missing).

- [ ] **Step 3: Create the Drizzle schema**

Create `packages/db-schema/src/schema/project-links.ts` (mirrors `statuses.ts`; no clock columns — the parent project clock governs, like statuses):

```ts
import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'
import { projects } from './projects.ts'

export const projectLinks = sqliteTable(
  'project_links',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    itemType: text('item_type').notNull(),
    itemId: text('item_id').notNull(),
    position: integer('position').notNull().default(0),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (table) => [
    uniqueIndex('idx_project_links_unique').on(table.projectId, table.itemType, table.itemId),
    index('idx_project_links_project').on(table.projectId, table.itemType),
    index('idx_project_links_item').on(table.itemId, table.itemType)
  ]
)

export type ProjectLink = typeof projectLinks.$inferSelect
export type NewProjectLink = typeof projectLinks.$inferInsert
```

- [ ] **Step 4: Add the `homeNoteId` column to the projects schema**

In `packages/db-schema/src/schema/projects.ts`, add after the `archivedAt` line (currently line 19):

```ts
  homeNoteId: text('home_note_id'),
```

- [ ] **Step 5: Export the new table**

In `packages/db-schema/src/data-schema.ts`, add an export next to the existing `projects` / `statuses` exports (match the file's existing export style):

```ts
export * from './schema/project-links'
```

- [ ] **Step 6: Write the migration SQL**

Create `apps/desktop/src/main/database/drizzle-data/0036_project_links.sql`:

```sql
CREATE TABLE `project_links` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `item_type` text NOT NULL,
  `item_id` text NOT NULL,
  `position` integer DEFAULT 0 NOT NULL,
  `created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_project_links_unique` ON `project_links` (`project_id`,`item_type`,`item_id`);
--> statement-breakpoint
CREATE INDEX `idx_project_links_project` ON `project_links` (`project_id`,`item_type`);
--> statement-breakpoint
CREATE INDEX `idx_project_links_item` ON `project_links` (`item_id`,`item_type`);
--> statement-breakpoint
ALTER TABLE `projects` ADD `home_note_id` text;
```

- [ ] **Step 7: Register the migration in the journal**

In `apps/desktop/src/main/database/drizzle-data/meta/_journal.json`, append this object to the `entries` array (after the `0035_spatial_canvas` entry, idx 35):

```json
{
  "idx": 36,
  "version": "6",
  "when": 1784376000000,
  "tag": "0036_project_links",
  "breakpoints": true
}
```

Remember to add a comma after the previous (idx 35) entry's closing brace.

- [ ] **Step 8: Run the test to verify it passes**

Run: `pnpm --filter @memry/desktop test:main -- project-links-schema`
Expected: PASS (both tests).

- [ ] **Step 9: Typecheck the schema package**

Run: `pnpm --filter @memry/db-schema typecheck` (or `pnpm typecheck`)
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add packages/db-schema/src/schema/project-links.ts packages/db-schema/src/schema/projects.ts packages/db-schema/src/data-schema.ts apps/desktop/src/main/database/drizzle-data/0036_project_links.sql apps/desktop/src/main/database/drizzle-data/meta/_journal.json apps/desktop/src/main/database/project-links-schema.test.ts
git commit -m "feat(projects): project_links table + home_note_id column + migration"
```

---

### Task 2: Sync payload schema — `ProjectLinkSyncSchema`, `links`, `homeNoteId`

**Files:**

- Modify: `packages/contracts/src/sync-payloads.ts` (add schema + fields near `ProjectSyncPayloadSchema`, ~line 55-78)
- Modify: `apps/desktop/src/main/sync/field-merge.ts:29-38` (add `'homeNoteId'`)
- Test: `packages/contracts/src/sync-payloads.test.ts` (append cases)

**Interfaces:**

- Consumes: `projectLinks` row shape from Task 1.
- Produces: `ProjectLinkSync` type `{ id: string, projectId?: string, itemType: string, itemId: string, position: number, createdAt?: string }`; `ProjectSyncPayload.links?: ProjectLinkSync[]`; `ProjectSyncPayload.homeNoteId?: string | null`; `PROJECT_SYNCABLE_FIELDS` includes `'homeNoteId'`.

- [ ] **Step 1: Write the failing test**

Append to `packages/contracts/src/sync-payloads.test.ts`:

```ts
import { ProjectSyncPayloadSchema } from './sync-payloads'

describe('ProjectSyncPayloadSchema — links + homeNoteId', () => {
  it('#then parses a payload carrying links and homeNoteId', () => {
    const parsed = ProjectSyncPayloadSchema.parse({
      name: 'P',
      homeNoteId: 'note-1',
      links: [{ id: 'l1', itemType: 'note', itemId: 'n1', position: 0 }]
    })
    expect(parsed.links).toHaveLength(1)
    expect(parsed.homeNoteId).toBe('note-1')
  })

  it('#then tolerates an old payload with no links key (backward compat)', () => {
    const parsed = ProjectSyncPayloadSchema.parse({ name: 'P' })
    expect(parsed.links).toBeUndefined()
    expect(parsed.homeNoteId).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/contracts test -- sync-payloads`
Expected: FAIL — first case: `parsed.links` is `undefined` (schema strips unknown `links`).

- [ ] **Step 3: Add `ProjectLinkSyncSchema` and the two fields**

In `packages/contracts/src/sync-payloads.ts`, immediately before `ProjectSyncPayloadSchema` (line 65), add:

```ts
export const ProjectLinkSyncSchema = z.object({
  id: z.string(),
  projectId: z.string().optional(),
  itemType: z.string(),
  itemId: z.string(),
  position: z.number(),
  createdAt: z.string().optional()
})
```

Then inside `ProjectSyncPayloadSchema`'s object, add after the `statuses` line (line 77):

```ts
  statuses: z.array(StatusSyncSchema).optional(),
  homeNoteId: z.string().nullable().optional(),
  links: z.array(ProjectLinkSyncSchema).optional()
```

At the bottom of the file (next to the other exported types, ~line 340), add:

```ts
export type ProjectLinkSync = z.infer<typeof ProjectLinkSyncSchema>
```

- [ ] **Step 4: Add `homeNoteId` to the syncable fields**

In `apps/desktop/src/main/sync/field-merge.ts`, change `PROJECT_SYNCABLE_FIELDS` (lines 29-38) to include `'homeNoteId'`:

```ts
export const PROJECT_SYNCABLE_FIELDS = [
  'name',
  'description',
  'color',
  'icon',
  'position',
  'isInbox',
  'archivedAt',
  'modifiedAt',
  'homeNoteId'
] as const
```

(Do NOT add `links` here — links reconcile wholesale, they are not field-merged.)

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @memry/contracts test -- sync-payloads`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/sync-payloads.ts packages/contracts/src/sync-payloads.test.ts apps/desktop/src/main/sync/field-merge.ts
git commit -m "feat(sync): project payload carries links + homeNoteId"
```

---

### Task 3: `reconcileLinks` + project handler wiring

**Files:**

- Modify: `apps/desktop/src/main/sync/item-handlers/project-handler.ts`
- Test: `apps/desktop/src/main/sync/item-handlers/project-handler.test.ts` (append)

**Interfaces:**

- Consumes: `projectLinks` (Task 1), `ProjectLinkSync` + payload fields (Task 2), `PROJECT_SYNCABLE_FIELDS` (Task 2).
- Produces: project push payload now includes `links` and `homeNoteId`; pull applies both; `if (data.links)` guard protects old-client payloads.

- [ ] **Step 1: Write the failing tests**

Append to `apps/desktop/src/main/sync/item-handlers/project-handler.test.ts` (the file already imports `projects`, `statuses`, `projectHandler`, `makeCtx`, `TEST_PROJECT`). Add the `projectLinks` import at the top:

```ts
import { projectLinks } from '@memry/db-schema/schema/project-links'
```

Then add inside the top-level `describe('projectHandler', ...)`:

```ts
describe('links reconciliation', () => {
  it('#then inserts links from payload on upsert', () => {
    const data: ProjectSyncPayload = {
      name: 'P',
      links: [{ id: 'l1', itemType: 'note', itemId: 'n1', position: 0 }]
    }
    projectHandler.applyUpsert(ctx, 'proj-x', data, { 'device-B': 1 })
    const links = testDb.db.select().from(projectLinks).all()
    expect(links).toHaveLength(1)
    expect(links[0].itemId).toBe('n1')
  })

  it('#then reconciles links (adds new, removes missing)', () => {
    testDb.db
      .insert(projects)
      .values({ ...TEST_PROJECT, clock: { 'device-A': 1 } })
      .run()
    testDb.db
      .insert(projectLinks)
      .values({ id: 'l1', projectId: 'proj-1', itemType: 'note', itemId: 'old', position: 0 })
      .run()

    const data: ProjectSyncPayload = {
      name: 'P',
      clock: { 'device-A': 1, 'device-B': 1 },
      links: [{ id: 'l2', itemType: 'note', itemId: 'new', position: 0 }]
    }
    projectHandler.applyUpsert(ctx, 'proj-1', data, { 'device-A': 1, 'device-B': 1 })

    const links = testDb.db.select().from(projectLinks).all()
    expect(links.map((l) => l.itemId)).toEqual(['new'])
  })

  it('#then preserves local links when payload omits links (old client)', () => {
    testDb.db
      .insert(projects)
      .values({ ...TEST_PROJECT, clock: { 'device-A': 1 } })
      .run()
    testDb.db
      .insert(projectLinks)
      .values({ id: 'l1', projectId: 'proj-1', itemType: 'note', itemId: 'keep', position: 0 })
      .run()

    const data: ProjectSyncPayload = { name: 'Renamed', clock: { 'device-A': 1, 'device-B': 1 } }
    projectHandler.applyUpsert(ctx, 'proj-1', data, { 'device-A': 1, 'device-B': 1 })

    const links = testDb.db.select().from(projectLinks).all()
    expect(links.map((l) => l.itemId)).toEqual(['keep'])
  })

  it('#then round-trips homeNoteId', () => {
    const data: ProjectSyncPayload = { name: 'P', homeNoteId: 'note-7' }
    projectHandler.applyUpsert(ctx, 'proj-h', data, { 'device-B': 1 })
    const row = testDb.db.select().from(projects).all()[0]
    expect(row.homeNoteId).toBe('note-7')
  })

  it('#then buildPushPayload includes links and homeNoteId', () => {
    testDb.db
      .insert(projects)
      .values({ ...TEST_PROJECT, homeNoteId: 'note-3' })
      .run()
    testDb.db
      .insert(projectLinks)
      .values({ id: 'l1', projectId: 'proj-1', itemType: 'note', itemId: 'n1', position: 0 })
      .run()

    const payload = JSON.parse(
      projectHandler.buildPushPayload(testDb.db as never, 'proj-1', 'device-A', 'update')!
    )
    expect(payload.homeNoteId).toBe('note-3')
    expect(payload.links).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @memry/desktop test:main -- project-handler`
Expected: FAIL — links are never inserted; `payload.links` is undefined.

- [ ] **Step 3: Add `reconcileLinks` and import**

In `apps/desktop/src/main/sync/item-handlers/project-handler.ts`, add the import near the top (after the `statuses` import, line 3):

```ts
import { projectLinks } from '@memry/db-schema/schema/project-links'
```

Add `type ProjectLinkSync` to the existing `@memry/contracts/sync-payloads` import (line 5-9).

Add this function right after `reconcileStatuses` (after line 60), mirroring it:

```ts
function reconcileLinks(tx: DrizzleDb, projectId: string, incoming: ProjectLinkSync[]): void {
  const incomingIds = incoming.map((l) => l.id)

  if (incomingIds.length > 0) {
    tx.delete(projectLinks)
      .where(and(eq(projectLinks.projectId, projectId), notInArray(projectLinks.id, incomingIds)))
      .run()
  } else {
    tx.delete(projectLinks).where(eq(projectLinks.projectId, projectId)).run()
  }

  for (const l of incoming) {
    const existing = tx.select().from(projectLinks).where(eq(projectLinks.id, l.id)).get()
    if (existing) {
      tx.update(projectLinks)
        .set({ itemType: l.itemType, itemId: l.itemId, position: l.position })
        .where(eq(projectLinks.id, l.id))
        .run()
    } else {
      tx.insert(projectLinks)
        .values({
          id: l.id,
          projectId,
          itemType: l.itemType,
          itemId: l.itemId,
          position: l.position,
          createdAt: l.createdAt ?? utcNow()
        })
        .run()
    }
  }
}
```

- [ ] **Step 4: Persist `homeNoteId` in the three write paths**

In `applyUpsert`, add `homeNoteId` to each `.set(...)` / `.values(...)` block:

- merge branch (after `archivedAt`, ~line 117): `homeNoteId: (mergeResult.merged.homeNoteId as string | null) ?? null,`
- non-merge update branch (after `archivedAt`, ~line 134): `homeNoteId: data.homeNoteId ?? null,`
- insert branch (after `archivedAt`, ~line 170): `homeNoteId: data.homeNoteId ?? null,`

- [ ] **Step 5: Call `reconcileLinks` guarded, mirroring statuses**

In `applyUpsert`, directly after each existing `if (data.statuses) { reconcileStatuses(...) }` block (the update path ~line 144 and the insert path ~line 179), add:

```ts
if (data.links) {
  reconcileLinks(tx as unknown as DrizzleDb, itemId, data.links)
}
```

- [ ] **Step 6: Attach `links` to outgoing payloads**

In `fetchLocal` (line 218), `buildPushPayload` (line 227), and `seedUnclocked` (line 245), query links next to statuses and include them in the returned object / JSON:

For `fetchLocal`, after fetching `projectStatuses`:

```ts
const links = db.select().from(projectLinks).where(eq(projectLinks.projectId, itemId)).all()
return { ...project, statuses: projectStatuses, links } as Record<string, unknown>
```

For `buildPushPayload`, after `projectStatuses`:

```ts
const links = db.select().from(projectLinks).where(eq(projectLinks.projectId, itemId)).all()
return JSON.stringify({ ...project, statuses: projectStatuses, links })
```

For `seedUnclocked`, inside the loop after `projectStatuses`:

```ts
const links = db.select().from(projectLinks).where(eq(projectLinks.projectId, item.id)).all()
```

and add `links` to the enqueued `payload` JSON:

```ts
        payload: JSON.stringify({ ...item, clock, fieldClocks, statuses: projectStatuses, links }),
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm --filter @memry/desktop test:main -- project-handler`
Expected: PASS (all existing + 5 new).

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/main/sync/item-handlers/project-handler.ts apps/desktop/src/main/sync/item-handlers/project-handler.test.ts
git commit -m "feat(sync): reconcile project links + homeNoteId in project handler"
```

---

### Task 4: Domain + IPC — link / unlink / listContents / setHomeNote

**Files:**

- Modify: `packages/contracts/src/ipc-channels.ts` (add project-link invoke channels, ~line 149)
- Modify: `packages/contracts/src/tasks-api.ts` (add Zod schemas)
- Modify: `apps/desktop/src/main/tasks/domain` (add domain methods — follow existing `createProject`)
- Modify: `apps/desktop/src/main/ipc/tasks-handlers.ts` (register handlers, ~line 160-185)
- Test: `apps/desktop/src/main/ipc/tasks-handlers.test.ts` (append) OR a domain test alongside the domain file

**Interfaces:**

- Consumes: `projectLinks` (Task 1).
- Produces: domain methods `linkItemToProject({ projectId, itemType, itemId })`, `unlinkItemFromProject({ projectId, itemType, itemId })`, `listProjectLinks(projectId): ProjectLink[]`, `setProjectHomeNote({ projectId, noteId })`. IPC channels `tasks:project-link-item`, `tasks:project-unlink-item`, `tasks:project-list-links`, `tasks:project-set-home-note`.

- [ ] **Step 1: Write the failing domain test**

Create `apps/desktop/src/main/tasks/domain/project-links-domain.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { projects } from '@memry/db-schema/schema/projects'
import { projectLinks } from '@memry/db-schema/schema/project-links'
import { createTasksPublisher } from '../publisher'
import { createDesktopTasksDomain } from '.'
import { generateId } from '../../lib/id'

function domain(db: TestDatabaseResult) {
  return createDesktopTasksDomain(db.db as never, createTasksPublisher(), generateId)
}

describe('project links domain', () => {
  let t: TestDatabaseResult
  afterEach(() => t?.close())

  it('#then links then unlinks a note', () => {
    t = createTestDataDb()
    t.db.insert(projects).values({ id: 'p1', name: 'P1', color: '#000', position: 0 }).run()
    const d = domain(t)

    d.linkItemToProject({ projectId: 'p1', itemType: 'note', itemId: 'n1' })
    expect(t.db.select().from(projectLinks).all()).toHaveLength(1)

    d.unlinkItemFromProject({ projectId: 'p1', itemType: 'note', itemId: 'n1' })
    expect(t.db.select().from(projectLinks).all()).toHaveLength(0)
  })

  it('#then linking the same item twice is idempotent', () => {
    t = createTestDataDb()
    t.db.insert(projects).values({ id: 'p1', name: 'P1', color: '#000', position: 0 }).run()
    const d = domain(t)
    d.linkItemToProject({ projectId: 'p1', itemType: 'note', itemId: 'n1' })
    d.linkItemToProject({ projectId: 'p1', itemType: 'note', itemId: 'n1' })
    expect(t.db.select().from(projectLinks).all()).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:main -- project-links-domain`
Expected: FAIL — `d.linkItemToProject is not a function`.

- [ ] **Step 3: Add domain methods**

In the tasks domain (`apps/desktop/src/main/tasks/domain/index.ts` — the module that `createDesktopTasksDomain` returns; place these next to `createProject`), add methods to the returned object. They must bump the project's `modifiedAt` so the change enqueues a project push (links ride the project payload):

```ts
import { projectLinks } from '@memry/db-schema/schema/project-links'
import { and, eq } from 'drizzle-orm'
// (generateId + utcNow are already available in this module)

linkItemToProject({ projectId, itemType, itemId }: {
  projectId: string; itemType: string; itemId: string
}) {
  const existing = db
    .select()
    .from(projectLinks)
    .where(
      and(
        eq(projectLinks.projectId, projectId),
        eq(projectLinks.itemType, itemType),
        eq(projectLinks.itemId, itemId)
      )
    )
    .get()
  if (!existing) {
    db.insert(projectLinks)
      .values({ id: generateId(), projectId, itemType, itemId, position: 0 })
      .run()
  }
  touchProject(projectId)
  return { ok: true }
},

unlinkItemFromProject({ projectId, itemType, itemId }: {
  projectId: string; itemType: string; itemId: string
}) {
  db.delete(projectLinks)
    .where(
      and(
        eq(projectLinks.projectId, projectId),
        eq(projectLinks.itemType, itemType),
        eq(projectLinks.itemId, itemId)
      )
    )
    .run()
  touchProject(projectId)
  return { ok: true }
},

listProjectLinks(projectId: string) {
  return db.select().from(projectLinks).where(eq(projectLinks.projectId, projectId)).all()
},

setProjectHomeNote({ projectId, noteId }: { projectId: string; noteId: string | null }) {
  db.update(projects)
    .set({ homeNoteId: noteId, modifiedAt: utcNow() })
    .where(eq(projects.id, projectId))
    .run()
  return { ok: true }
}
```

Add a private helper `touchProject` in the same module (reuse the existing project-update path if one exists; otherwise):

```ts
function touchProject(projectId: string) {
  db.update(projects).set({ modifiedAt: utcNow() }).where(eq(projects.id, projectId)).run()
}
```

> Note for the implementer: read the existing `createProject`/`updateProject` in this file first and match how they invoke the sync queue / publisher so links actually enqueue a project push. If `updateProject` already re-enqueues on `modifiedAt` change, route `touchProject` through it instead of a bare update.

- [ ] **Step 4: Run domain test to verify it passes**

Run: `pnpm --filter @memry/desktop test:main -- project-links-domain`
Expected: PASS.

- [ ] **Step 5: Add IPC channels**

In `packages/contracts/src/ipc-channels.ts`, in `TasksChannels.invoke` (after `PROJECT_REORDER`, line 149), add:

```ts
    PROJECT_LINK_ITEM: 'tasks:project-link-item',
    PROJECT_UNLINK_ITEM: 'tasks:project-unlink-item',
    PROJECT_LIST_LINKS: 'tasks:project-list-links',
    PROJECT_SET_HOME_NOTE: 'tasks:project-set-home-note',
```

- [ ] **Step 6: Add request Zod schemas**

In `packages/contracts/src/tasks-api.ts`, add and export:

```ts
export const ProjectLinkItemSchema = z.object({
  projectId: z.string(),
  itemType: z.enum(['note', 'calendar_event', 'file']),
  itemId: z.string()
})
export const ProjectSetHomeNoteSchema = z.object({
  projectId: z.string(),
  noteId: z.string().nullable()
})
```

- [ ] **Step 7: Register IPC handlers**

In `apps/desktop/src/main/ipc/tasks-handlers.ts`, add `ProjectLinkItemSchema, ProjectSetHomeNoteSchema` to the `@memry/contracts/tasks-api` import (line 3-20), then register inside `registerTasksHandlers()` near the other project handlers (~line 160):

```ts
ipcMain.handle(
  TasksChannels.invoke.PROJECT_LINK_ITEM,
  createValidatedHandler(
    ProjectLinkItemSchema,
    withDb((db, input) => createTaskDomain(db).linkItemToProject(input), 'Failed to link item')
  )
)
ipcMain.handle(
  TasksChannels.invoke.PROJECT_UNLINK_ITEM,
  createValidatedHandler(
    ProjectLinkItemSchema,
    withDb(
      (db, input) => createTaskDomain(db).unlinkItemFromProject(input),
      'Failed to unlink item'
    )
  )
)
ipcMain.handle(
  TasksChannels.invoke.PROJECT_LIST_LINKS,
  createStringHandler(async (id) => createTaskDomain(requireDatabase()).listProjectLinks(id))
)
ipcMain.handle(
  TasksChannels.invoke.PROJECT_SET_HOME_NOTE,
  createValidatedHandler(
    ProjectSetHomeNoteSchema,
    withDb((db, input) => createTaskDomain(db).setProjectHomeNote(input), 'Failed to set home note')
  )
)
```

- [ ] **Step 8: Regenerate + validate the IPC invoke map**

Run: `pnpm ipc:generate && pnpm ipc:check`
Expected: invoke map regenerates with the 4 new channels; `ipc:check` passes.

- [ ] **Step 9: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add packages/contracts/src/ipc-channels.ts packages/contracts/src/tasks-api.ts apps/desktop/src/main/tasks/domain apps/desktop/src/main/ipc/tasks-handlers.ts apps/desktop/src/main/tasks/domain/project-links-domain.test.ts
git add -A  # picks up the regenerated ipc invoke map
git commit -m "feat(projects): link/unlink/list-links/set-home-note IPC + domain"
```

---

### Task 5: Renderer — Project Home "Notes" section + note ⋯ "Add to project"

**Files:**

- Modify: `apps/desktop/src/renderer/src/components/tasks/projects/projects-tab-content.tsx` (add a Notes section below the task list)
- Create: `apps/desktop/src/renderer/src/components/tasks/projects/project-notes-section.tsx`
- Modify: the note `⋯` menu component (the row/note picker menu from PR #778; grep `note-view menu` or the note `⋯` Picker) — add an "Add to project" action calling `PROJECT_LINK_ITEM`
- Test: `apps/desktop/src/renderer/src/components/tasks/projects/project-notes-section.test.tsx`

**Interfaces:**

- Consumes: IPC `window.api` methods generated from Task 4's channels — `tasks:project-link-item`, `tasks:project-unlink-item`, `tasks:project-list-links`. Note metadata is fetched via the existing notes IPC (`notes:get` / notes list) using the `itemId`s from `listProjectLinks`.
- Produces: a `ProjectNotesSection` component rendering the project's linked notes, with unlink; an "Add to project" menu entry on notes.

- [ ] **Step 1: Read the reuse targets first**

Before writing code, read: `projects-tab-content.tsx` (how it loads a project + renders `TaskList`), the note `⋯` menu component from PR #778 (how it dispatches IPC actions and lists projects), and one existing renderer test under `components/tasks/**` for the render/mock pattern (how `window.api` is mocked). Match those patterns exactly.

- [ ] **Step 2: Write the failing component test**

Create `project-notes-section.test.tsx`. Mock the IPC layer the same way the sibling tests do (grep an existing `*.test.tsx` in `components/tasks` for the `window.api` / IPC mock). Assert: given `listProjectLinks` returns one `note` link and the note fetch returns `{ id: 'n1', title: 'Launch brief' }`, the section renders "Launch brief"; clicking its unlink control calls the unlink IPC with `{ projectId, itemType: 'note', itemId: 'n1' }`.

```tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { ProjectNotesSection } from './project-notes-section'

// Mock IPC per the sibling-test pattern discovered in Step 1.

describe('ProjectNotesSection', () => {
  it('#then renders linked notes and unlinks on click', async () => {
    // arrange mocks: listProjectLinks -> [{ itemType:'note', itemId:'n1' }], note 'n1' -> { title:'Launch brief' }
    render(<ProjectNotesSection projectId="p1" />)
    expect(await screen.findByText('Launch brief')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Remove from project'))
    await waitFor(() =>
      expect(unlinkSpy).toHaveBeenCalledWith({ projectId: 'p1', itemType: 'note', itemId: 'n1' })
    )
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- project-notes-section`
Expected: FAIL — component does not exist.

- [ ] **Step 4: Implement `ProjectNotesSection`**

Create `project-notes-section.tsx`. On mount, call `PROJECT_LIST_LINKS(projectId)`, filter `itemType === 'note'`, fetch each note's title via the existing notes IPC, render a card grid (reuse the note-card visual from the mockup — logical Tailwind props only). Each card has a "Remove from project" button (`aria-label`) calling `PROJECT_UNLINK_ITEM`. Use `createLogger('ProjectNotes')` in the renderer logger if one exists, and `extractErrorMessage` for failures. Keep it a focused, single-responsibility component.

- [ ] **Step 5: Mount the section in Project Home**

In `projects-tab-content.tsx`, render `<ProjectNotesSection projectId={selectedProjectId} />` below the existing `TaskList`. (Full Project Home page promotion — a dedicated route and the Overview/Calendar/Files sections — is deferred to the later-phase plans; Phase 1 lands Notes inside the existing project view.)

- [ ] **Step 6: Add "Add to project" to the note ⋯ menu**

In the note `⋯` menu, add an "Add to project" submenu listing projects (from `PROJECT_LIST`); selecting one calls `PROJECT_LINK_ITEM({ projectId, itemType: 'note', itemId: noteId })`. Show a toast on success via the app's existing toast util.

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop test:renderer -- project-notes-section`
Expected: PASS.

- [ ] **Step 8: Update the delete-project dialog copy**

In `apps/desktop/src/renderer/src/components/tasks/delete-project-dialog.tsx`, update the body copy to: "Tasks in this project are deleted. Your notes, events, and files stay in your vault." (Add/adjust the i18n string; run `pnpm --filter @memry/desktop i18n:check`.)

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/renderer/src/components/tasks/projects/ apps/desktop/src/renderer/src/components/tasks/delete-project-dialog.tsx
git add -A  # note-menu + any i18n files
git commit -m "feat(projects): Project Home notes section + add-to-project + delete copy"
```

---

### Task 6: Full verification gate

- [ ] **Step 1: Run the full desktop + contracts checks**

```bash
pnpm lint
pnpm typecheck
pnpm --filter @memry/contracts test
pnpm --filter @memry/desktop test:main
pnpm --filter @memry/desktop test:renderer
pnpm ipc:check
pnpm --filter @memry/desktop i18n:check
git diff --check
```

Expected: all green.

- [ ] **Step 2: Docs impact gate**

```bash
pnpm docs:impact --base origin/main --strict
```

If `missing-docs`: run `pnpm docs:ai-update --base origin/main` or update `apps/docs/src/**`, then re-run `--strict` and `pnpm docs:build`.

- [ ] **Step 3: Manual smoke (real app)**

Run `pnpm dev`. Create a project, add a note to it via the note `⋯` menu, confirm it appears in the project's Notes section, delete the project, confirm the note still exists in the vault. Run a second profile (`pnpm --filter @memry/desktop dev:b`) signed into the same vault to confirm the link syncs.

---

## Later phases (separate plans)

- **Phase 2 — Calendar events:** `item_type = 'calendar_event'` links; event context-menu "Add to project"; Events section; `listForItem` chips. Reuses Tasks 1-4 infra (no new schema).
- **Phase 3 — Overview note:** create/set/clear the `home_note_id` note; render it inline at the top of Project Home; promote Project Home to a dedicated first-class route.
- **Phase 4 — Files + drag:** `item_type = 'file'` (after the file/attachment entity model is confirmed); sidebar drag-note-onto-project via `MEMRY_NOTE_DRAG_MIME`.

## Self-review notes

- Spec coverage: D1 (Task 1), D2 (Tasks 2-3, incl. the `if (data.links)` old-client guard test), D3 `home_note_id` (Tasks 1-4 backend; render deferred to Phase 3 per spec phasing), D4 delete-keeps-notes (Task 5 Step 8 copy + Task 1 cascade test proving links—not notes—are removed).
- Backward-compat: the "preserves local links when payload omits links" test (Task 3) is the required guard test from the spec.
- No new `SyncItemType`, no server change — honored (links embedded in project payload).
- Type consistency: `linkItemToProject` / `unlinkItemFromProject` / `listProjectLinks` / `setProjectHomeNote` names are identical across domain (Task 4), IPC handlers (Task 4), and renderer consumption (Task 5).
