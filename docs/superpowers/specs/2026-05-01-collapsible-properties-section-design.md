# Collapsible Properties Section in Note & Journal

**Date:** 2026-05-01
**Status:** Draft

## Summary

Notes and journals currently render their properties panel always-expanded between the tags row and the content area. On property-heavy notes the panel pushes the writing surface down; during focused writing it adds visual noise. The `InfoSection` component already supports a collapse toggle via `InfoHeader` (chevron + title + count + terracotta accent), but `note.tsx` and `journal.tsx` opt into `variant="inline"`, which deliberately suppresses that header. This change switches both pages to `variant="embedded"`, wires a per-note collapse toggle persisted in `localStorage`, and lets the existing add-property affordance auto-expand the section on use.

## Goals

- Let users hide the properties panel on heavy notes to reclaim vertical space
- Give writers a quick, discoverable way to dismiss properties while drafting
- Keep the affordance visible (no hover-only) so collapse is obvious to first-time users
- Preserve current first-impression — default state stays expanded
- Persist collapse state per note so the choice is sticky between sessions

## Non-Goals

- Keyboard shortcut for toggle (deferred — Approach 2 path; revisit if users miss it)
- Cross-device sync of collapse state (intentionally device-local)
- Bulk "collapse all" action or global default in settings
- Changes to the template editor's properties section (templates always show all properties for authoring)
- Changes to `InfoSection.tsx` or `InfoHeader.tsx` internals — embedded variant is already complete

## Architecture

### Component Breakdown

```
note.tsx / journal.tsx
└── InfoSection (variant="embedded")  ← changed from "inline"
    ├── InfoHeader                     ← now visible (was suppressed by inline variant)
    │   ├── chevron (rotates on toggle)
    │   ├── "Properties"
    │   └── count badge
    └── Properties list (when expanded)
        └── PropertyRow[]

usePropertiesCollapsed(noteId)         ← new hook
└── reads/writes localStorage key `memry:properties-collapsed:${noteId}`
```

### File Changes

```
apps/desktop/src/renderer/src/
├── hooks/
│   └── use-properties-collapsed.ts    — NEW: hook, ~30 lines
├── pages/
│   ├── note.tsx                        — MODIFIED: ~L1010-1023, ~10 lines diff
│   └── journal.tsx                     — MODIFIED: ~L748-761, ~10 lines diff
└── components/note/info-section/
    ├── InfoSection.tsx                 — UNCHANGED
    └── InfoHeader.tsx                  — UNCHANGED
```

`apps/desktop/src/renderer/src/pages/template-editor.tsx` is intentionally unchanged — keeps `isExpanded={true}` and `onToggleExpand={() => {}}`.

## Behavior

### Default state

- First open of a note or journal entry: properties **expanded** (matches today's behavior)
- Section only renders when `properties.length > 0` (existing guard preserved)

### Toggle

- User clicks `InfoHeader` (chevron + "Properties" + count) → state flips
- Collapsed: only the header row visible; property rows hidden
- Expanded: header + property rows visible
- Visual treatment uses the existing `embedded` variant styling (terracotta accent bar when expanded, chevron rotation, count badge color shift)

### Persistence

- State persisted per-note in `localStorage` under key `memry:properties-collapsed:${noteId}`
- **Storage representation:** when collapsed, the key holds the string `"1"`. When expanded, the key is **removed** (no `"0"` / `"false"` written). Absent key = expanded (the default).
- Lost on uninstall / cleared site data — acceptable since expanded is the safe default
- Intentionally **not** synced across devices: collapse is a viewing preference, not document state. Different devices can hold different states (e.g., laptop expanded, phone collapsed)

### Add property while collapsed

- `GhostAffordanceRow` continues to own the "+ Add property" affordance (its current role)
- When the user adds a property while the section is collapsed, the section auto-expands so the new row is visible and focusable
- Implemented by calling `setCollapsed(false)` (or equivalent) inside the existing add-property handler in `note.tsx` / `journal.tsx`, immediately before the existing `onAddProperty` invocation
- Existing `newlyAddedPropertyId` flow continues to scroll the new row into view and focus it; no change there

### Read-only / deleted notes

- Chevron toggle remains functional even when the note is deleted (`disabled={isDeleted}` on `InfoSection` only disables editing, not the header click). Viewing preference is independent of edit lock.

## Hook Contract

```ts
// apps/desktop/src/renderer/src/hooks/use-properties-collapsed.ts

/**
 * Per-note collapse state for the properties panel.
 * Backed by localStorage. Device-local by design.
 *
 * @param noteId Stable id of the note or journal entry
 * @returns [isCollapsed, toggle, setCollapsed]
 */
export function usePropertiesCollapsed(
  noteId: string
): readonly [boolean, () => void, (next: boolean) => void]
```

Implementation notes:
- Initial state read lazily inside `useState` initializer (one localStorage hit per mount)
- `toggle` flips and writes immediately
- `setCollapsed(next)` lets the add-property handler force-expand without reading current state
- Logger: `createLogger('PropertiesCollapsed')` for any read/write failures (catches `QuotaExceededError`, disabled storage, etc.)
- Errors swallowed gracefully — failed persistence falls back to in-memory only state, never throws to the UI

## Wiring Diff (illustrative)

`note.tsx` ~L1010-1023:
```tsx
// before
<InfoSection
  properties={properties}
  newlyAddedPropertyId={newlyAddedPropertyId}
  isExpanded
  onToggleExpand={() => {}}
  ...
  variant="inline"
  hideAddButton
/>

// after
const [propertiesCollapsed, togglePropertiesCollapsed, setPropertiesCollapsed] =
  usePropertiesCollapsed(noteId)

<InfoSection
  properties={properties}
  newlyAddedPropertyId={newlyAddedPropertyId}
  isExpanded={!propertiesCollapsed}
  onToggleExpand={togglePropertiesCollapsed}
  ...
  variant="embedded"
  hideAddButton
/>
```

The add-property handler (existing `handleAddProperty` in `note.tsx`) gains one line:
```tsx
const handleAddProperty = useCallback((newProp: NewProperty) => {
  setPropertiesCollapsed(false)   // auto-expand
  onAddProperty(newProp)
}, [onAddProperty, setPropertiesCollapsed])
```

`journal.tsx` mirrors the same change at L748-761 and its own add handler.

## Edge Cases

- **noteId not yet available** (initial render before route param resolves): hook receives `undefined` or empty string → no localStorage read, returns `[false, noop, noop]`. Section renders expanded. Once noteId is available, hook re-evaluates.
- **localStorage disabled / private mode**: hook catches and logs; falls back to in-memory state for the session. Collapse still works during the session, just doesn't persist.
- **Quota exceeded**: same — log, swallow, in-memory fallback.
- **Multiple windows on the same note**: each window holds its own React state; localStorage is the source of truth on next mount. No live sync between open windows (acceptable for v1).
- **Properties dropping to zero** (user deletes all): `InfoSection` stops rendering due to existing `properties.length > 0` guard. Stored collapse state remains in localStorage and applies again if properties are re-added.
- **GhostAffordanceRow visibility**: stays unchanged. It sits below the (collapsed or expanded) properties section, always reachable.

## Testing

### Unit

`apps/desktop/src/renderer/src/hooks/use-properties-collapsed.test.ts`
- Returns `false` (expanded) for an unknown noteId (key absent)
- Returns `true` (collapsed) when localStorage holds `"1"` for the noteId
- `toggle()` flips the value: collapsed → writes `"1"`; expanded → removes the key
- `setCollapsed(false)` removes the key
- `setCollapsed(true)` writes `"1"`
- Different `noteId` values keep state isolated
- Throws inside `localStorage.setItem` / `removeItem` are caught (mock to throw `QuotaExceededError`); hook still returns the requested in-memory state

### Integration

Extend `apps/desktop/src/renderer/src/components/note/info-section/info-section.test.tsx`
- Renders `embedded` variant: chevron + "Properties" + count visible
- Click chevron → property rows unmount; chevron rotates; count remains
- Click again → property rows return
- Count badge accurate when collapsed

### E2E (Playwright)

Extend the existing note / journal E2E suites:
- Open note with ≥1 property → click chevron → assert property rows hidden
- Reload page → assert property rows still hidden (persistence)
- Click chevron → property rows visible → reload → still visible
- Open second note with ≥1 property → assert default expanded (state is per-note)
- Add property while collapsed → section auto-expands → new row focused

## Migration & Rollout

- No DB migration
- No CRDT changes
- No feature flag — change is small enough to ship directly
- Pre-production app per project notes; no backward-compat concern for stored localStorage values

## Open Questions

None. Persistence model and add-property auto-expand both confirmed during brainstorming.
