# New-item Menus + Picker-consistent Dropdowns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the sidebar "New" button a split-button dropdown that opens the same create-menu as the tab "+", build both on the existing `Picker` component, and restyle the shared right-click `ContextMenu` primitive to match the Picker look.

**Architecture:** A new presentational `NewItemMenuItems` renders five `Picker.Item` action rows and is reused by both the tab "+" menu and the sidebar split button (each supplies its own `Picker` shell + handlers). Right-click menus stay on Radix `ContextMenu` (cursor-anchored) but get className-only restyling to the Picker aesthetic.

**Tech Stack:** React 19, TypeScript, Tailwind, Radix Popover/ContextMenu, the in-house `Picker` component (`@/components/ui/picker`), Vitest + Testing Library, `@memry/i18n`.

**Worktree:** `.worktrees/new-item-menus` (branch `new-item-menus`, off `origin/main`). All paths below are relative to that worktree root. Run all commands from `apps/desktop` unless noted.

**Reference spec:** `docs/superpowers/specs/2026-06-12-new-item-menus-design.md`

---

## File Structure

- **Create** `apps/desktop/src/renderer/src/components/tabs/new-item-menu-items.tsx` — shared 5-item Picker action list.
- **Create** `apps/desktop/src/renderer/src/components/tabs/new-item-menu-items.test.tsx` — unit test for the above.
- **Modify** `apps/desktop/src/renderer/src/components/tabs/new-tab-menu.tsx` — rebuild on `Picker`, render `NewItemMenuItems`.
- **Modify** `apps/desktop/src/renderer/src/components/app-sidebar.tsx` — split "New" button + chevron Picker dropdown.
- **Modify** `apps/desktop/src/renderer/src/components/app-sidebar.test.tsx` — add chevron→journal test case.
- **Modify** `apps/desktop/src/renderer/src/components/ui/context-menu.tsx` — restyle to Picker look.
- **Modify** `packages/i18n/src/locales/en/common.json` — add `componentsAppSidebar.newItemMenu`.

---

## Task 1: Add the chevron aria-label i18n key

**Files:**

- Modify: `packages/i18n/src/locales/en/common.json` (the `componentsAppSidebar` block, ~lines 203-215)

Only the English key is required: `apps/desktop/scripts/i18n/check.mjs` fails the build (`i18n:check`) only on keys used-but-missing-in-English, unknown namespaces, untranslated source literals, or TODOs. Missing keys in the other 31 locales are reported as warnings and do **not** change the exit code.

- [ ] **Step 1: Add the key**

In `packages/i18n/src/locales/en/common.json`, inside `"componentsAppSidebar"`, add a `newItemMenu` entry. The block currently ends:

```json
      "newNoteN": "New note (⌘N)",
      "new": "New",
      "syncDisabled": "Sync disabled",
      "syncDisabled2": "Sync disabled"
    },
```

Change to:

```json
      "newNoteN": "New note (⌘N)",
      "new": "New",
      "newItemMenu": "Create new…",
      "syncDisabled": "Sync disabled",
      "syncDisabled2": "Sync disabled"
    },
```

- [ ] **Step 2: Validate JSON parses**

Run (from repo root): `node -e "JSON.parse(require('fs').readFileSync('packages/i18n/src/locales/en/common.json','utf8')); console.log('ok')"`
Expected: `ok`

- [ ] **Step 3: Commit**

```bash
git add packages/i18n/src/locales/en/common.json
git commit -m "i18n(desktop): add componentsAppSidebar.newItemMenu label"
```

---

## Task 2: Create the shared `NewItemMenuItems` component (TDD)

**Files:**

- Create: `apps/desktop/src/renderer/src/components/tabs/new-item-menu-items.tsx`
- Test: `apps/desktop/src/renderer/src/components/tabs/new-item-menu-items.test.tsx`

The component renders five `Picker.Item` action rows. `Picker.Item` calls its `onClick` prop, then (if not `preventDefault`'d) calls the Picker context's `onValueChange(value)`; with default `mode="single"` and no root `onValueChange`, that just closes the popover. So each row runs its action then the menu auto-closes.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/renderer/src/components/tabs/new-item-menu-items.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Picker } from '@/components/ui/picker'
import { NewItemMenuItems, type NewItemActions } from './new-item-menu-items'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key.split('.').at(-1) ?? key })
}))

function renderMenu(actions: NewItemActions) {
  return render(
    <Picker open onOpenChange={() => {}}>
      <Picker.Content>
        <NewItemMenuItems actions={actions} />
      </Picker.Content>
    </Picker>
  )
}

describe('NewItemMenuItems', () => {
  it('fires the matching action for each item', () => {
    const actions: NewItemActions = {
      onNewNote: vi.fn(),
      onJournal: vi.fn(),
      onCalendar: vi.fn(),
      onInbox: vi.fn(),
      onTasks: vi.fn()
    }
    renderMenu(actions)

    fireEvent.click(screen.getByText('newNote'))
    expect(actions.onNewNote).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByText('journal'))
    expect(actions.onJournal).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByText('calendar'))
    expect(actions.onCalendar).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByText('inboxCapture'))
    expect(actions.onInbox).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByText('tasks'))
    expect(actions.onTasks).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- new-item-menu-items`
Expected: FAIL — cannot resolve `./new-item-menu-items` (module does not exist yet).

- [ ] **Step 3: Create the component**

Create `apps/desktop/src/renderer/src/components/tabs/new-item-menu-items.tsx`:

```tsx
import { FileText, BookOpen, Calendar, Inbox, ListTodo } from '@/lib/icons'
import { Picker } from '@/components/ui/picker'
import { useT } from '@memry/i18n/renderer'

export interface NewItemActions {
  onNewNote: () => void
  onJournal: () => void
  onCalendar: () => void
  onInbox: () => void
  onTasks: () => void
}

interface NewItemMenuItemsProps {
  actions: NewItemActions
}

export function NewItemMenuItems({ actions }: NewItemMenuItemsProps): React.JSX.Element {
  const { t: tPhaseF } = useT('common')

  return (
    <Picker.List>
      <Picker.Item
        value="note"
        label={tPhaseF('phaseF.componentsTabsNewTabMenu.newNote')}
        icon={<FileText className="size-4" />}
        onClick={actions.onNewNote}
      />
      <Picker.Item
        value="journal"
        label={tPhaseF('phaseF.componentsTabsNewTabMenu.journal')}
        icon={<BookOpen className="size-4" />}
        onClick={actions.onJournal}
      />
      <Picker.Item
        value="calendar"
        label={tPhaseF('phaseF.componentsTabsNewTabMenu.calendar')}
        icon={<Calendar className="size-4" />}
        onClick={actions.onCalendar}
      />
      <Picker.Item
        value="inbox"
        label={tPhaseF('phaseF.componentsTabsNewTabMenu.inboxCapture')}
        icon={<Inbox className="size-4" />}
        onClick={actions.onInbox}
      />
      <Picker.Item
        value="tasks"
        label={tPhaseF('phaseF.componentsTabsNewTabMenu.tasks')}
        icon={<ListTodo className="size-4" />}
        onClick={actions.onTasks}
      />
    </Picker.List>
  )
}
```

Note: `React.JSX.Element` is used as the return type without importing React — this matches the sibling `new-tab-menu.tsx`, which relies on the project's global React types.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop test:renderer -- new-item-menu-items`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/tabs/new-item-menu-items.tsx apps/desktop/src/renderer/src/components/tabs/new-item-menu-items.test.tsx
git commit -m "feat(desktop): add shared NewItemMenuItems Picker action list"
```

---

## Task 3: Rebuild the tab "+" menu on Picker

**Files:**

- Modify: `apps/desktop/src/renderer/src/components/tabs/new-tab-menu.tsx`

Keep every handler and the `memry:new-tab-menu` open-event logic unchanged. Only swap the Radix `DropdownMenu` shell for `Picker` and render the shared item list. This removes the now-duplicated icon imports.

- [ ] **Step 1: Update imports**

In `new-tab-menu.tsx`, replace the icon import (line 2):

```tsx
import { Plus, FileText, BookOpen, Calendar, Inbox, ListTodo } from '@/lib/icons'
```

with:

```tsx
import { Plus } from '@/lib/icons'
```

Replace the dropdown-menu import block (lines 13-18):

```tsx
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
```

with:

```tsx
import { Picker } from '@/components/ui/picker'
import { NewItemMenuItems } from './new-item-menu-items'
```

- [ ] **Step 2: Replace the returned JSX**

Replace the entire `return (...)` block (lines 147-197) with:

```tsx
return (
  <Picker open={open} onOpenChange={setOpen}>
    <Tooltip>
      <TooltipTrigger asChild>
        <Picker.Trigger asChild>
          <button
            type="button"
            className={cn(
              'flex h-7 w-7 items-center justify-center rounded-md',
              'text-text-tertiary hover:text-foreground',
              'hover:bg-surface-active/50',
              'transition-all duration-150 ease-out',
              'active:scale-95 active:bg-surface-active/70'
            )}
            aria-label={tPhaseF('phaseF.componentsTabsNewTabMenu.newTab')}
          >
            <Plus className="w-4 h-4" />
          </button>
        </Picker.Trigger>
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        className="text-xs px-2.5 py-1.5 font-medium bg-primary text-primary-foreground border-0"
      >
        {tPhaseF('phaseF.componentsTabsNewTabMenu.newTab2')}
      </TooltipContent>
    </Tooltip>
    <Picker.Content width={200} align="start" side="bottom">
      <NewItemMenuItems
        actions={{
          onNewNote: () => void handleNewNote(),
          onJournal: handleNewJournal,
          onCalendar: handleOpenCalendar,
          onInbox: handleOpenInbox,
          onTasks: handleNewTask
        }}
      />
    </Picker.Content>
  </Picker>
)
```

- [ ] **Step 3: Typecheck the renderer**

Run: `pnpm --filter @memry/desktop typecheck:web`
Expected: PASS — no unused-import or type errors in `new-tab-menu.tsx`. (`cn` is still used by the trigger button; `Plus`, `Tooltip*`, `useT`, all handlers remain used.)

- [ ] **Step 4: Run the tab test suite**

Run: `pnpm --filter @memry/desktop test:renderer -- tabs`
Expected: PASS — existing tab tests stay green (handlers and the trigger's accessible name are unchanged).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/tabs/new-tab-menu.tsx
git commit -m "refactor(desktop): rebuild tab new-tab menu on Picker"
```

---

## Task 4: Sidebar "New" split button + dropdown

**Files:**

- Modify: `apps/desktop/src/renderer/src/components/app-sidebar.tsx`
- Test: `apps/desktop/src/renderer/src/components/app-sidebar.test.tsx`

The left half keeps the instant new-note behavior and its accessible name `new`. The right half is a `ChevronDown` Picker trigger whose menu opens in the active pane via the sidebar's own `handleNewNote` and `openSidebarItem`.

- [ ] **Step 1: Write the failing test case**

In `app-sidebar.test.tsx`, add a new `it(...)` inside the `describe('AppSidebar', ...)` block (e.g. after the first test, around line 278):

```tsx
it('opens the new-item menu from the chevron and routes to journal', async () => {
  render(<AppSidebar currentPage="inbox" viewCounts={{}} />)

  fireEvent.click(screen.getByRole('button', { name: 'newItemMenu' }))
  fireEvent.click(await screen.findByText('journal'))

  expect(mocks.openSidebarItem).toHaveBeenCalledWith({
    type: 'journal',
    title: 'Journal',
    path: '/journal'
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- app-sidebar`
Expected: FAIL — no button named `newItemMenu` yet (chevron not implemented).

- [ ] **Step 3: Update imports**

In `app-sidebar.tsx`, add `ChevronDown` to the `@/lib/icons` import block (lines 6-16). It currently reads:

```tsx
import {
  Calendar2,
  CloudOff,
  ChevronsDown,
  ChevronsUp,
  FilePlus,
  FolderPlus,
  Plus,
  Settings,
  Upload
} from '@/lib/icons'
```

Change to:

```tsx
import {
  Calendar2,
  CloudOff,
  ChevronDown,
  ChevronsDown,
  ChevronsUp,
  FilePlus,
  FolderPlus,
  Plus,
  Settings,
  Upload
} from '@/lib/icons'
```

Then add two imports next to the other component imports (e.g. after line 35, the tooltip import):

```tsx
import { Picker } from '@/components/ui/picker'
import { NewItemMenuItems } from '@/components/tabs/new-item-menu-items'
```

- [ ] **Step 4: Replace the New button block**

Replace the current New-button block (lines 395-407):

```tsx
<div className="shrink-0 flex items-center px-3 pt-2 pb-0 group-data-[collapsible=icon]:hidden">
  <button
    type="button"
    onClick={() => void handleNewNote()}
    className="flex flex-1 items-center justify-center gap-2 h-[30px] rounded-[5px] bg-sidebar-surface hover:bg-black/[0.06] dark:hover:bg-white/[0.06] transition-colors cursor-pointer"
    title={tPhaseF('phaseF.componentsAppSidebar.newNoteN')}
  >
    <Plus className="size-[15px] text-muted-foreground/70" />
    <span className="text-[13px] text-muted-foreground/70 font-normal">
      {tPhaseF('phaseF.componentsAppSidebar.new')}
    </span>
  </button>
</div>
```

with:

```tsx
<div className="shrink-0 flex items-center px-3 pt-2 pb-0 group-data-[collapsible=icon]:hidden">
  <div className="flex flex-1 items-center h-[30px] rounded-[5px] bg-sidebar-surface overflow-hidden">
    <button
      type="button"
      onClick={() => void handleNewNote()}
      className="flex flex-1 items-center justify-center gap-2 h-full hover:bg-black/[0.06] dark:hover:bg-white/[0.06] transition-colors cursor-pointer"
      title={tPhaseF('phaseF.componentsAppSidebar.newNoteN')}
    >
      <Plus className="size-[15px] text-muted-foreground/70" />
      <span className="text-[13px] text-muted-foreground/70 font-normal">
        {tPhaseF('phaseF.componentsAppSidebar.new')}
      </span>
    </button>
    <Picker>
      <Picker.Trigger asChild>
        <button
          type="button"
          aria-label={tPhaseF('phaseF.componentsAppSidebar.newItemMenu')}
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

`openSidebarItem` is already destructured from `useSidebarNavigation()` at line ~144; the `{ type, title, path }` payload matches the existing `handleNavClick` shape (`SidebarItem`).

- [ ] **Step 5: Run the sidebar test suite**

Run: `pnpm --filter @memry/desktop test:renderer -- app-sidebar`
Expected: PASS — both the new chevron→journal case and the existing first test (which clicks `name: 'new'` for the left button) are green.

- [ ] **Step 6: Typecheck the renderer**

Run: `pnpm --filter @memry/desktop typecheck:web`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/src/components/app-sidebar.tsx apps/desktop/src/renderer/src/components/app-sidebar.test.tsx
git commit -m "feat(desktop): sidebar New split button with Picker create menu"
```

---

## Task 5: Restyle the shared ContextMenu primitive to the Picker look

**Files:**

- Modify: `apps/desktop/src/renderer/src/components/ui/context-menu.tsx`

className-only edits; structure, props, and exports stay the same. Four token changes: container shadow → `shadow-[var(--shadow-card-hover)]`, item radius `rounded-sm` → `rounded-[5px]`, item text `text-sm` → `text-[13px]`, and a resting `text-muted-foreground` on the default/sub-trigger items (mirrors `Picker.Item`; `focus:bg-accent`/`focus:text-accent-foreground` still brighten on hover, and destructive items keep their red `data-[variant=destructive]` color). `--shadow-card-hover` is the same CSS var `Picker.Content` uses.

- [ ] **Step 1: ContextMenuSubTrigger (line ~48)**

In the `ContextMenuSubTrigger` className, change `rounded-sm` → `rounded-[5px]`, `text-sm` → `text-[13px]`, and add `text-muted-foreground`. The string becomes:

```tsx
        "focus:bg-accent focus:text-accent-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground [&_svg:not([class*='text-'])]:text-muted-foreground text-muted-foreground flex cursor-default items-center rounded-[5px] px-2 py-1.5 text-[13px] outline-hidden select-none data-[inset]:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
```

- [ ] **Step 2: ContextMenuSubContent (line ~67)**

Change `shadow-lg` → `shadow-[var(--shadow-card-hover)]`:

```tsx
        'bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-[8rem] origin-(--radix-context-menu-content-transform-origin) overflow-hidden rounded-md border p-1 shadow-[var(--shadow-card-hover)]',
```

- [ ] **Step 3: ContextMenuContent (line ~90)**

Change `shadow-md` → `shadow-[var(--shadow-card-hover)]`:

```tsx
          'bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 max-h-(--radix-context-menu-content-available-height) min-w-[8rem] origin-(--radix-context-menu-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-md border p-1 shadow-[var(--shadow-card-hover)]',
```

- [ ] **Step 4: ContextMenuItem (line ~115)**

Change `rounded-sm` → `rounded-[5px]`, `text-sm` → `text-[13px]`, and add `text-muted-foreground` (placed before `relative`):

```tsx
        "focus:bg-accent focus:text-accent-foreground data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 dark:data-[variant=destructive]:focus:bg-destructive/20 data-[variant=destructive]:focus:text-destructive data-[variant=destructive]:*:[svg]:!text-destructive [&_svg:not([class*='text-'])]:text-muted-foreground text-muted-foreground relative flex cursor-default items-center gap-2 rounded-[5px] px-2 py-1.5 text-[13px] outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[inset]:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
```

- [ ] **Step 5: ContextMenuCheckboxItem (line ~133)**

Change `rounded-sm` → `rounded-[5px]`, `text-sm` → `text-[13px]`:

```tsx
        "focus:bg-accent focus:text-accent-foreground relative flex cursor-default items-center gap-2 rounded-[5px] py-1.5 pe-2 ps-8 text-[13px] outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
```

- [ ] **Step 6: ContextMenuRadioItem (line ~158)**

Change `rounded-sm` → `rounded-[5px]`, `text-sm` → `text-[13px]`:

```tsx
        "focus:bg-accent focus:text-accent-foreground relative flex cursor-default items-center gap-2 rounded-[5px] py-1.5 pe-2 ps-8 text-[13px] outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
```

- [ ] **Step 7: ContextMenuLabel (line ~184)**

Change `text-sm` → `text-[13px]` (keeps `text-foreground font-medium`):

```tsx
      className={cn('text-foreground px-2 py-1.5 text-[13px] font-medium data-[inset]:pl-8', className)}
```

(`ContextMenuSeparator` already matches `Picker` — `-mx-1 my-1 h-px bg-border` — leave it unchanged.)

- [ ] **Step 8: Run context-menu-dependent suites**

Run: `pnpm --filter @memry/desktop test:renderer -- notes-tree virtualized-notes-tree kibo-ui medium-ui-surfaces zero-renderer-surfaces-extra`
Expected: PASS — these are structural tests; className-only changes don't affect them.

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/renderer/src/components/ui/context-menu.tsx
git commit -m "style(desktop): match right-click ContextMenu to Picker look"
```

---

## Task 6: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck**

Run: `pnpm --filter @memry/desktop typecheck:web`
Expected: PASS.

- [ ] **Step 2: Renderer tests**

Run: `pnpm --filter @memry/desktop test:renderer`
Expected: PASS (new `new-item-menu-items` test + updated `app-sidebar` test + all pre-existing renderer tests green).

- [ ] **Step 3: Lint**

Run (from repo root): `pnpm lint`
Expected: PASS — no unused imports left in `new-tab-menu.tsx` or `app-sidebar.tsx`; new code uses logical (`border-s`) Tailwind classes.

- [ ] **Step 4: i18n check**

Run: `pnpm --filter @memry/desktop i18n:check`
Expected: exit 0. The new `newItemMenu` key exists in English; the reused `componentsTabsNewTabMenu.*` keys remain used (no new orphans). Non-English locales may warn but do not fail.

- [ ] **Step 5: Whitespace check**

Run (from repo root): `git diff --check`
Expected: no output.

---

## Self-Review

**Spec coverage:**

- Sidebar split button → Task 4. ✓
- Tab "+" on Picker → Task 3. ✓
- Shared `NewItemMenuItems` on Picker → Task 2. ✓
- Context-menu restyle (shared primitive, app-wide) → Task 5. ✓
- New i18n key → Task 1. ✓
- Tests (new component test + sidebar case + keep suites green) → Tasks 2, 4, 5, 6. ✓
- Verify commands (`typecheck:web`, `test:renderer`, `lint`, `i18n:check`) → Task 6. ✓
- Out-of-scope items (no folder-logic change, dead `sidebar-item-context-menu.tsx` left alone, tab handlers/`groupId` preserved) → respected; no task touches them.

**Type consistency:** `NewItemActions` (`onNewNote`/`onJournal`/`onCalendar`/`onInbox`/`onTasks`) defined in Task 2 and consumed identically in Tasks 3 and 4. `NewItemMenuItems` props (`{ actions }`) consistent across all three. `Picker.Item` `value`/`label`/`icon`/`onClick` props match the component's real API. `openSidebarItem({ type, title, path })` matches the existing `SidebarItem` shape used by `handleNavClick`.

**Placeholder scan:** none — every code/className step shows the full content.
