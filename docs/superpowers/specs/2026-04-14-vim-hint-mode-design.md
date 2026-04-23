# Vim-Style Hint Mode (F-key Navigation)

**Date:** 2026-04-14
**Status:** Approved

## Summary

Vimium-style keyboard hint navigation for the memry desktop app. Press `F` to overlay single/two-character labels on every clickable element, type the label to click it. Mnemonic-first label assignment ("I" for Inbox, "P" for Projects) with two-char fallback for conflicts.

## Goals

- Eliminate mouse dependency for all app navigation and actions
- Sub-second target acquisition via mnemonic labels
- Zero disruption to existing keyboard shortcut system
- Works with all interactive elements including dynamically rendered content (open dropdowns, expanded trees)

## Non-Goals

- Persistent/remembered shortcuts (labels are dynamic per activation)
- Hint mode inside right-click context menus
- Customizable badge colors/positions (future iteration)
- Multi-click mode (one activation = one click)

## Activation

| Trigger | Context | Behavior |
|---------|---------|----------|
| `F` | Focus on app chrome (sidebar, tabs, content area — not editor) | Enter hint mode |
| `Alt+F` | Anywhere, including inside editor | Enter hint mode |
| `Escape` | Inside editor | Blur editor → focus returns to app chrome → `F` now available |
| `Escape` | Hint mode active | Cancel hint mode, no click |
| `Backspace` | Hint mode active, chars typed | Undo last typed character, re-expand visible hints |

After a hint is matched and the target clicked, hint mode auto-deactivates.

## Architecture

### Component Breakdown

```
HintModeProvider (React Context)
├── State: isActive, hints[], typedChars, matchedHint
├── Actions: activate(), deactivate(), typeChar(), backspace()
│
├── useHintActivation (hook)
│   F / Alt+F / Esc key listeners
│   Suspends other shortcut handlers while active
│
├── useHintMode (hook)
│   Orchestrates: scanDOM() → assignLabels() → match input → click target
│
├── HintOverlay (React portal)
│   Renders positioned badges via createPortal at document.body
│
└── Pure functions
    ├── domScanner.ts — querySelectorAll + visibility filters
    └── labelAssigner.ts — mnemonic-first label algorithm
```

### File Structure

```
src/renderer/src/
├── contexts/
│   └── hint-mode/
│       ├── context.tsx           — HintModeProvider + React context
│       └── types.ts              — Hint, HintModeState interfaces
├── hooks/
│   ├── use-hint-mode.ts          — DOM scan + label assign + match logic
│   └── use-hint-activation.ts    — F / Alt+F / Esc key listeners
├── components/
│   └── hint-overlay/
│       ├── hint-overlay.tsx       — Portal with positioned badges
│       └── hint-badge.tsx         — Individual badge component
└── lib/
    ├── dom-scanner.ts             — querySelectorAll + visibility filters
    └── label-assigner.ts          — mnemonic-first label algorithm
```

## DOM Scanner

### Selector

```css
button,
a[href],
[role="button"],
[role="tab"],
[role="treeitem"],
[role="menuitem"],
[role="option"],
[tabindex]:not([tabindex="-1"]),
[data-hint]
```

### Filters (all must pass)

- `offsetParent !== null` (visible in layout)
- `getBoundingClientRect()` intersects viewport
- Not `[disabled]` or `[aria-disabled="true"]`
- Not inside the hint overlay element itself
- Min bounding box: 8x8 px
- Not `pointer-events: none`

### `data-hint` Escape Hatch

Any element with `data-hint` is included in scans regardless of tag/role. This allows opting-in custom interactive elements that don't match the selector list.

## Label Assignment Algorithm

```
Input: HTMLElement[]
Output: { element, label, rect }[]

1. Extract display text for each element:
   - textContent (trimmed, first word preferred)
   - aria-label
   - title attribute
   - Fallback: empty string

2. Attempt mnemonic assignment:
   a. For each element, candidate = first letter of text (uppercased)
   b. Group elements by candidate letter
   c. Groups of size 1 → assign single-char label
   d. Groups of size 2+ → conflict resolution:
      - Try first + second letter of text (e.g., "TA" for Tags, "TS" for Tasks)
      - If second letter also conflicts or text too short → sequential two-char code

3. Elements with no text → sequential two-char codes from available pool

4. Two-char pool: AA, AB, AC... AZ, BA, BB... (skip codes that are prefixes
   of or prefixed by assigned single-char labels — e.g., if "I" is assigned,
   skip "IA", "IB"... to avoid prefix ambiguity)

5. Sort output by DOM position (document order)
```

**Case insensitive**: user can type `t` or `T` to match label `T`.

## Badge Visual Design

- **Background**: `#f59e0b` (amber) — high contrast on both light/dark themes
- **Text**: `#000000`, `font-weight: 700`, `11px`, monospace (SF Mono / Fira Code / system monospace)
- **Shape**: `3px` border radius, `1px 5px` padding
- **Position**: top-left corner of element, offset `-6px` both axes
- **Shadow**: `0 1px 3px rgba(0,0,0,0.4)` for depth
- **Z-index**: above all app content, below Electron title bar

### Narrowing Feedback

- **Non-matching hints**: fade to `opacity: 0.3`, their target elements also dim
- **Matched characters**: within remaining badges, already-typed chars render at `opacity: 0.4`
- **Transitions**: `opacity 100ms ease` for smooth narrowing

## Status Indicator

When hint mode is active, show a small indicator (similar to the existing chord indicator in `chord-indicator.tsx`):
- Text: "HINT" or the currently typed characters
- Position: bottom-center or wherever the chord indicator appears
- Disappears on deactivate

## Integration with Existing Shortcuts

### Suspension

On activation, hint mode sets a flag that `useKeyboardShortcutsBase` checks. While `true`, all registered shortcuts skip execution. This is cleaner than unregistering/re-registering listeners.

Implementation: export a module-level `{ current: boolean }` ref (e.g., `hintModeActiveRef`) from the hint-mode context module. The base keyboard hook imports and checks `hintModeActiveRef.current` in its `handleKeyDown` — no React context dependency needed, works synchronously in the event handler.

### No Conflicts

- Hint mode does not register in `shortcut-registry.ts` — it's a parallel modal system
- `⌘K`/`⌘P` (command palette): if palette is open, `F` is consumed by cmdk input. If hint mode is active, modifier shortcuts are suppressed anyway.
- Chord shortcuts (`⌘K` sequences): suppressed during hint mode like all other shortcuts

### Escape Priority Chain

```
1. Hint mode active        → deactivate hint mode
2. Editor focused          → blur editor
3. Dropdown/popover open   → close it (existing Radix behavior)
4. Default                 → no-op
```

Hint mode takes highest priority for Escape when active.

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Collapsed sidebar | Only visible elements get hints; sidebar items excluded |
| Scrolled-off elements | Not in viewport → no hint |
| Open dropdown/popover | Menu items included in scan (they're visible DOM) |
| Disabled elements | Excluded by filter |
| Icon-only buttons | Text from `aria-label` / `title`; if none, sequential code |
| Non-ASCII element text | Skip mnemonic, sequential two-char code |
| Single visible element | Single-char label, immediate match on first keystroke |
| Zero clickable elements | Hint mode activates then immediately deactivates (no-op) |
| Rapid F-F toggle | Deactivate if already active (toggle behavior) |
| Element removed during hint mode | Stale hint → click is no-op, mode still exits |
| Window resize during hint mode | Positions are stale but mode is transient (~1-2s), acceptable |

## Testing Strategy

### Unit Tests (lib/)
- `domScanner.ts`: mock DOM with various element types, verify correct inclusion/exclusion
- `labelAssigner.ts`: test mnemonic assignment, conflict resolution, prefix avoidance, edge cases (empty text, non-ASCII, single element)

### Hook Tests
- `useHintMode`: activation/deactivation state transitions, typing flow, backspace, match detection
- `useHintActivation`: F key in various focus contexts, Alt+F from editor, Escape behavior chain

### Integration Tests
- Full flow: activate → type label → verify element clicked → mode deactivated
- Narrowing: type partial → verify correct hints visible/dimmed
- Cancellation: activate → Escape → verify clean state
- Editor escape flow: focus editor → Escape → F → hints appear

### E2E Tests
- Activate hint mode in running app, verify badge overlay renders
- Click a sidebar item via hint, verify navigation occurred
- Verify hint mode doesn't interfere with normal typing in editor
