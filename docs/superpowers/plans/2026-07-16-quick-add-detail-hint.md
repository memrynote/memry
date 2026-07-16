# Quick-Add "⌘↵ detail" Hint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a clickable `⌘↵ detail` hint in the quick-add task input while it's focused, so users discover (and can mouse-trigger) the existing Cmd/Ctrl+Enter path that opens the detailed add-task modal.

**Architecture:** Single-component change in `quick-add-input.tsx`. The existing Cmd+Enter branch's logic is extracted into an `openDetailModal` callback; the right-side slot that currently fades its "Q" pill to `opacity-0` on focus instead swaps to a real `<button>` hint when focused. One English i18n key is added. No new modal, parser, IPC, or data changes.

**Tech Stack:** React + TypeScript, Tailwind, `@memry/i18n` (`useT`), Vitest + Testing Library + `@testing-library/user-event`, existing `Kbd` component and `isMac` helper.

## Global Constraints

- Backward compatible — pure renderer UI change, no schema/contract/format impact.
- Logical Tailwind props only for any new direction-sensitive class (`ms-*`/` me-*`/`ps-*`/`pe-*`/`start-*`/`end-*`); symmetric props (`px-*`, `gap-*`, `border`, `rounded-[3px]`) are fine.
- i18n gate is English-only: add renderer keys to `packages/i18n/src/locales/en/tasks.json`.
- Modifier glyph display: `⌘` on macOS, `Ctrl` elsewhere, via `isMac` from `apps/desktop/src/renderer/src/lib/shortcut-registry.ts`.
- Copy is exactly `detail` (the word); keycap glyphs `⌘`/`Ctrl`/`↵` are not translated.
- Do not add `Co-Authored-By` trailers to commits.

---

### Task 1: Focused `⌘↵ detail` hint in QuickAddInput

**Files:**

- Modify: `packages/i18n/src/locales/en/tasks.json:526-529` (add `detailHint` key)
- Modify: `apps/desktop/src/renderer/src/components/tasks/quick-add-input.tsx` (add `isMac` import; extract `openDetailModal`; refactor Cmd+Enter branch; swap right-slot markup)
- Test: `apps/desktop/src/renderer/src/components/tasks/quick-add-input.test.tsx` (add hint tests)

**Interfaces:**

- Consumes (existing, unchanged signatures):
  - `QuickAddInputProps.onOpenModal?: (prefillTitle: string) => void`
  - `parseQuickAdd(input: string, projects: Project[]): { title: string; dueDate: Date | null; priority: Priority; projectId: string | null }`
  - `isMac: boolean` from `@/lib/shortcut-registry`
- Produces (new, internal to the component): `openDetailModal: () => void` — parses current input, calls `onOpenModal(parsed.title)`, clears the field, blurs. Used by both the Cmd+Enter keydown branch and the hint button's `onClick`.

- [ ] **Step 1: Add the i18n key**

In `packages/i18n/src/locales/en/tasks.json`, change the `componentsTasksQuickAddInput` block (lines 526-529) from:

```json
    "componentsTasksQuickAddInput": {
      "q": "Q",
      "q2": "Q"
    },
```

to:

```json
    "componentsTasksQuickAddInput": {
      "q": "Q",
      "q2": "Q",
      "detailHint": "detail"
    },
```

- [ ] **Step 2: Write the failing tests**

In `apps/desktop/src/renderer/src/components/tasks/quick-add-input.test.tsx`, add this block at the end of the file (after the last top-level `describe`). It reuses the file's existing `renderWithI18n`, `mockProjects`, and imports already at the top:

```tsx
// ============================================================================
// QuickAddInput - detail hint (focused state)
// ============================================================================

describe('QuickAddInput - detail hint', () => {
  const defaultProps = {
    onAdd: vi.fn(),
    onOpenModal: vi.fn(),
    projects: mockProjects
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows the "Q" affordance and no detail hint when not focused', () => {
    renderWithI18n(<QuickAddInput {...defaultProps} />)

    expect(screen.getByText('Q')).toBeInTheDocument()
    expect(screen.queryByText('detail')).not.toBeInTheDocument()
  })

  it('shows the detail hint when the input is focused', async () => {
    const user = userEvent.setup()
    renderWithI18n(<QuickAddInput {...defaultProps} />)

    const input = screen.getByRole('textbox', { name: /quick add task/i })
    await user.click(input)

    expect(screen.getByText('detail')).toBeInTheDocument()
    expect(screen.queryByText('Q')).not.toBeInTheDocument()
  })

  it('opens the detail modal with the parsed title when the hint is clicked', async () => {
    const user = userEvent.setup()
    renderWithI18n(<QuickAddInput {...defaultProps} />)

    const input = screen.getByRole('textbox', { name: /quick add task/i })
    await user.type(input, 'Buy groceries')
    await user.click(screen.getByText('detail'))

    expect(defaultProps.onOpenModal).toHaveBeenCalledWith('Buy groceries')
    expect(input).toHaveValue('')
  })

  it('does not render the hint when onOpenModal is absent', async () => {
    const user = userEvent.setup()
    renderWithI18n(<QuickAddInput onAdd={vi.fn()} projects={mockProjects} />)

    const input = screen.getByRole('textbox', { name: /quick add task/i })
    await user.click(input)

    expect(screen.queryByText('detail')).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 3: Run the new tests — verify they FAIL**

Run:

```bash
pnpm --filter @memry/desktop test:renderer -- quick-add-input --run
```

Expected: the three new "detail hint" tests that expect the hint FAIL (the hint doesn't render yet — `screen.getByText('detail')` throws "Unable to find an element"). The `not.toBeInTheDocument` cases may pass incidentally; the failures on the positive assertions are what matters.

- [ ] **Step 4: Add the `isMac` import**

In `apps/desktop/src/renderer/src/components/tasks/quick-add-input.tsx`, add the import next to the other `@/lib` / `@/hooks` imports near the top (after line 7, `useKeyboardShortcuts`):

```tsx
import { isMac } from '@/lib/shortcut-registry'
```

- [ ] **Step 5: Extract the `openDetailModal` callback**

In the same file, immediately after the `handleSubmit` `useCallback` (it ends at line 289 with `}, [value, projects, onAdd])`), insert:

```tsx
const openDetailModal = useCallback((): void => {
  if (!onOpenModal) return
  const parsed = parseQuickAdd(value.trim(), projects)
  onOpenModal(parsed.title)
  setValue('')
  inputRef.current?.blur()
}, [value, projects, onOpenModal])
```

- [ ] **Step 6: Route the Cmd+Enter branch through `openDetailModal`**

In `handleKeyDown`, replace the current Cmd/Ctrl+Enter branch:

```tsx
// Cmd/Ctrl+Enter opens modal
if ((e.metaKey || e.ctrlKey) && onOpenModal) {
  e.preventDefault()
  const trimmedValue = value.trim()
  const parsed = parseQuickAdd(trimmedValue, projects)
  onOpenModal(parsed.title)
  setValue('')
  inputRef.current?.blur()
  return
}
```

with:

```tsx
// Cmd/Ctrl+Enter opens the detail modal
if ((e.metaKey || e.ctrlKey) && onOpenModal) {
  e.preventDefault()
  openDetailModal()
  return
}
```

- [ ] **Step 7: Swap the right-side slot to show the hint when focused**

Replace the right-slot block (the `<div>` starting at line 485 with `className={cn('flex items-center ms-auto shrink-0 transition-opacity ...` through its closing `</div>` at line 502):

```tsx
<div
  className={cn(
    'flex items-center ms-auto shrink-0 transition-opacity duration-150',
    isFocused ? 'opacity-0 pointer-events-none' : 'opacity-100'
  )}
>
  {compact ? (
    <span className="rounded-[3px] px-1 bg-foreground/5 border border-border">
      <span className="text-[9px] text-text-tertiary font-[family-name:var(--font-mono)] font-medium leading-3">
        {tPhaseF('phaseF.componentsTasksQuickAddInput.q')}
      </span>
    </span>
  ) : (
    <Kbd className="px-1.5 py-px text-xs leading-4">
      {tPhaseF('phaseF.componentsTasksQuickAddInput.q2')}
    </Kbd>
  )}
</div>
```

with:

```tsx
<div className="flex items-center ms-auto shrink-0">
  {isFocused ? (
    onOpenModal ? (
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          e.stopPropagation()
          openDetailModal()
        }}
        className={cn(
          'flex items-center gap-1 text-text-tertiary hover:text-text-secondary transition-colors',
          compact ? 'text-[9px]' : 'text-xs'
        )}
      >
        <span
          className={cn(
            'inline-flex items-center gap-0.5 rounded-[3px] bg-foreground/5 border border-border font-[family-name:var(--font-mono)] font-medium',
            compact ? 'px-1 leading-3' : 'px-1.5 py-px leading-4'
          )}
        >
          {isMac ? '⌘' : 'Ctrl'} ↵
        </span>
        <span>{tPhaseF('phaseF.componentsTasksQuickAddInput.detailHint')}</span>
      </button>
    ) : null
  ) : compact ? (
    <span className="rounded-[3px] px-1 bg-foreground/5 border border-border">
      <span className="text-[9px] text-text-tertiary font-[family-name:var(--font-mono)] font-medium leading-3">
        {tPhaseF('phaseF.componentsTasksQuickAddInput.q')}
      </span>
    </span>
  ) : (
    <Kbd className="px-1.5 py-px text-xs leading-4">
      {tPhaseF('phaseF.componentsTasksQuickAddInput.q2')}
    </Kbd>
  )}
</div>
```

- [ ] **Step 8: Run the new tests — verify they PASS**

Run:

```bash
pnpm --filter @memry/desktop test:renderer -- quick-add-input --run
```

Expected: all tests in `quick-add-input.test.tsx` PASS, including the four new "detail hint" tests and the existing `should call onOpenModal on Cmd+Enter` test (now routed through `openDetailModal`).

- [ ] **Step 9: Run i18n + typecheck gates**

Run:

```bash
pnpm --filter @memry/desktop i18n:check
pnpm --filter @memry/desktop typecheck:web
```

Expected: both exit 0. `i18n:check` reports no missing English keys; `typecheck:web` reports no errors in `quick-add-input.tsx`.

- [ ] **Step 10: Commit**

```bash
git add \
  packages/i18n/src/locales/en/tasks.json \
  apps/desktop/src/renderer/src/components/tasks/quick-add-input.tsx \
  apps/desktop/src/renderer/src/components/tasks/quick-add-input.test.tsx
git commit -m "feat(tasks): add ⌘↵ detail hint to quick-add input"
```

---

## Manual Verification (after Task 1)

Run the desktop app (`pnpm dev`), open the Tasks page (the input renders in `compact` mode there):

1. Press `Q` (or click the input) → the "Q" pill is replaced by a `⌘ ↵ detail` hint.
2. Type a title, click the hint → the detailed add-task modal opens with the title prefilled; the input clears.
3. `Cmd+Enter` (macOS) / `Ctrl+Enter` (Win/Linux) still opens the same modal.
4. Blur the input (click elsewhere) → the hint is replaced by the "Q" pill again.

## Self-Review

- **Spec coverage:** Trigger-on-focus (Step 7 `isFocused` branch) ✓; copy `⌘↵ detail` (Step 7 keycap span + `detailHint`) ✓; `⌘`/`Ctrl` via `isMac` (Steps 4, 7) ✓; click → same path as Cmd+Enter (Steps 5-7, shared `openDetailModal`) ✓; focused-without-`onOpenModal` renders nothing (Step 7 `onOpenModal ? … : null`, Step 2 test 4) ✓; not-focused keeps "Q" (Step 7 else-branch, Step 2 test 1) ✓; i18n English-only key (Step 1) ✓; tests updated (Step 2) ✓.
- **Placeholder scan:** none — every code and command step is concrete.
- **Type consistency:** `openDetailModal` defined once (Step 5) and referenced by the same name in Steps 6 and 7; `isMac` boolean import (Step 4) used in Step 7; i18n path `phaseF.componentsTasksQuickAddInput.detailHint` matches the key added in Step 1.
