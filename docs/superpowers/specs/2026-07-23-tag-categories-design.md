# Tag Categories + Tag Page Design

Date: 2026-07-23
Status: Approved design, not implemented

## Problem

Tags are a flat namespace. A vault mixes work tags, book tags, and project tags in
one alphabetical pile, so the sidebar tag section stops being scannable once a user
passes a few dozen tags. There is no way to say "these six tags belong to Work" and
"these three belong to Books."

Tag names already support a `/` hierarchy (`work/meetings`), rendered as a tree by
[`buildTagTree`](../../../apps/desktop/src/renderer/src/lib/tag-tree.ts). That
hierarchy is part of the tag's identity — renaming a tag to move it rewrites the
`#tag` text inside notes. It cannot serve as a grouping layer users reorganize freely.

Clicking a tag today opens a cramped drill-down panel inside the sidebar
([`TagDetailView`](../../../apps/desktop/src/renderer/src/components/sidebar/tag-detail-view.tsx),
707 lines) that lists notes and tasks as single lines with no columns, sorting, or
filtering — far weaker than the folder view users already know.

## Goals

1. Group tags under user-defined categories, independent of tag names.
2. Replace the sidebar drill-down with a full tab showing a tag's items in a table,
   matching the folder view.
3. Give categories and tags a manual, drag-and-drop order that syncs across devices.

## Non-goals

- A tag belonging to more than one category.
- Category icons or colors. A category has a name and nothing else.
- Adding a tag field to calendar events (`calendar_events` has no tag column today).
- Automatic rules driven by category membership.

## Decisions

| Question                      | Decision                                                                   |
| ----------------------------- | -------------------------------------------------------------------------- |
| Category vs. nested tag names | Separate layer. Tag names never change.                                    |
| Category membership           | Exactly one category per tag; unassigned tags group under "Uncategorized". |
| Category fields               | Name only. Tags keep their existing color and icon.                        |
| Storage                       | New `tag_categories` table + new `tag_category` sync type.                 |
| Table scope                   | Notes + tasks + inbox items.                                               |
| Hub layout                    | Category heading, tags as colored chips flowing side by side and wrapping. |
| Tabs                          | Hub is a singleton tab; each tag opens its own tab.                        |
| Sidebar                       | Tag list stays and groups by category; drill-down is deleted.              |
| Descendants                   | A tag's page includes items of its `/` descendants.                        |
| Table implementation          | Share `FolderTableView` with the folder view.                              |

## Data model

### New table: `tag_categories` (data DB)

| column       | type                       | notes                                                    |
| ------------ | -------------------------- | -------------------------------------------------------- |
| `id`         | text, PK                   | uuid                                                     |
| `name`       | text NOT NULL              | the only user-editable field                             |
| `sort_order` | integer NOT NULL DEFAULT 0 | order among categories                                   |
| `clock`      | text (json)                | field-level vector clock, required for record sync types |
| `created_at` | text NOT NULL              | ISO 8601, `strftime` default like `tag_definitions`      |
| `updated_at` | text NOT NULL              | ISO 8601                                                 |
| `deleted_at` | text                       | soft delete; the sync tombstone                          |

Schema file: `packages/db-schema/src/schema/tag-categories.ts`, exported from
`packages/db-schema/src/schema/index.ts`.

### Changed table: `tag_definitions`

Two additive columns:

- `category_id` text, nullable. `NULL` means uncategorized.
- `sort_order` integer NOT NULL DEFAULT 0. Order within the category.

**No foreign key on `category_id`.** This is deliberate. A cascade-delete FK on a
synced table produced an orphan loop that broke sync in production (issue #837).
Reads treat a `category_id` pointing at a missing or soft-deleted category exactly
as `NULL` — the tag renders under "Uncategorized". A periodic cleanup is not needed;
the dangling id is harmless and self-healing on the next category assignment.

### Migration

One hand-written additive SQL file,
`apps/desktop/src/main/database/drizzle-data/0038_tag_categories.sql` (0037 is the
latest on `main`; bump if another migration lands first):

```sql
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

Existing rows keep every value they have; new columns take `NULL` / `0`. No reset,
no backfill pass. Until a user drags anything, every tag has `sort_order = 0` and the
hub falls back to the existing sort preference (most used) as the tiebreak, so the
first render is stable and sensible rather than arbitrary.

Data-DB migrations here are hand-written — the Drizzle snapshots have been broken
since 0021, so `db:generate` is not the source of truth for this table.

## Sync

`tag_definition` is already a synced record type with a vector clock. Categories join
it as a sibling.

- Add `tag_category` to `SYNC_ITEM_TYPES`, `RECORD_SYNC_ITEM_TYPES`, and
  `RECORD_CLOCK_REQUIRED_ITEM_TYPES` in
  [`packages/contracts/src/sync-api.ts`](../../../packages/contracts/src/sync-api.ts).
- Add `apps/desktop/src/main/sync/item-handlers/tag-category-handler.ts`, following
  [`folder-config-handler.ts`](../../../apps/desktop/src/main/sync/item-handlers/folder-config-handler.ts)
  (143 lines — the closest existing shape: a small record type with a clock and a
  soft delete). Register it in `item-handlers/index.ts`.
- Extend the `tag_definition` handler payload with `categoryId` and `sortOrder` as
  clocked fields, merged per field like the existing `color` and `icon`.

### Backward compatibility

A build that predates this change pulls a `tag_category` item, finds no handler, logs
a warning, emits `sync_skipped_unknown_type`, and returns `skipped`
([`apply-item.ts:34`](../../../apps/desktop/src/main/sync/apply-item.ts:34)). It does
not crash and loses no local data. Categories are simply invisible on that device.

The one real degradation: an old build that writes a `tag_definition` (a rename or a
color change) round-trips a payload without `categoryId` / `sortOrder`. Because the
merge is field-level and the old payload carries no clock entry for those fields, the
new fields survive — the old device's clock cannot win a field it never sets. This
must be covered by a handler test rather than assumed.

The sync server treats `itemType` as an opaque string; no server change and no server
deploy ordering is required. The `#754` type-negotiation filter, where present,
prevents the server from sending `tag_category` to clients that do not declare it.

## Hub page — tab type `tags`, singleton

```
[ search… ]                                        one line, matches categories and tags

Work                                                                        4 tags
  ● meetings 12    ● work/1:1 8    ● people 31    ● okr 3

Books                                                                       3 tags
  ● general 45     ● article 9     ● organization 6

Uncategorized                                                              11 tags
  ● inbox 4        ● idea 22       …

  [ + New category ]   [ + New tag ]
```

- One chip per tag, showing its icon when set, its **full** name (`work/meetings` is
  a single chip — no tree inside the hub), and its item count. Chips flow horizontally
  and wrap; the sidebar keeps the `/` tree view.
- Category heading shows the number of tags in it. Hover reveals rename and delete.
- Counts: a tag's count is its linked items (notes + tasks + inbox, including `/`
  descendants — the same `totalCount` the sidebar shows). A category's count is the
  number of tags in it.
- Search filters chips by tag name and categories by category name; a category whose
  chips all filter out is hidden while the query is active.
- Drag and drop, via dnd-kit (already a dependency, used by `folder-table-view`):
  reorder a chip inside its category, drag a chip into another category, and reorder
  category blocks. On drop, `sort_order` is rewritten for the affected rows and pushed
  to sync.
- Inline creation, no dialog. "New category" opens a single name input; Enter saves.
  "New tag" opens a name input plus the existing tag color palette
  ([`tag-colors.ts`](../../../apps/desktop/src/renderer/src/components/note/tags-row/tag-colors.ts));
  the tag lands in the category whose block the affordance was invoked from, or in
  Uncategorized from the page-level affordance. Escape cancels.
- Deleting a category does **not** delete its tags. They fall back to Uncategorized.

## Tag page — tab type `tag`, one tab per tag

- Header: the tag chip (icon + color), total item count, and a `⋯` menu carrying the
  actions that live in `TagDetailView` today — rename, change color, change icon,
  delete — reusing `TagRenameDialog` and `TagDeleteDialog` unchanged.
- Toolbar: search, a kind filter (All / Notes / Tasks / Inbox), and sort.
- Table: the shared `FolderTableView`.
- Columns: Title, Kind, Tags, Folder/Project, Modified.
- Row click routes by kind: a note opens a note tab, a task opens the Tasks tab with
  its detail drawer (the `viewState` shape `TagDetailView` already uses), an inbox
  item opens Inbox.
- The page includes items of the tag's `/` descendants, so `work` shows
  `work/meetings` items. This matches the counts the sidebar already displays and the
  descendant matching the current task list performs.

### Sharing `FolderTableView`

[`FolderTableView`](../../../apps/desktop/src/renderer/src/components/folder-view/folder-table-view.tsx)
is already presentational: it takes `notes: NoteWithProperties[]`, a column config,
and callbacks. It has no knowledge of a folder path. Sharing it needs one narrow
change: the row type gains an optional `kind?: 'note' | 'task' | 'inbox'`, defaulting
to `'note'` so the folder view's behavior and rendering are untouched. Tasks and inbox
items are adapted into that row shape by the tag page's own hook, which keeps the
adapter out of the table.

This is the extent of the refactor. No restructuring of `folder-view.tsx` or
`use-folder-view.ts` is in scope.

## Sidebar

- `SidebarTagList` groups tags under category headings, using the manual order.
- The sort Picker gains a **Manual** option, which becomes the default. The four
  existing options (most used, least used, A→Z, Z→A) are kept and continue to work,
  sorting within each category.
- Clicking a tag calls `openSidebarItem({ type: 'tag', … })` instead of pushing a
  drill-down. Opening a tag already open focuses that tab.
- The section header's hover actions gain a third: open the tag hub.
- `tag-detail-view.tsx` and the tag branch of the sidebar drill-down are deleted.
  Bookmarking and the tag context menu are preserved.

## Tab wiring

- `TabType` gains `'tags'` and `'tag'`
  ([`contexts/tabs/types.ts:13`](../../../apps/desktop/src/renderer/src/contexts/tabs/types.ts:13)).
- `'tags'` is added to `SINGLETON_TAB_TYPES`. `'tag'` is not — it is entity-based like
  `note` and `canvas`, keyed by tag name, so opening the same tag twice focuses the
  existing tab.
- Tab icons are registered in `components/tabs/tab-icon.tsx`.

## IPC

New channels in `packages/contracts`, then `pnpm ipc:generate`:

- `tags:listCategories` → categories with their tag counts
- `tags:createCategory` / `renameCategory` / `deleteCategory`
- `tags:reorder` → accepts the full ordered assignment for the affected categories in
  one call, so a drag writes one atomic transaction rather than N row updates
- `tags:listItems` → items for a tag (notes + tasks + inbox, descendants included),
  with the kind discriminator

Handlers extend [`ipc/tags-handlers.ts`](../../../apps/desktop/src/main/ipc/tags-handlers.ts).
Queries extend [`queries/tag-definitions.ts`](../../../apps/desktop/src/main/database/queries/tag-definitions.ts)
plus a new `queries/tag-categories.ts`.

## Testing

Node / main:

- `tag-categories` queries: create, rename, delete (tags survive and read as
  uncategorized), reorder within and across categories.
- `tag-category-handler`: apply create/update/delete, field-level clock merge,
  concurrent rename resolution, tombstone handling.
- `tag_definition` handler: `categoryId` / `sortOrder` merge, and the old-payload case
  — a write missing those fields must not clear them.
- Migration: idempotent re-run; a pre-migration DB opens and keeps its tags.

Renderer:

- Hub: renders categories with chips, counts are correct, search filters both levels,
  drag reorder calls the reorder IPC with the expected payload, inline create saves on
  Enter and cancels on Escape.
- Tag page: kind filter, descendant inclusion, row click routing per kind.
- Sidebar: tags group by category, Manual sort is default, clicking opens a tab.

Gates: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm ipc:generate && pnpm ipc:check`,
`pnpm --filter @memry/desktop i18n:check`, `pnpm check:architecture`,
`pnpm check:contracts`, `pnpm docs:impact --base <base> --strict`, `pnpm docs:build`.

E2E: clicking a sidebar tag opens a tag tab showing that tag's items.

## Risks

- **New sync type.** Mitigated by the skip path in `apply-item.ts` and by handler
  tests for the mixed-version cases. Old devices see no categories; nothing breaks.
- **Deleting `TagDetailView`.** Its rename/color/icon/delete actions and its pin
  behavior must be accounted for before deletion. Pinning notes to a tag lives in
  `useTagDetail`; the tag page keeps it as a table row action rather than dropping it.
- **Sidebar default sort change.** Switching the default to Manual changes what
  existing users see on upgrade. With every `sort_order` at 0 the fallback ordering is
  the current most-used order, so the first launch after upgrade looks unchanged.
