# Home Tasks Widget — Saved Filter Selection

**Date:** 2026-06-23
**Status:** Approved design
**Branch:** home-dashboard

## Problem

The home dashboard tasks widget is a single fixed view (`config.dateRange: 'today'`,
optionally `config.projectId`). The intent is for the tasks widget to be **customizable
by the saved filters the user already creates on the Tasks page** — pick a saved query
and the widget shows that query's tasks.

## Goal

Add a saved-filter `<select>` to the tasks widget config panel (the gear → ConfigEditor
panel that already exists for the folder widget). Selecting a saved filter makes the
widget render that filter's filtered + sorted tasks. No selection = current "Today"
behavior, unchanged.

## Non-Goals (YAGNI)

- Always-visible header/body dropdown — explicitly chose the gear ConfigEditor panel.
- A date-range / project view picker in the editor — saved filters subsume it (save a
  "due today" filter instead).
- Widget title reflecting the filter name — needs `WidgetFrame` plumbing; skip.
- Creating/starring saved filters from the widget — that stays on the Tasks page.

## Existing pieces this reuses

- `useSavedFilters()` (`hooks/use-task-filters.ts`) — loads DB-backed, synced
  `SavedFilter[]` (`{ id, name, filters, sort?, starred, createdAt }`), already
  subscribes to create/update/delete events.
- `applyFiltersAndSort(tasks, filters, sort, projects)` (`lib/task-utils/task-filters.ts`)
  — the same function the Tasks page uses to apply a saved filter.
- `defaultSort` (`data/tasks-data.ts`) — fallback when a saved filter has no `sort`.
- `WidgetFrame` ConfigEditor panel + `WidgetConfigEditorProps` — already wired; the
  folder widget is the exact precedent (`folder-widget-config-editor.tsx`).
- `getFilteredTasks(...)` — current today/project path, kept as the fallback.

## Design

### Config shape

```ts
// WidgetInstance.config for the tasks widget
{
  dateRange?: string        // existing, default 'today' (fallback view)
  projectId?: string        // existing
  savedFilterId?: string    // NEW, optional — id of a SavedFilter
}
```

`defaultConfig` stays `{ dateRange: 'today' }`. `savedFilterId` is purely additive, so
existing widgets keep working with no migration.

### New file: `components/home/widgets/tasks-widget-config-editor.tsx`

Mirrors `folder-widget-config-editor.tsx`.

- `const { savedFilters } = useSavedFilters()`
- One labelled `<select>`:
  - First option `value=""` → `t('home.widget.savedFilterDefault')` ("Today") = no filter.
  - One `<option value={f.id}>{f.name}</option>` per saved filter.
- `value` = `typeof config.savedFilterId === 'string' ? config.savedFilterId : ''`
- `onChange` → `onChange({ ...config, savedFilterId: e.target.value || undefined })`
- Empty state: when `savedFilters` is empty (`[]` — also the initial loading value), the
  select still shows the "Today" option; render a muted hint
  `t('home.widget.savedFilterHint')` below it. No new affordance.

### `components/home/widgets/tasks-widget.tsx` selection logic

```ts
const { savedFilters } = useSavedFilters()
const savedFilterId = typeof config.savedFilterId === 'string' ? config.savedFilterId : null
const filter = savedFilterId ? savedFilters.find((f) => f.id === savedFilterId) : null

const filtered = useMemo(() => {
  if (filter) {
    return applyFiltersAndSort(tasks, filter.filters, filter.sort ?? defaultSort, projects).slice(
      0,
      limit
    )
  }
  return getFilteredTasks(tasks, selectedId, selectedType, projects).slice(0, limit)
}, [filter, tasks, projects, selectedId, selectedType, limit])
```

- Filter found → apply it.
- `savedFilterId` set but filter missing (deleted, or list still loading) → fall back to
  the existing today/project path. No crash, graceful.
- No `savedFilterId` → unchanged behavior.

> `useSavedFilters()` returns `savedFilters ?? []` (coalesced — never `undefined`; see
> `use-task-filters.ts:505`), so a plain `savedFilters.find(...)` is safe. During the
> initial load it's `[]` → `filter` is `null` → Today fallback renders, then re-renders
> once filters load.

### `components/home/widgets/index.ts`

Add one line to the existing `registerWidget({ type: 'tasks', ... })`:

```ts
ConfigEditor: TasksWidgetConfigEditor
```

plus the import.

### i18n — `packages/i18n/src/locales/en/common.json`

Under `home.widget` (after `"unknown"`):

```json
"savedFilterLabel": "Saved filter",
"savedFilterDefault": "Today",
"savedFilterHint": "Star filters on the Tasks page to use them here"
```

(Other locales: add the same keys; `i18n:check` enforces parity.)

## Testing

Extend `components/home/widgets/tasks-widget.test.tsx` (mock `useSavedFilters` +
`useTaskWorkspaceData`):

1. `savedFilterId` matches a saved filter → widget renders that filter's tasks
   (assert `applyFiltersAndSort` result is shown, e.g. only matching task titles).
2. `savedFilterId` points at a missing/deleted filter → falls back to Today view
   (renders the today-path tasks, no crash).
3. No `savedFilterId` → unchanged Today behavior (regression guard).

Gates: `pnpm --filter @memry/desktop test:renderer`, `typecheck:web`, `lint`,
`i18n:check`.

## Files touched

| File                                                         | Change                                  |
| ------------------------------------------------------------ | --------------------------------------- |
| `components/home/widgets/tasks-widget-config-editor.tsx`     | NEW (~45 lines)                         |
| `components/home/widgets/tasks-widget.tsx`                   | + `useSavedFilters`, branch (~10 lines) |
| `components/home/widgets/index.ts`                           | + `ConfigEditor` line + import          |
| `components/home/widgets/tasks-widget.test.tsx`              | + 3 cases                               |
| `packages/i18n/src/locales/en/common.json` (+ other locales) | + 3 keys                                |

## Risks

- None structural — additive config, no shared-component churn, no DB/IPC/contract
  change (saved filters already have full IPC + sync).
- `useSavedFilters` returns `[]` during initial load (not `undefined`); the fallback
  branch covers that window — Today renders, then the filter applies once loaded.
