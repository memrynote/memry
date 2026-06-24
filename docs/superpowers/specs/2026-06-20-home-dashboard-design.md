# Home Dashboard — Design

**Date:** 2026-06-20
**Status:** Approved (brainstorm) → ready for implementation plan
**Owner:** Kaan

## Goal

A customizable "Home" surface that shows the pulse of the vault — inbox, tasks,
calendar, notes, reminders, bookmarks — as **widgets the user drags, resizes,
adds, and removes**, like macOS widgets. Not a counters readout ("8 inbox, 2
calendar"); the widgets are _interactive_ (check a task, triage an item,
capture a note) and several are _configurable per instance_. Users can keep
**multiple boards** ("Work", "Personal", "Reading") switched from inside Home.

## Locked decisions

| #   | Decision         | Choice                                                                                                          |
| --- | ---------------- | --------------------------------------------------------------------------------------------------------------- |
| 1   | Page identity    | **Customizable canvas** — user adds/removes widgets                                                             |
| 2   | Resize model     | **Preset sizes** (S/M/L), macOS-style — built on existing dnd-kit + CSS Grid, **no new dependency**             |
| 3   | Widget model     | **Instances** (same type many times), each with own size + config; two classes: **embeds** and **quick cards**  |
| 4   | Roster           | 8 widget types (below)                                                                                          |
| 5   | Persistence      | **Synced across devices** — new `home-page` sync item type                                                      |
| 6   | First run        | Home is the **default landing tab**; first device seeds a default board                                         |
| 7   | Multiple boards  | **Many boards**, one per `home-page` sync item                                                                  |
| 8   | Board navigation | **One Home tab + internal board switcher** (singleton tab)                                                      |
| 9   | Default board    | First board by `position` (no separate "primary" flag); last-active board remembered per device in localStorage |

## Data model

```ts
type WidgetSize = 'S' | 'M' | 'L' // S = 1×1, M = 2×2, L = 4×2 grid cells

interface WidgetInstance {
  id: string // nanoid
  type: WidgetType // registry key
  size: WidgetSize
  config: Record<string, unknown> // type-specific; {} for cardless widgets
}

interface HomePage {
  id: string
  name: string
  icon?: string
  position: number // board order; position 0 = default board
  widgets: WidgetInstance[] // ORDER is the layout (see grid engine)
}
```

A board's layout **is the order of `widgets`** — there are no x/y coordinates.

## Grid engine — the key simplification

Layout is an **ordered list, not a coordinate grid.** The board is a CSS Grid
with `grid-auto-flow: dense`; widgets place themselves in array order, each
spanning cells per its `size`:

- `S` → 1 col × 1 row
- `M` → 2 col × 2 row
- `L` → 4 col × 2 row

Column count is responsive (e.g. 4 cols wide / 2 medium / 1 narrow); spans
clamp to available columns. Consequences:

- **Reorder** = reorder the array. dnd-kit `SortableContext` + `rectSortingStrategy` (already installed for the tab strip).
- **Resize** = change `size`; grid reflows automatically.
- **No collision math, no compaction, no x/y persistence.** This is why preset
  sizes (decision 2) earns its keep and why no `react-grid-layout` is needed.

All layout mutations go through one pure reducer:

```ts
// lib/home/layout-reducer.ts
addWidget(page, type) // append with defaultSize + defaultConfig
removeWidget(page, id)
reorderWidgets(page, fromId, toId)
resizeWidget(page, id, size)
configureWidget(page, id, config)
```

The reducer is pure and unit-tested in isolation (the core logic).

## Widget contract (isolation)

A registry, one entry per widget type:

```ts
interface WidgetDefinition {
  type: WidgetType
  title: string // i18n key
  icon: string
  sizes: WidgetSize[] // allowed presets
  defaultSize: WidgetSize
  defaultConfig: Record<string, unknown>
  Component: FC<{ config; size }>
  ConfigEditor?: FC<{ config; onChange }> // omitted = not configurable
}
```

The board renders each `WidgetInstance` inside a shared **`WidgetFrame`** —
drag handle, title, size menu (S/M/L from `def.sizes`), config gear (if
`ConfigEditor`), remove button. Each widget is independent and communicates
only through `config` in / `onChange` out, so it can be understood and tested
alone. **Add widget** = a gallery popover listing registry entries; pick →
`addWidget`.

## The 8 widgets

Every widget wires a hook that **already exists** — this feature is mostly
assembly, not new backend.

### Embeds (M/L) — reuse the real feature component, full actions

| Widget     | Hook                                        | Config                              | Interaction                           |
| ---------- | ------------------------------------------- | ----------------------------------- | ------------------------------------- |
| **Tasks**  | `useTaskWorkspaceData` + `getFilteredTasks` | project, date range, status         | full CRUD inline, like the tasks page |
| **Inbox**  | `useInboxList`                              | all, or type/source filter          | triage (file/archive) inline          |
| **Folder** | `useFolderView`                             | folder path, view type, sort/filter | List/Board/Gallery + toolbar          |

**Required refactor (the main unknown):** `pages/folder-view.tsx`, the tasks
view, and the inbox list currently assume full-page chrome. Each needs an
**embeddable mode** — accept its config as props, drop page-level chrome, and
render inside a fixed-size frame. Reuse > rebuild, but this is the biggest piece
of work and should be its own plan phase per widget.

### Quick cards (S/M) — purpose-built

| Widget              | Hook                                    | Notes                                                                                 |
| ------------------- | --------------------------------------- | ------------------------------------------------------------------------------------- |
| **Quick actions**   | existing capture / note / journal paths | one widget, buttons: capture → inbox · new note · open today's journal · quick-access |
| **Today**           | `useCalendarRange` + `useReminders`     | events + timed reminders merged on an hour rail; click → open                         |
| **Recently edited** | `useNotesList` (sort=modified)          | jump back into a note                                                                 |
| **Bookmarks**       | `useBookmarks`                          | optional `itemType` filter (note/journal/task); click → open                          |
| **Most-used tags**  | notes tags source                       | tag jump-list; verify a tags-with-count source exists during planning                 |

## Multiple boards + switcher (navigation A)

- Home is a **singleton tab** (`type: 'home'`).
- `pages/home.tsx` renders a **BoardSwitcher** (segmented strip across the top:
  one chip per board ordered by `position`, a `+` to create, context menu to
  rename / delete / reorder) above the **BoardGrid** for the active board.
- Active board id remembered per device in `localStorage`; falls back to
  `position` 0. (Transient view pref — not synced.)

## Persistence + sync (decision 5/7)

Each board is one sync item of a **new type `home-page`** (a collection, many
instances), following the repo's `adding-sync-item-type` checklist:

- Add `'home-page'` to the `SyncItemType` union in `@memry/contracts`
  (resolve every resulting exhaustive `switch`/array).
- New handler `apps/desktop/src/main/sync/item-handlers/home-page-handler.ts`
  registered via `getHandler(type)`.
- Encrypted payload in R2, metadata in D1 (standard sync split).
- New contract `packages/contracts/src/home-page-api.ts` + IPC channels
  (list / get / create / update / delete / reorder). Run `pnpm ipc:generate`
  then `pnpm ipc:check`.
- Renderer hook `hooks/use-home-boards.ts` — list boards + mutate active board;
  optimistic, debounced save.
- **Conflict resolution: whole-document last-writer-wins per board.** A board
  layout does not need field-level CRDT merge; concurrent edits on two devices
  resolve to the last save. (Deliberate simplification.)

**First run (decision 6):** if the user has no `home-page` items, seed one
board named "Home" with `[Today (M), Tasks (M), Inbox (M), Quick actions (S)]`.
Seeded once, on the first device; thereafter it syncs.

## Tab system wiring

Exact registration points (from codebase exploration):

1. `contexts/tabs/types.ts` — add `'home'` to `TabType` union and to
   `SINGLETON_TAB_TYPES`.
2. `contexts/tabs/helpers.ts` — `TAB_ICONS.home` (e.g. `'home'`),
   `TAB_PATHS.home = '/home'`, and `createDefaultTab()` returns a `home` tab
   (default landing). `createInitialState()` follows.
3. `components/split-view/tab-content.tsx` — `case 'home': return <LazyHomePage />`.
4. New `pages/home.tsx`.

Session restore (`contexts/tabs/persistence`) still governs returning users;
the home default only applies on a fresh install or when restore is off.

## File map

**New (renderer):**

- `pages/home.tsx` — board page (switcher + grid)
- `components/home/board-switcher.tsx`
- `components/home/board-grid.tsx`
- `components/home/widget-frame.tsx`
- `components/home/widget-gallery.tsx`
- `components/home/widgets/*.tsx` — one per widget type
- `lib/home/widget-registry.ts`
- `lib/home/layout-reducer.ts` (+ `.test.ts`)
- `lib/home/widget-sizes.ts`
- `hooks/use-home-boards.ts`

**New (contracts / main):**

- `packages/contracts/src/home-page-api.ts`
- `apps/desktop/src/main/database/queries/home-pages.ts`
- `apps/desktop/src/main/sync/item-handlers/home-page-handler.ts`
- IPC handler + preload wiring for `home-page` channels

**Changed:**

- `contexts/tabs/types.ts`, `contexts/tabs/helpers.ts`,
  `components/split-view/tab-content.tsx`
- `@memry/contracts` `SyncItemType` union + every exhaustive consumer
- Embeddable-mode refactor of `pages/folder-view.tsx`, the tasks view, the
  inbox list

## Testing

- `lib/home/layout-reducer.test.ts` — add / remove / reorder / resize /
  configure (pure, the core logic).
- Widget registry smoke — each `def.Component` renders with `defaultConfig`.
- `home-page-handler` round-trip serialize/deserialize + last-writer-wins.
- Skip E2E for v1.

## Deferred (YAGNI)

- Freeform (edge-drag) resize — revisit only if presets prove too rigid.
- Defer-bucket widgets: standalone reminders, on-this-day resurfacing, mini
  graph, vault stats.
- Per-widget refresh intervals / widget theming.
- Field-level CRDT merge for boards (LWW is enough).
- Explicit "primary board" star (position 0 is the default).

## Risks / open questions

1. **Embeddable refactor** of folder-view / tasks / inbox is the largest
   unknown — scope each as its own plan phase; if a component resists clean
   embedding, fall back to a read-mostly summary for that widget in v1.
2. **New sync item type** is the heaviest plumbing; follow the existing
   checklist and mirror an existing handler.
3. **Widgets must look right at each allowed preset size** — design discipline,
   not code; keep `sizes` lists short and intentional.
4. Confirm a **tags-with-count** source exists for "Most-used tags"; if not,
   demote it to the defer bucket.
