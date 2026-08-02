# Tag view as a scoped folder view

- **Date:** 2026-08-01
- **Branch:** `tag-view-folder-view-scope`
- **Base:** `origin/tag-categories` (`013a9afb3`) — the tag hub and tag detail page do not exist on `main` yet
- **Status:** design approved, pending implementation plan

## Problem

Clicking a tag opens `pages/tag-view.tsx`, a second table implementation that lists the notes, tasks and inbox items carrying that tag. It duplicates what the folder view already does — columns, sorting, grouping, filtering, saved views — but at a fraction of the capability, and it drifts from the folder view every time either side changes.

We do not want two table engines. A tag is a selection over the same items a folder view already renders; it should be the same page with a different scope.

## Goal

Clicking a tag opens the folder view, scoped to that tag through the existing Filter By system: a locked `tag = <tag>` condition the user cannot remove, on top of which they build any further filter they like.

### Non-goals

- Redesigning the folder view itself.
- Changing what a tag _matches_ (exact tag or `/` descendants — already settled in `listTagItems`).
- Calendar events. They carry no tags today; see Phase 2.

## Approach

One engine, two entry points. `ViewScope` becomes the parameter that the folder view is built around, replacing the `folderPath` string threaded through the IPC layer, the hooks and the page.

```ts
// packages/contracts/src/folder-view-api.ts
type ViewScope = { kind: 'folder'; path: string } | { kind: 'tag'; tag: string }
```

Rejected alternatives:

- **Keep both pages, share components.** Leaves two data paths and two config stores; every folder view feature has to be ported twice. This is the status quo with extra indirection.
- **Make tags virtual folders.** Would let the folder view stay untouched, but tags are many-to-many and hierarchical in a different way than directories; forcing them into a path model corrupts the folder abstraction.

## Architecture

### IPC

Four channels take `scope` where they took `folderPath`:

| Channel                                 | Folder scope             | Tag scope                                             |
| --------------------------------------- | ------------------------ | ----------------------------------------------------- |
| `folder-view:list-with-properties`      | today's path             | `listTagItems()` rows + the same property batch-fetch |
| `folder-view:get-available-properties`  | today's path             | property counts over the tag's notes                  |
| `folder-view:get-views`                 | `.folder.md` frontmatter | `tag_definitions.views`                               |
| `folder-view:save-view` / `delete-view` | `writeFolderConfig`      | `tag_definitions.views`                               |

The IPC shape may change freely: renderer and main ship in the same build, so the backward-compatibility obligation lives in _data_ (vault files, DB rows, sync payloads), not in the channel signature. `pnpm ipc:generate && pnpm ipc:check` after the contract edit.

The property batch-fetch under tag scope is the load-bearing detail. `adaptTagItem` (`hooks/use-tag-items.ts:37`) currently writes `properties: {}`. Carrying that over would make the tag page look like a folder view while silently losing its point — property columns, property filters, group-by-property and formulas would all be empty. Note rows must get real properties from the same code path `list-with-properties` already uses. Task and inbox rows have no properties; their cells render empty. The `folder` column shows a task's project name, which is what `container` already resolves to.

### Renderer

- `useFolderView({ scope })`; `folderViewKeys` keyed by `scopeKey(scope)` so folder and tag caches cannot overwrite each other.
- `FolderViewPage` takes `scope` instead of `folderPath`. The `type: 'tag'` tab renders it with `{ kind: 'tag', tag }`.

### Deleted

`pages/tag-view.tsx`, `pages/tag-view.test.tsx`, `pages/tag-view/`, `hooks/use-tag-items.ts` + test, and the `tags:list-items` IPC channel (`TAGS.LIST_ITEMS` in `packages/contracts/src/ipc-channels.ts`) — the tag view was its only consumer. The `listTagItems` DB query survives; it becomes the tag-scope source inside the folder-view handler. `pages/tag-view/tag-overflow-menu.tsx` moves into the folder view header.

## Persistence and migration

Folder views are **not** in the database. They live in each folder's `.folder.md` file, read and written by `readFolderConfig` / `writeFolderConfig` in `apps/desktop/src/main/vault/folders.ts`; the `folder_configs` table carries only `icon` and the sync clock.

A tag has no directory, so that mechanism does not transfer. Tags are already database-and-sync entities: a `tag_definitions` row plus a `tag_definition` sync type. Tag views ride there.

- Add `views TEXT` (JSON, nullable) to `tag_definitions`.
- Hand-written migration `drizzle-data/0041_tag_definition_views.sql` — `ALTER TABLE tag_definitions ADD COLUMN views TEXT`. Data-DB migrations are hand-written per CLAUDE.md; Drizzle snapshots are broken past 0021.
- No backfill. `null` means "no saved views", which resolves to the same `DEFAULT_VIEW` fallback the folder handler already applies when `.folder.md` has none. Zero existing rows are touched.

### The sync hazard

If an older client pushes a `tag_definition` it does not know has a `views` field, a naive merge on pull drops the column. This exact class of bug already bit `project_links`. `tag-definition-handler.ts` must distinguish:

- `views === undefined` — field absent from the payload, keep the local value.
- `views === null` — an explicit clear, apply it.

This gets a regression test, not just care.

## UI

**Header, tag scope.** `FolderEmojiChip` → `TagIconChip`; breadcrumb → a colored tag chip, segmented for hierarchical tags (`araba / lastik`); count reads as items rather than notes. The right-hand cluster is unchanged: search · sort · filter · properties · group | saved views | new. `TagOverflowMenu` (rename, color, icon, delete) sits at the end.

**Locked filter.** `FilterBuilder` gains a `lockedCondition` prop. Tag scope renders an undeletable top row, `tag = <tag> (+ descendants)`, and the user builds normal filter rows beneath it. Two details:

- The locked condition is not written into saved views. Scope is the tab's identity, so view configs stay portable.
- The filter button's badge does not count it, or the page permanently claims one active filter.

**Kind collapses into Filter By.** The current all/note/task/inbox `Picker` goes away. `kind` becomes a built-in column, visible by default under tag scope, filterable like any other. A user can then save "open tasks in this tag" as a view.

**List and grid.** Their cards do not know about `kind`, so a task and a note look identical under tag scope. `note-card-pieces.tsx` needs a kind icon, otherwise two of the three view types are actively misleading on this page.

## Behavior that must survive

1. **Row opening by kind** — note opens a note tab; task opens Tasks with `viewState.openTaskId`; inbox opens Inbox with `focusInboxItemId` and a _fresh_ `focusedAt`, which is what re-fires the focus effect.
2. **Pin to tag** moves to `BulkActionBar`, shown under tag scope. `TagItem` carries no pinned flag, so there is still no row indicator or unpin — unchanged from today, and out of scope here.
3. **Rename and delete close the tab**, including when the event arrives from another window.
4. **Live refresh** — `tags:notes-changed` and `notes:tags-changed` invalidate the tag-scope queries.
5. **Delete/move dialogs and the bulk bar** are meaningful only for note rows; they are disabled while a task or inbox row is selected.

## Test plan

- `use-folder-view.test.tsx` — scope parametrization; folder and tag caches stay isolated.
- `folder-view.test.tsx` — tag scope: the locked filter cannot be removed, the `kind` column is present, all three row-opening paths work.
- `tag-definition-handler.test.ts` — `views === undefined` preserves the local value, `null` clears it.
- Migration: an existing vault opens with `views` absent.
- Removed with their subjects: `tag-view.test.tsx`, `use-tag-items.test.ts`.
- `pnpm ipc:generate && pnpm ipc:check`.
- i18n: `tagView.kindFilter.*` keys die; `tagView.pin.*` moves to the bulk bar. `pnpm --filter @memry/desktop i18n:check`.

## Phase 2 — calendar events

Separate spec and PR. An `event_tags` join table following the `taskTags` pattern with its own hand-written migration; `tags` added to the `calendar-event-handler.ts` sync payload with union merge on pull, mirroring the task handler; tag assignment UI on the event; a fourth source in `listTagItems` and `kind: 'event'` in the contract; rows opening into the Calendar tab. Phase 1 is complete without it — events slot in as one more source.

## Open decision

The "new" button under tag scope. Proposal: create a note in the default folder with the tag already applied.
