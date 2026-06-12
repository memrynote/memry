# New-item menus + Picker-consistent dropdowns — Design

Date: 2026-06-12
Branch: `new-item-menus`
Worktree: `.worktrees/new-item-menus`

## Problem

The sidebar "New" button only creates a note. The tab-bar "+" opens a Radix
`DropdownMenu` with the full create list (New Note, Journal, Calendar, Inbox,
Tasks). Three menus across the app render in three visual styles:

- Tab "+" → Radix `DropdownMenu` (`@/components/ui/dropdown-menu`)
- Inbox filter → custom `Picker` (`@/components/ui/picker`, Popover-based, more
  polished: `shadow-card-hover`, `rounded-[5px]` items, `text-[13px]`)
- Right-click vault items → Radix `ContextMenu` (`@/components/ui/context-menu`)

Goal: give the sidebar "New" button a dropdown affordance, and unify the look of
all three menus on the **Picker style** (the inbox filter look).

## Decisions (locked with user)

1. **Sidebar "New" = split button.** Left half keeps the instant new-note click.
   A separate chevron on the right opens the dropdown.
2. **Tab "+" and sidebar dropdown use the real `Picker` component** (they are
   click-triggered, so the Popover-based Picker fits). They render the same item
   list.
3. **Right-click vault menu cannot use the Picker** (Picker/Popover anchors to a
   trigger; right-click menus must anchor to the cursor → must stay on Radix
   `ContextMenu`). "Same dropdown" there means **match the Picker's visual
   style**, achieved by restyling the shared primitive.
4. **Restyle the shared `context-menu.tsx` primitive** (one file) so every
   right-click menu app-wide (vault tree, folder-view rows, tab-bar) matches the
   Picker look. Chosen over a vault-only restyle for full consistency.

## Why Picker works as an action menu

`Picker.Item` (`components/ui/picker/picker-item.tsx`) calls its `onClick` prop,
then — if the event was not `preventDefault`'d — calls `onValueChange(value)`.
With `mode="single"` (default) and no root `value`/`onValueChange`, clicking an
item runs our handler and auto-closes the popover. So a `Picker` with action
items behaves like a normal action dropdown. This matches existing Picker usages
across the app (tasks filters, note editors, vault-switcher).

## Components

### 1. `NewItemMenuItems` (new, shared)

Path: `apps/desktop/src/renderer/src/components/tabs/new-item-menu-items.tsx`

Presentational. Renders `Picker.List` with five `Picker.Item`s. No open-state of
its own; the parent supplies the `Picker` shell + `Picker.Content`.

```tsx
export interface NewItemActions {
  onNewNote: () => void
  onJournal: () => void
  onCalendar: () => void
  onInbox: () => void
  onTasks: () => void
}

export function NewItemMenuItems({ actions }: { actions: NewItemActions }): React.JSX.Element
```

- Icons: `FileText, BookOpen, Calendar, Inbox, ListTodo` from `@/lib/icons`
  (`size-4`).
- Labels: reuse existing keys `phaseF.componentsTabsNewTabMenu.{newNote, journal,
calendar, inboxCapture, tasks}` (namespace `common`). No new label keys → no
  i18n churn for the items.
- Each `Picker.Item` gets a stable `value` (`note`/`journal`/`calendar`/`inbox`/
  `tasks`) and `onClick={actions.on*}`; `indicator="none"`.

Rationale for sharing only presentation, not handlers: the two contexts resolve
the target folder differently (tab menu uses `selectedFolder` + dispatches
`memry:expand-folder`; sidebar uses `targetFolderRef` and opens in the active
pane). Unifying note-creation would be risky. Sharing the item list guarantees an
identical menu without disturbing either behavior.

### 2. Tab "+" — `new-tab-menu.tsx` (rebuild on Picker)

Replace the Radix `DropdownMenu` shell with `Picker`:

```tsx
<Picker open={open} onOpenChange={setOpen}>
  <Tooltip>
    <TooltipTrigger asChild>
      <Picker.Trigger asChild>
        <button …existing "+" button styling…><Plus className="w-4 h-4" /></button>
      </Picker.Trigger>
    </TooltipTrigger>
    <TooltipContent side="bottom" …>{t('…newTab2')}</TooltipContent>
  </Tooltip>
  <Picker.Content width={200} align="start" side="bottom">
    <NewItemMenuItems actions={{
      onNewNote: () => void handleNewNote(),
      onJournal: handleNewJournal,
      onCalendar: handleOpenCalendar,
      onInbox: handleOpenInbox,
      onTasks: handleNewTask
    }} />
  </Picker.Content>
</Picker>
```

- Keep all existing handlers (they already pass `groupId` to `openTab`).
- Keep the `memry:new-tab-menu` window-event listener and the `open` state.
- Keep the tooltip and the existing trigger button styling unchanged.

### 3. Sidebar "New" — `app-sidebar.tsx` (split button)

Current (lines ~395-407): a single full-width button calling `handleNewNote`.

New structure — a two-button pill sharing `bg-sidebar-surface`:

```tsx
<div className="shrink-0 flex items-center px-3 pt-2 pb-0 group-data-[collapsible=icon]:hidden">
  <div className="flex flex-1 items-center h-[30px] rounded-[5px] bg-sidebar-surface overflow-hidden">
    {/* Left: instant new note — keeps accessible name "new" */}
    <button
      type="button"
      onClick={() => void handleNewNote()}
      className="flex flex-1 items-center justify-center gap-2 h-full hover:bg-black/[0.06] dark:hover:bg-white/[0.06] transition-colors cursor-pointer"
      title={t('phaseF.componentsAppSidebar.newNoteN')}
    >
      <Plus className="size-[15px] text-muted-foreground/70" />
      <span className="text-[13px] text-muted-foreground/70 font-normal">
        {t('phaseF.componentsAppSidebar.new')}
      </span>
    </button>
    {/* Right: dropdown */}
    <Picker>
      <Picker.Trigger asChild>
        <button
          type="button"
          aria-label={t('phaseF.componentsAppSidebar.newItemMenu')}
          className="flex h-full w-7 shrink-0 items-center justify-center border-s border-black/[0.06] dark:border-white/[0.08] hover:bg-black/[0.06] dark:hover:bg-white/[0.06] transition-colors cursor-pointer"
        >
          <ChevronDown className="size-3.5 text-muted-foreground/70" />
        </button>
      </Picker.Trigger>
      <Picker.Content width={200} align="end" side="bottom">
        <NewItemMenuItems
          actions={{
            onNewNote: () => void handleNewNote(),
            onJournal: () =>
              openSidebarItem({ type: 'journal', title: 'Journal', path: '/journal' }),
            onCalendar: () =>
              openSidebarItem({ type: 'calendar', title: 'Calendar', path: '/calendar' }),
            onInbox: () => openSidebarItem({ type: 'inbox', title: 'Inbox', path: '/inbox' }),
            onTasks: () => openSidebarItem({ type: 'tasks', title: 'Tasks', path: '/tasks' })
          }}
        />
      </Picker.Content>
    </Picker>
  </div>
</div>
```

- `ChevronDown` is exported from `@/lib/icons` (icon-map.ts).
- Sidebar dropdown items open in the **active pane** (no `groupId`), matching the
  existing "New" button and sidebar nav behavior. New Note reuses the sidebar's
  own `handleNewNote`; the four views reuse `openSidebarItem(...)` (same payload
  shape `handleNavClick` already uses).
- Logical Tailwind classes (`border-s`, `rounded-[5px]`) for RTL safety.
- **One new i18n key**: `phaseF.componentsAppSidebar.newItemMenu` (aria-label for
  the chevron; distinct from the left button's `new` so the existing
  `getByRole('button', { name: 'new' })` test stays unambiguous). Add to the
  `common` namespace; run `i18n:check` and add to any locales it requires.

### 4. Context-menu restyle — `components/ui/context-menu.tsx`

Restyle to match Picker. className-only; structure/exports unchanged.

- `ContextMenuContent`: `shadow-md` → `shadow-[var(--shadow-card-hover)]`.
- `ContextMenuSubContent`: `shadow-lg` → `shadow-[var(--shadow-card-hover)]`.
- `ContextMenuItem` / `ContextMenuSubTrigger`: `rounded-sm` → `rounded-[5px]`,
  `text-sm` → `text-[13px]`, add `text-muted-foreground` for the resting label
  color (mirrors `Picker.Item`; keep `focus:bg-accent` / `focus:text-accent-foreground`
  so the item brightens on hover/focus).
- `ContextMenuCheckboxItem` / `ContextMenuRadioItem`: same `rounded-[5px]` +
  `text-[13px]` for consistency.
- `ContextMenuSeparator` already matches Picker (`-mx-1 my-1 h-px bg-border`); no
  change.
- Keep the existing border, overflow/scroll, animation, and destructive-variant
  styles — only the four tokens above change. Destructive items keep their
  `data-[variant=destructive]` treatment.

## Testing

New:

- `new-item-menu-items.test.tsx` — render inside `<Picker open><Picker.Content>…`,
  click each of the five items, assert the matching action callback fires.

Keep green (no behavior regressions):

- `app-sidebar.test.tsx` — left button (`name: 'new'`) still calls `createNote` +
  `openTab`. Add a case: clicking the chevron (`newItemMenu`) opens the menu, then
  clicking `journal` calls `openSidebarItem` with the journal payload.
- Tab/tree suites: `tabs-components.test.tsx`, `notes-tree-isolated.test.tsx`,
  `virtualized-notes-tree.test.tsx`, `kibo-ui/tree/index.test.tsx`,
  `medium-ui-surfaces.test.tsx`, `zero-renderer-surfaces-extra.test.tsx` — the
  context-menu restyle is className-only, structure unchanged, so these stay
  green.

Commands:

- `pnpm --filter @memry/desktop typecheck:web`
- `pnpm --filter @memry/desktop test:renderer`
- `pnpm lint`
- `pnpm --filter @memry/desktop i18n:check`

## Out of scope

- No arrow-key roving nav in the new menus (Popover-based Picker doesn't provide
  it; consistent with existing Picker usages — accepted).
- No change to note-creation folder logic in either context.
- No removal of the now-dead `sidebar-item-context-menu.tsx` (pre-existing dead
  code; flag, don't delete).
- No migration of the tab "+" away from its existing handlers/`groupId`.
