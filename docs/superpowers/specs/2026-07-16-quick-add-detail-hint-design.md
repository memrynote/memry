# Quick-Add "⌘↵ detail" Hint — Design

Date: 2026-07-16
Component: `apps/desktop/src/renderer/src/components/tasks/quick-add-input.tsx`

## Problem

The tasks-page quick-add input already opens the detailed add-task modal on
`Cmd/Ctrl+Enter` (`quick-add-input.tsx:322`, wired to `handleOpenAddTaskModal`
in `tasks.tsx:929`). Nothing tells the user this exists. Worse, the only visible
affordance — the "Q" pill on the right — fades to `opacity-0` the moment the
input is focused, so as soon as you engage the field you lose all hinting.

This is a **discoverability** gap, not a missing feature.

## Goal

When the quick-add input is focused, show a clickable **`⌘↵ detail`** hint in the
same right-side slot. Clicking it (or pressing the shortcut) opens the detailed
add-task modal, prefilled with the current parsed title.

## Decisions (locked with owner)

- **Trigger:** on focus. The hint appears the moment the input is focused — e.g.
  immediately after pressing `Q` — not only after typing begins.
- **Copy:** `⌘↵ detail` (keycaps + single word "detail"). Most compact; fits the
  small pill used on the tasks page.

## Scope

- Single component: `quick-add-input.tsx`, the right-side slot (`:485–502`).
- One i18n key added to `packages/i18n/src/locales/en/tasks.json`.
- Tests updated in `quick-add-input.test.tsx`.

Explicitly **out of scope**: any change to the add-task modal itself, the
quick-add parser, IPC/data, keyboard navigation, or the `Cmd+Enter` behavior's
semantics (it keeps working exactly as today).

## Behavior

Right-side slot, by state:

| State                                  | Renders                                 |
| -------------------------------------- | --------------------------------------- |
| Not focused                            | "Q" pill / `Kbd` — unchanged from today |
| Focused **and** `onOpenModal` provided | clickable `⌘↵ detail` hint              |
| Focused, `onOpenModal` absent          | nothing (matches today's fade-out)      |

- Modifier glyph: `⌘` on macOS, `Ctrl` elsewhere, via the existing `isMac`
  export in `apps/desktop/src/renderer/src/lib/shortcut-registry.ts:28`.
- Return glyph: `↵`.
- "detail" is localized.
- Clicking the hint runs the same code path as `Cmd/Ctrl+Enter`: parse the
  current input, call `onOpenModal(parsed.title)`, clear the field, blur.

## Implementation

1. **Extract `openDetailModal` callback.** Pull the body of the existing
   `Cmd/Ctrl+Enter` branch (`:322–330`) into a `useCallback`:

   ```ts
   const openDetailModal = useCallback((): void => {
     if (!onOpenModal) return
     const parsed = parseQuickAdd(value.trim(), projects)
     onOpenModal(parsed.title)
     setValue('')
     inputRef.current?.blur()
   }, [value, projects, onOpenModal])
   ```

   The keydown handler's `Cmd+Enter` branch calls `openDetailModal()` instead of
   duplicating the logic.

2. **Right-slot conditional.** Replace the current single-branch markup (which
   toggles `opacity-0` on focus) with:
   - `!isFocused` → existing Q pill (compact) / `Kbd` (full).
   - `isFocused && onOpenModal` → the `⌘↵ detail` button.
   - otherwise → nothing.

3. **Button + focus-race guard.** The hint is a real
   `<button type="button">` with:
   - `onMouseDown={(e) => e.preventDefault()}` — keeps the input focused so the
     button stays mounted through the click (the `handleBlur` 150 ms timeout
     would otherwise unmount it mid-click).
   - `onClick={(e) => { e.stopPropagation(); openDetailModal() }}` —
     `stopPropagation` prevents the container's `handleContainerClick` from
     re-focusing/interfering.

4. **Styling.** Narrow pill matching the Q pill's visual weight in `compact`
   mode (the variant the tasks page uses); `Kbd`-style keycaps in the full
   variant. Use logical Tailwind props (`ps-*`/`pe-*`/`ms-*`, `gap-*`) for RTL
   safety per project convention.

5. **i18n.** Add to `packages/i18n/src/locales/en/tasks.json` under
   `phaseF.componentsTasksQuickAddInput`:
   ```json
   "detailHint": "detail"
   ```
   English-only gate (`pnpm --filter @memry/desktop i18n:check`). Keycap glyphs
   (`⌘`/`Ctrl`/`↵`) are not translated.

## Testing

Extend `apps/desktop/src/renderer/src/components/tasks/quick-add-input.test.tsx`:

- Focusing the input renders the `detail` hint; blurring hides it and restores
  the "Q" affordance.
- Clicking the hint calls `onOpenModal` with the parsed title (mirrors the
  existing `Cmd+Enter` assertion at `:166`).
- The existing `Cmd+Enter → onOpenModal` test must remain green (shared
  `openDetailModal` path).

## Verification

- `pnpm --filter @memry/desktop test:renderer` (targeted: quick-add-input)
- `pnpm --filter @memry/desktop i18n:check`
- `pnpm typecheck`
- Manual: tasks page → focus input (or press `Q`) → hint visible → click opens
  the detailed add-task modal with the typed title prefilled; `Cmd+Enter` still
  opens it.
