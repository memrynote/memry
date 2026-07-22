# Project as an all-in-one hub — design

Date: 2026-07-20
Status: Draft (design approved in brainstorming; spec pending user review)
Owner: Kaan

## 1. Context and problem

A beta user (Reddit, "Praise and question about Projects") is ready to make MemryNote
their main driver but cannot understand Projects. Their read of the current behavior is
correct: a Project is a task-domain entity. It groups tasks and defines the set of task
statuses (board columns), and nothing else. You cannot link a note to a project, attach a
calendar event, or use a project as an overview page.

Their mental model is PARA / Obsidian: a project is an overarching container that holds
everything related to an outcome — notes, tasks, events, files. In Obsidian it was a
folder full of notes.

This mismatch matters more for MemryNote than for a pure task manager, because the whole
product promise is "one calm private place for notes + tasks + calendar." When the only
organizing primitive (Project) spans just tasks, the unification promise is unfulfilled —
which is exactly why the user "feels like I am missing something."

### Verified current state (code)

- `projects` table: `packages/db-schema/src/schema/projects.ts` — no board config on the
  row; statuses live separately.
- Only two entities reference a project: `statuses.projectId`
  (`packages/db-schema/src/schema/statuses.ts:9`, cascade) and `tasks.projectId`
  (`packages/db-schema/src/schema/tasks.ts:11`, NOT NULL, cascade).
- `note_metadata` and `calendar_events` have no `projectId`.
- Projects sync as a **record** type (`item_type = 'project'`), field-level vector clocks
  (`PROJECT_SYNCABLE_FIELDS` in `apps/desktop/src/main/sync/field-merge.ts:29`).
- **Statuses ride embedded inside the project sync payload** and are reconciled wholesale
  on pull (`reconcileStatuses`, `apps/desktop/src/main/sync/item-handlers/project-handler.ts:21`).
  `ProjectSyncPayloadSchema` carries `statuses: z.array(...).optional()`
  (`packages/contracts/src/sync-payloads.ts:77`).
- `ProjectSyncPayloadSchema` is a plain `z.object` (NOT `.strict()`), so unknown payload
  fields are **stripped, not rejected** — old clients tolerate new fields.
- Sync payloads are E2E encrypted in R2; the server stores an opaque blob and only sees
  metadata + `item_type`. Extending the project payload requires **zero server awareness**.

## 2. Goal and non-goals

### Goal

Make a Project a first-class **hub** that aggregates, on one Project Home page:

- an optional **overview note** (rich doc) as the project's description/home,
- its **tasks** (unchanged board + statuses),
- linked **notes** (many-to-many),
- linked **calendar events** (many-to-many),
- linked **files** (deferred until the file/attachment entity is confirmed).

### Non-goals

- No change to task↔project semantics. Tasks keep their single `projectId` FK and their
  cascade-on-delete behavior. They are "owned" children, not "linked" members.
- No new server-side sync item type. No changes to the sync protocol negotiation.
- No migration of existing data beyond additive schema. No DB reset.

## 3. Key design decisions

### D1 — Membership is many-to-many via a `project_links` table (not a `projectId` FK on notes/events)

The user asked to "collect all details on the Project" (all-in-one). A note about "budget"
may belong under both "Q3 Launch" and "Finance." A `projectId` FK forces single-parent; a
link table is a superset — a note can still live in exactly one project (folder-like) but
is not limited to one. It also leaves `note_metadata` and `calendar_events` schemas
untouched, minimizing blast radius on the most-synced tables.

### D2 — Links sync embedded in the project payload, reconciled like statuses (no new sync type)

This is the decisive backward-compatibility choice. Instead of a new `project-link`
`SyncItemType` (which the "journal encryption parked — new sync types break released
clients" landmine warns against), links ride inside the existing project payload exactly
as statuses do today:

- `ProjectSyncPayloadSchema` gains `links: z.array(ProjectLinkSyncSchema).optional()`.
- On pull, `reconcileLinks(tx, projectId, data.links)` mirrors `reconcileStatuses`
  (delete-missing + upsert), governed by the project's own vector clock.
- Old clients: receive the extra `links` field, Zod strips it, no crash. When an old
  client pushes a project (payload has no `links`), the `if (data.links)` guard means
  reconcile does not run, so **existing links are preserved, not wiped** — identical to the
  existing `if (data.statuses)` guard.
- Server: `item_type` stays `'project'`; the payload is an encrypted blob in R2 → no server
  change, no new type, no negotiation dependency.

Trade-off (accepted, inherited from statuses): wholesale reconcile means concurrent link
edits across devices can drop a link (last project-push wins the child set). This is the
same limitation statuses already have and is acceptable for personal, low-frequency use.
If it proves painful, Phase-later option is to promote links to a first-class sync type
with per-link clocks.

### D3 — Overview note via a nullable `projects.home_note_id`

Directly answers "I cannot link a corresponding note in its description." A project may
point at a real note that renders inline as its overview, reusing the whole editor. The
existing short `description` field stays as-is (list/subtitle text). `home_note_id` is an
additive nullable column, added to `PROJECT_SYNCABLE_FIELDS` and the payload schema.

### D4 — Deleting a project keeps its notes/events/files

The user's real fear is losing their "folder of notes." `project_links.project_id`
cascades (the links vanish), but the notes/events/files live in their own tables and
survive. Only tasks cascade-delete (unchanged, historical behavior). The delete dialog
copy must state this explicitly.

## 4. Data model

New migration `apps/desktop/src/main/database/drizzle-data/0036_project_links.sql`
(hand-written — data DB Drizzle snapshots are broken past 0021):

```sql
CREATE TABLE project_links (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  item_type  TEXT NOT NULL,          -- 'note' | 'calendar_event' | 'file'
  item_id    TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX idx_project_links_unique  ON project_links(project_id, item_type, item_id);
CREATE INDEX        idx_project_links_project ON project_links(project_id, item_type);
CREATE INDEX        idx_project_links_item    ON project_links(item_id, item_type);

ALTER TABLE projects ADD COLUMN home_note_id TEXT
  REFERENCES note_metadata(id) ON DELETE SET NULL;
```

Drizzle schema:

- New `packages/db-schema/src/schema/project-links.ts` (mirrors `statuses.ts` shape; no
  clock columns — the parent project clock governs, exactly like statuses).
- Add `homeNoteId: text('home_note_id')` (nullable) to `projects` in `projects.ts`.
- Export `project_links` from `packages/db-schema/src/data-schema.ts`.

Cleanup rules (no polymorphic FK for the item side):

- SQLite may not reliably enforce the `ON DELETE SET NULL` for a column added via
  `ALTER TABLE`. Therefore clear `home_note_id` in the note-deletion path at the app level
  too, and delete `project_links` rows for a note/event/file when that item is deleted.
- Project Home queries LEFT JOIN the target tables and skip orphaned links defensively.

## 5. Sync

All changes are in `project-handler.ts` + `field-merge.ts` + `sync-payloads.ts`. No new
handler, no registry change, no new `SyncItemType`.

- `sync-payloads.ts`: add `ProjectLinkSyncSchema` (`id, projectId?, itemType, itemId,
position, createdAt?`) and `links: z.array(ProjectLinkSyncSchema).optional()` +
  `homeNoteId: z.string().nullable().optional()` on `ProjectSyncPayloadSchema`.
- `field-merge.ts`: add `'homeNoteId'` to `PROJECT_SYNCABLE_FIELDS` (links are NOT
  field-merged; they reconcile wholesale).
- `project-handler.ts`:
  - `reconcileLinks(tx, projectId, incoming)` — delete-missing + upsert, mirroring
    `reconcileStatuses`.
  - `applyUpsert`: add `homeNoteId` to the merge branch, the non-merge branch, and the
    insert; call `reconcileLinks` inside `if (data.links)` (mirror the `if (data.statuses)`
    guard so old-client payloads without `links` never wipe local links).
  - `fetchLocal`, `buildPushPayload`, `seedUnclocked`: attach
    `links: <select from project_links where project_id = itemId>` to the payload next to
    `statuses`. (`homeNoteId` is auto-included via the existing `...project` spread once the
    column exists.)
  - Emit updated links alongside statuses in `PROJECT_UPDATED` / `PROJECT_CREATED`.

## 6. IPC / contracts

New channels (extend `TasksChannels` or add `ProjectsChannels` in
`packages/contracts`), then run `pnpm ipc:generate` && `pnpm ipc:check`:

- `projects:linkItem({ projectId, itemType, itemId })`
- `projects:unlinkItem({ projectId, itemType, itemId })`
- `projects:listContents(projectId)` → `{ homeNote, tasks, notes, events, files }`
  (aggregates: tasks by `projectId`; notes/events/files by `project_links` join).
- `projects:setHomeNote({ projectId, noteId | null })`
- `projects:createHomeNote(projectId)` → creates a note and sets it as home.
- `projects:listForItem({ itemType, itemId })` → projects a given note/event belongs to
  (for showing project chips on a note).

Errors surface via `extractErrorMessage`; handlers log via `createLogger('Projects')`.

## 7. UI

Projects graduate from a sub-tab of Tasks to a first-class **Project Home** page.

- New `apps/desktop/src/renderer/src/pages/project.tsx` (Project Home). Sidebar project
  items (`components/sidebar/sortable-project-item.tsx`) open Project Home.
- Sections, stacked (per the approved mockup): Overview (inline home note) · Tasks
  (reuse existing kanban / `task-list.tsx`, filtered by `projectId`) · Notes (grid from
  links) · Calendar (list from links) · Files (deferred).
- Overview stats row: task count, note count, event count, progress (derived from
  done-task ratio — no stored column).
- Assignment entry points (reuse existing patterns):
  - Note `⋯` menu → "Add to project" (note-view menu pattern, PR #778).
  - Sidebar drag a note onto a project (uses `MEMRY_NOTE_DRAG_MIME`).
  - Calendar event context menu → "Add to project".
  - In Project Home: "+ Note" (creates a note already linked), "+ Event", "Link existing…".
- `project-modal.tsx`: keep name/icon/color/description/status editor; add an
  "Overview note" affordance (create or pick).
- `delete-project-dialog.tsx`: update copy — "Tasks in this project are deleted. Your
  notes, events, and files stay in your vault."
- Tailwind: new UI uses logical properties (`ms/me/ps/pe/start/end`) per CLAUDE.md.
- Respect `PRODUCT.md` register (calm, private, crafted) and WCAG AA + reduced-motion.

## 8. Backward compatibility and migration

Per the production mandate (real users, real data, no resets):

- Additive only: one hand-written migration adds a table + a nullable column; existing
  rows unaffected.
- No new `SyncItemType`; `item_type` stays `'project'`.
- Old clients strip the new payload fields (`z.object`, not `.strict()`), and never wipe
  links because reconcile is guarded by `if (data.links)`.
- Server unchanged: encrypted blob in R2, D1 metadata identical. No server-before-desktop
  ordering constraint for this feature (nothing new on the wire the server must parse).
- Verify: an older-shape project payload (no `links`, no `homeNoteId`) round-trips without
  error and preserves local links/home note.

## 9. Phasing (implementation order; each phase ships end-to-end)

1. Schema (`project_links` + `home_note_id`) + migration + Drizzle schema; sync
   (`reconcileLinks`, payload fields); link/unlink IPC; Project Home **Notes** section;
   note `⋯` "Add to project". (Sync included from P1 — it is backward-safe.)
2. Calendar **Events** section + event assignment + `listForItem` chips.
3. **Overview note** (home note) section + create/set/clear.
4. **Files** section (after the file/attachment entity model is confirmed) + sidebar
   drag-to-project.

## 10. Testing

- Unit: `reconcileLinks` (delete-missing + upsert); link/unlink handlers; home-note
  set/clear; orphan-link filtering.
- Sync round-trip: push→pull preserves links + `homeNoteId`.
- **Backward-compat test (required):** apply an old-shape project payload with no `links`
  key → local `project_links` rows are preserved (guard works); a payload with unknown
  extra fields parses without throwing.
- Delete semantics: deleting a project removes links + tasks but leaves notes/events.
- E2E: assign a note via `⋯` → it appears in Project Home Notes; delete the project → the
  note still exists in the vault.
- Gates: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm ipc:check`,
  `pnpm check:architecture`, `pnpm docs:impact --base <base> --strict`.

## 11. Open questions / risks

- **Concurrent link-edit loss** (inherited from statuses' wholesale reconcile). Accept for
  now; promote links to a first-class per-link-clocked sync type only if it hurts.
- **File/attachment entity** is unconfirmed in the codebase — Files section deferred to
  Phase 4 pending that model. `item_type = 'file'` is reserved forward-compatibly.
- **Project Home as a new page vs. an expanded tab** under Tasks — spec assumes a new
  first-class page; confirm before implementation.
- **Payload size** for a project with very many links (bounded for personal use; R2 has no
  1MB row limit like D1).
- **`ON DELETE SET NULL` on an ALTER-added FK** may not fire in SQLite — mitigated by
  app-level cleanup in the note-deletion path.
