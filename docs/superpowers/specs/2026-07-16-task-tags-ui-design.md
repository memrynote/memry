# Task tags in the UI

**Date:** 2026-07-16
**Branch:** `task-tags-ui`
**Status:** Approved, ready for implementation plan

## Summary

Expose task tagging in the tasks UI. Tags on tasks are already fully implemented in the
database, domain commands, sync, and IPC contracts — the renderer simply discards them.
This work closes that gap and adds one missing piece of main-process hydration.

"MIT" (Most Important Task) is the motivating use case, but it is **just a tag**. No
MIT-specific feature, flag, or per-day selection is built here. See
[Rejected alternatives](#rejected-alternatives).

## Background: what already exists

Do not rebuild any of this.

| Layer                                                     | Status            | Location                                                                                            |
| --------------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------- |
| `task_tags` table (`COLLATE NOCASE`, PK `(task_id, tag)`) | Built             | `packages/db-schema/src/schema/task-relations.ts:20-32`                                             |
| `tags` on create/update input                             | Built             | `packages/contracts/src/tasks-api.ts:45,73` (≤20 tags × ≤50 chars)                                  |
| Tag persistence                                           | Built             | `packages/domain-tasks/src/commands.ts:282,326`; `main/database/queries/tasks.ts:583` `setTaskTags` |
| Tag hydration on read (single **and** list)               | Built             | `packages/storage-data/src/tasks-repository.ts:125` (`enrichTask`), applied to lists at `:158`      |
| Sync                                                      | Built             | `tags: string[]` in `TaskSyncPayloadSchema`; union-merged in `task-handler.ts:125`                  |
| Tag definitions (color/icon), synced                      | Built             | `packages/db-schema/src/schema/tag-definitions.ts`; `tag_definition` sync type                      |
| Aggregated note+task tag counts                           | Built             | `main/database/queries/tags.ts:11` `getAllTagsWithCounts` → `tags:get-all-with-counts`              |
| Backend tag filtering                                     | Built, unused     | `main/database/queries/tasks.ts:147` (AND semantics — see below)                                    |
| `tasks:get-tags` IPC endpoint                             | Built, no callers | `main/ipc/tasks-handlers.ts:253`                                                                    |

## Tag hydration: already works (verified)

An earlier draft of this spec claimed tags were not hydrated on list reads. **That was
wrong**, and the correction matters: it removes all main-process work from this change.

The raw query layer `listTasks` (`main/database/queries/tasks.ts:93-191`) does end in a
bare `db.select().from(tasks)` with no `taskTags` join — but it is not the layer the IPC
path uses. The repository above it enriches every row:

```ts
// packages/storage-data/src/tasks-repository.ts:158
listTasks(options: TaskListOptions = {}): TaskListItem[] {
  return taskQueries.listTasks(db, options).map((task) => enrichTask(db, taskQueries, task) as TaskListItem)
}

// :113-131 enrichTask
tags: taskQueries.getTaskTags(db, task.id),
```

Verified chain: `tasks:list` handler (`main/ipc/tasks-handlers.ts:67`) →
`createDesktopTasksDomain` → `createTasksRepository` (`main/tasks/domain.ts:13`) →
`repository.listTasks` → `enrichTask` → `getTaskTags`.

**Tags already cross the IPC boundary on every list read.** This work is renderer-only.

## Design

### 1. Data model

`data/task-model.ts:39` — add `tags: string[]` to the UI `Task` interface.

This is the keystone. The UI `Task` currently has no `tags` field at all, which is why
`dbTaskToUiTask` drops them on read and `addTask` hardcodes `tags: []` on write. Adding
the field break-compiles every drop site and forces a visit to each.

Then in `features/tasks/use-task-queries.ts`:

- `:87` `dbTaskToUiTask` — map `tags: dbTask.tags ?? []`
- `:319` `addTask` — stop hardcoding `tags: []`; forward `task.tags`
- `:330` `updateTask` — add a `tags` branch (it does not forward tags today)

### 2. Main process

**No changes.** Hydration already works (see above). No schema change, no migration, no
contract change to task create/update — `tags` already exists on both.

### 3. Surfaces

All four read and write through the UI `Task.tags` field.

**Detail drawer** (`components/tasks/task-detail-drawer.tsx`) — a Tags row beside the
existing Priority row (`:381`), using `TagAutocomplete`.

**Task row chips** (`components/tasks/task-badges.tsx`) — read-only `TagChip`s following
the `ProjectBadge` pill pattern (`:25-49`), with a `+N` overflow badge mirroring
`calendar-task-popover-meta.tsx:52`.

**Add-task modal** (`components/tasks/add-task-modal.tsx`) — `TagAutocomplete` next to the
existing `PrioritySelect` (`:292`).

**Filter panel** — new `components/tasks/filters/filter-panels/tag-panel.tsx`, cloned from
`priority-panel.tsx`.

### 4. Component reuse

**`TagChip`** (`components/note/tags-row/TagChip.tsx`) — reuse as-is. Already proven
outside the note editor in five places, including the calendar task popover. Populate
`icon` from the tag definition; the calendar's version omits it, so calendar task chips
render icon-less today.

Structural note: with no `onClick` it renders an `<li>` (needs a list parent); with
`onClick` it renders `<button role="option" aria-selected>` (presumes a `role="listbox"`
parent).

**`TagAutocomplete`** (`components/filing/tag-autocomplete.tsx`) — reuse. Self-sufficient:
fetches its own data, resolves colors and icons, supports `a/b/c` hierarchy, keyboard nav,
and a create-tag footer.

Two caveats:

- It hardcodes its own chrome (`flex flex-col gap-2 py-4 px-5 border-b border-border`) plus
  an always-rendered "TAGS" label. `className` only appends. Expect to unpick this wrapper
  for the drawer and modal.
- `showSections` is destructured as `_showSections` — the prop is accepted but ignored.

**Do not reuse** `components/filing/tag-input.tsx` (dead — only its own test imports it) or
`components/bulk/bulk-tag-popover.tsx` (inbox-specific i18n keys, bulk/trigger-driven).

### 5. Tag data source

Use `useTags` (`hooks/use-tags.ts` → `tags:get-all-with-counts`).

It is the only path carrying both `color` and `icon`, and `getAllTagsWithCounts` already
merges note + task counts. Its `TagWithCount` (`packages/contracts/src/tags-api.ts:118`) is
the real contract type.

Do **not** use `useAllTags`: no icons, no color on inbox-only tags, and its `source` field
labels task tags as `'notes'` (it reads the notes channel, which folds task counts in
transitively).

Import `defaultTagColorName` from `components/note/tags-row/tag-colors.ts`. Do not copy
`tag-autocomplete.tsx:16`'s private `getColorForTag` — it uses a different hash than the
canonical one, so a new tag previews in one color and renders in another.

### 6. Filter semantics: OR, client-side

The backend tag filter (`main/database/queries/tasks.ts:147`) is **AND** —
`tagCount === tags.length`, requiring a task to carry _every_ selected tag. Every other
multi-select panel in the tasks UI (priority, project, status) is **OR**. Selecting two
tags through the backend filter would return near-empty results and read as broken.

Tasks are already fully loaded client-side (`use-task-queries.ts:206` fetches
`limit: 1000` and filters in `lib/task-utils/task-filters.ts`), so filtering happens
client-side with OR semantics, mirroring `filterByPriorities` exactly.

The backend AND filter is left untouched and unused. Changing its meaning is out of scope:
it is reachable via the `tasks:list` IPC contract, so its semantics are not ours to
redefine unilaterally.

Three sites in `lib/task-utils/task-filters.ts`:

- `:50` — add `filterByTags(tasks, tags)`, mirroring `filterByPriorities`
- `:279` — apply it inside `applyFiltersAndSort`
- `:303-327` — `hasActiveFilters` **and** `countActiveFilters` both enumerate keys by hand;
  both need a `tags` clause or the filter chip and count will be wrong

### 7. Filter wiring

`data/tasks-data.ts` — add `tags: string[]` to `TaskFilters` (`:277`) and `tags: []` to
`defaultFilters` (`:346`).

Make `tags` **required**, not optional. This is deliberate: it break-compiles the four
existing `TaskFilters` literals in tests and forces a visit to each site. Making it
optional keeps everything compiling and leaves the `hasActiveFilters` /
`countActiveFilters` / mapper omissions invisible.

`components/tasks/filters/filter-dropdown.tsx` — four lockstep edits:

- `:37` `ActivePanel` union
- `:39` `FILTER_CATEGORIES`
- `:46` `CATEGORY_ICONS`
- `:138` a `toggleTag` callback mirroring `togglePriority`, and `:245` the render block

`components/tasks/filters/active-filters-bar.tsx` — a pill following the `:86-117` pattern.
Its `useMemo` dep array at `:269` enumerates filter fields individually; add `filters.tags`
or the chip will not re-render.

### 8. Persistence — additive, backward compatible

Two independent paths.

**Per-view filter state → localStorage** (`hooks/use-task-filters.ts:69`) blind-spreads the
whole object, so `tags` rides along free. There is no version field. Entries written by
older builds will lack `tags`, so reads must merge over `defaultFilters` or
`filters.tags.length` throws on `undefined`.

**Saved filters → SQLite** is hand-mapped field-by-field in both directions. No schema
migration and no version bump are needed: config is stored as an opaque JSON column and
`TaskFiltersSchema` (`packages/contracts/src/saved-filters-api.ts:94`) uses `.default()` on
every field, so adding `tags: z.array(z.string()).default([])` makes pre-existing rows
parse cleanly to `tags: []`.

Four sites must move in lockstep:

1. `TaskFilters` interface — `packages/contracts/src/saved-filters-api.ts:35`
2. `TaskFiltersSchema` — `:94`
3. `dbToFrontendFilter` — `hooks/use-task-filters.ts:304`
4. `frontendToDbConfig` — `:343`

Miss a mapper and `tags` vanishes silently on save/reload — both directions build object
literals, so the types cannot catch it.

Mirror in `services/saved-filters-service.ts:27` (`TaskFiltersConfig`) and
`preload/index.d.ts:274`.

**Backward compatibility:** this is additive only. No DB migration, no sync payload change,
no IPC contract change to tasks. Older clients are unaffected — they already write and read
`task_tags` rows; they simply never display them.

### 9. Tag detail view

`components/sidebar/tag-detail-view.tsx` is notes-only today, yet
`calendar-task-popover.tsx:167` already links task tags into it via `openTag`. Clicking a
task's tag opens a view that structurally cannot show that task. This work fixes that
dead-end.

Add a Tasks section alongside "Pinned notes" / "All notes", following the existing section
header pattern (`:273`).

**Semantics:** the notes sections match descendant tags (`useTagDetail` defaults
`includeDescendants = true`, so tag `work` shows `work/urgent` notes). The backend task
filter is exact-match with no hierarchy. Using it would put two different behaviors under
one header.

So the Tasks section does **not** pass a `tags` filter to the backend. It reads the tasks
already loaded client-side and matches `tag` plus its `tag/*` descendants in the renderer —
the same rule as [section 6](#6-filter-semantics-or-client-side), consistent everywhere.

There is no `useTaskTagDetail` and `tagsService` is notes-only (`getNotesByTag`,
`pinNoteToTag`, …), so this section sources tasks through the tasks query layer rather than
`tagsService`.

Live updates: the view already subscribes to `onTagRenamed` / `onTagDeleted` (`:163-180`).
The Tasks section must refresh on those too, or a renamed tag leaves stale task rows.

## Testing

Renderer tests are colocated and run under the `renderer` project:

```bash
pnpm --filter @memry/desktop test:renderer
```

Coverage:

- **Model:** `dbTaskToUiTask` maps tags; `addTask` forwards them; `updateTask` forwards them
- **Filter:** `filterByTags` OR semantics; `hasActiveFilters` / `countActiveFilters` count tags
- **Persistence:** round-trip through both mappers; a saved filter written without `tags`
  parses to `tags: []`
- **Chips:** rendering + `+N` overflow

Existing literals that will break-compile and must be updated (this is the intended
forcing function):

- `createDefaultFilters()` — `lib/task-utils/task-utils.test.ts:166`
- `makeFilters()` — `medium-gap-extra.test.tsx:92`
- `richFilters` — `components/tasks/filters/task-filters-extra.test.tsx:49`
- `filtersWithPriority` — `components/tasks/filters/active-filters-bar.test.tsx:20`

## Out of scope

**Quick-add tag syntax.** `quick-add-input.tsx:42` already uses `#` for _project_
(`!today !!high #project`). Tags would need a different sigil, or a breaking change to
project syntax and muscle memory. Deferred until tags are actually in use and the right
sigil is obvious. Tagging is available via the drawer and add-modal.

**Changing the backend AND tag filter.** See [section 6](#6-filter-semantics-or-client-side).

**Task tag colors of their own.** Task tags share the note/global `tag_definitions` color
and icon store. This is existing behavior and is correct — a tag is one concept across
notes, tasks, and inbox.

**Bulk tagging of tasks.** `bulk-tag-popover.tsx` is inbox-only. Out of scope.

**The `enrichTask` N+1.** `enrichTask` runs three per-row queries (`getTaskTags`,
`getTaskNoteIds`, `countSubtasks`), so a `limit: 1000` list read issues ~3000 queries. This
is **pre-existing** — the tag query already runs on every list read today; its result is
simply discarded by the renderer. This change makes that existing work visible rather than
adding to it, so no regression is introduced and no batching is in scope here. Worth a
separate look if the tasks page ever feels slow on large vaults.

## Rejected alternatives

**MIT as a first-class feature** (per-day selection of top N tasks, own affordance,
surfaced in the Today tab). Rejected in favor of MIT-as-a-tag.

Worth recording _why_, since it is a real gap: the Today tab is purely date-derived
(`pages/tasks.tsx:367` — overdue + due-today), and there is no manual "these are my N for
today" selection anywhere in the app. A MIT feature would fill that. It would also
overlap with `priority` (already 0–4, heavily surfaced, with an existing
`priority-star.tsx`) unless explicitly scoped as _per-day selection_ rather than
_intrinsic importance_.

MIT-as-a-tag is the smaller, composable move: it ships the generic capability the backend
already has, and a tag named `MIT` works today. If per-day planning proves to be the real
need, it deserves its own design rather than being smuggled in as a tag.

**Generic tags skipped, MIT only.** Rejected — leaves task tags invisible despite being
fully built underneath, and builds a narrow feature on top of an unused general one.
