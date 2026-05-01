# Collapsible Properties Section Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the existing `InfoHeader` collapse toggle in note and journal pages so users can hide the properties panel, with state persisted per-note in localStorage and an auto-expand on add-property.

**Architecture:** Switch `InfoSection` from `variant="inline"` to `variant="embedded"` in both consumer pages, drive `isExpanded` from a new `usePropertiesCollapsed(noteId)` hook that reads/writes `localStorage[memry:properties-collapsed:${noteId}]`, and wrap the existing `handleAddProperty` with an auto-expand step at the call site (must wrap both the `InfoSection` and `GhostAffordanceRow` props since `hideAddButton` routes adds through the ghost row).

**Tech Stack:** React 19, TypeScript, Electron 39 renderer, Vitest (unit), Playwright (E2E against built bundle in `out/`), pnpm + turbo monorepo.

**Spec:** `docs/superpowers/specs/2026-05-01-collapsible-properties-section-design.md`

---

## Pre-Task Setup

- [ ] **Step 0.1: Create a worktree for this work**

Per project preference, implement plan changes in a git worktree, not directly on `main`.

```bash
git worktree add ../memry-collapsible-props -b feat/collapsible-properties-section
cd ../memry-collapsible-props
pnpm install
```

Expected: New worktree at sibling path, branch `feat/collapsible-properties-section` checked out, deps installed.

- [ ] **Step 0.2: Verify baseline tests pass before any changes**

```bash
pnpm typecheck:node && pnpm typecheck:web
pnpm test --filter=desktop
```

Expected: Typecheck passes (the desktop typecheck has known failures in test files like `websocket.test.ts`, `folders.test.ts`, `sync-telemetry.ts` per project notes — that's fine, but no NEW failures should appear). Vitest run completes with all tests green.

---

## Task 1: Create `usePropertiesCollapsed` hook (TDD)

**Files:**
- Create: `apps/desktop/src/renderer/src/hooks/use-properties-collapsed.ts`
- Test: `apps/desktop/src/renderer/src/hooks/use-properties-collapsed.test.ts`

- [ ] **Step 1.1: Write the failing test**

Create `apps/desktop/src/renderer/src/hooks/use-properties-collapsed.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { usePropertiesCollapsed } from './use-properties-collapsed'

describe('usePropertiesCollapsed', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('returns false (expanded) when no key is stored', () => {
    const { result } = renderHook(() => usePropertiesCollapsed('note-1'))
    expect(result.current[0]).toBe(false)
  })

  it('returns true (collapsed) when localStorage holds "1" for the noteId', () => {
    localStorage.setItem('memry:properties-collapsed:note-1', '1')
    const { result } = renderHook(() => usePropertiesCollapsed('note-1'))
    expect(result.current[0]).toBe(true)
  })

  it('toggle() flips expanded → collapsed and writes "1"', () => {
    const { result } = renderHook(() => usePropertiesCollapsed('note-1'))
    act(() => {
      result.current[1]() // toggle
    })
    expect(result.current[0]).toBe(true)
    expect(localStorage.getItem('memry:properties-collapsed:note-1')).toBe('1')
  })

  it('toggle() flips collapsed → expanded and removes the key', () => {
    localStorage.setItem('memry:properties-collapsed:note-1', '1')
    const { result } = renderHook(() => usePropertiesCollapsed('note-1'))
    act(() => {
      result.current[1]() // toggle
    })
    expect(result.current[0]).toBe(false)
    expect(localStorage.getItem('memry:properties-collapsed:note-1')).toBeNull()
  })

  it('setCollapsed(true) writes "1"', () => {
    const { result } = renderHook(() => usePropertiesCollapsed('note-1'))
    act(() => {
      result.current[2](true)
    })
    expect(result.current[0]).toBe(true)
    expect(localStorage.getItem('memry:properties-collapsed:note-1')).toBe('1')
  })

  it('setCollapsed(false) removes the key', () => {
    localStorage.setItem('memry:properties-collapsed:note-1', '1')
    const { result } = renderHook(() => usePropertiesCollapsed('note-1'))
    act(() => {
      result.current[2](false)
    })
    expect(result.current[0]).toBe(false)
    expect(localStorage.getItem('memry:properties-collapsed:note-1')).toBeNull()
  })

  it('different noteIds keep state isolated', () => {
    localStorage.setItem('memry:properties-collapsed:note-A', '1')
    const { result: resultA } = renderHook(() => usePropertiesCollapsed('note-A'))
    const { result: resultB } = renderHook(() => usePropertiesCollapsed('note-B'))
    expect(resultA.current[0]).toBe(true)
    expect(resultB.current[0]).toBe(false)
  })

  it('returns expanded with no-op handlers when noteId is empty', () => {
    const { result } = renderHook(() => usePropertiesCollapsed(''))
    expect(result.current[0]).toBe(false)
    act(() => {
      result.current[1]()
      result.current[2](true)
    })
    expect(localStorage.length).toBe(0)
  })

  it('catches QuotaExceededError on setItem and falls back to in-memory state', () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError')
    })
    const { result } = renderHook(() => usePropertiesCollapsed('note-1'))
    act(() => {
      result.current[2](true)
    })
    expect(result.current[0]).toBe(true) // in-memory still updated
    setItemSpy.mockRestore()
  })

  it('catches errors on removeItem and falls back to in-memory state', () => {
    localStorage.setItem('memry:properties-collapsed:note-1', '1')
    const removeItemSpy = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('removal failed')
    })
    const { result } = renderHook(() => usePropertiesCollapsed('note-1'))
    act(() => {
      result.current[2](false)
    })
    expect(result.current[0]).toBe(false) // in-memory still updated
    removeItemSpy.mockRestore()
  })
})
```

- [ ] **Step 1.2: Run the test and verify it fails**

```bash
pnpm --filter=desktop test -- use-properties-collapsed
```

Expected: FAIL with "Cannot find module './use-properties-collapsed'" (file doesn't exist yet).

- [ ] **Step 1.3: Implement the hook**

Create `apps/desktop/src/renderer/src/hooks/use-properties-collapsed.ts`:

```ts
import { useCallback, useState } from 'react'
import { createLogger } from '@/lib/logger'

const log = createLogger('PropertiesCollapsed')

const STORAGE_PREFIX = 'memry:properties-collapsed:'
const COLLAPSED_VALUE = '1'

const storageKey = (noteId: string): string => `${STORAGE_PREFIX}${noteId}`

const readInitial = (noteId: string): boolean => {
  if (!noteId) return false
  try {
    return localStorage.getItem(storageKey(noteId)) === COLLAPSED_VALUE
  } catch (error) {
    log.warn('Failed to read collapse state from localStorage', error)
    return false
  }
}

const persist = (noteId: string, collapsed: boolean): void => {
  if (!noteId) return
  try {
    if (collapsed) {
      localStorage.setItem(storageKey(noteId), COLLAPSED_VALUE)
    } else {
      localStorage.removeItem(storageKey(noteId))
    }
  } catch (error) {
    log.warn('Failed to persist collapse state to localStorage', error)
  }
}

/**
 * Per-note collapse state for the properties panel.
 * Backed by localStorage. Device-local by design.
 *
 * @param noteId Stable id of the note or journal entry. Empty string disables persistence.
 * @returns [isCollapsed, toggle, setCollapsed]
 */
export function usePropertiesCollapsed(
  noteId: string
): readonly [boolean, () => void, (next: boolean) => void] {
  const [isCollapsed, setState] = useState<boolean>(() => readInitial(noteId))

  const setCollapsed = useCallback(
    (next: boolean) => {
      setState(next)
      persist(noteId, next)
    },
    [noteId]
  )

  const toggle = useCallback(() => {
    setState((prev) => {
      const next = !prev
      persist(noteId, next)
      return next
    })
  }, [noteId])

  return [isCollapsed, toggle, setCollapsed] as const
}
```

- [ ] **Step 1.4: Run the test and verify it passes**

```bash
pnpm --filter=desktop test -- use-properties-collapsed
```

Expected: PASS — all 10 test cases green.

- [ ] **Step 1.5: Commit**

```bash
git add apps/desktop/src/renderer/src/hooks/use-properties-collapsed.ts apps/desktop/src/renderer/src/hooks/use-properties-collapsed.test.ts
git commit -m "feat: add usePropertiesCollapsed hook for per-note panel state"
```

---

## Task 2: Wire hook into `note.tsx`

**Files:**
- Modify: `apps/desktop/src/renderer/src/pages/note.tsx` (import area, hook call site, ~L1010-1023, GhostAffordanceRow at ~L1027-1036)

**Background:** `handleAddProperty` is destructured from `usePropertySection` (note.tsx ~L178). Don't try to modify that hook; instead create a local `handleAddPropertyWithExpand` that calls `setPropertiesCollapsed(false)` then forwards to `handleAddProperty`. Pass the new handler to BOTH `InfoSection` AND `GhostAffordanceRow` because `hideAddButton` routes the actual add through the ghost row.

- [ ] **Step 2.1: Add the import**

Open `apps/desktop/src/renderer/src/pages/note.tsx`. Find the existing hook imports near the top (around the other `use-*` imports). Add:

```ts
import { usePropertiesCollapsed } from '@/hooks/use-properties-collapsed'
```

- [ ] **Step 2.2: Call the hook near the other hooks**

Find the block where `handleAddProperty` is destructured from `usePropertySection` (around line 178). Immediately after that block, add:

```ts
const [propertiesCollapsed, togglePropertiesCollapsed, setPropertiesCollapsed] =
  usePropertiesCollapsed(noteId ?? '')

const handleAddPropertyWithExpand = useCallback(
  (newProp: NewProperty) => {
    setPropertiesCollapsed(false)
    handleAddProperty(newProp)
  },
  [handleAddProperty, setPropertiesCollapsed]
)
```

If `NewProperty` is not already imported in this file, also add it to the existing `@/components/note/info-section` import line (where `InfoSection` is imported from). Check the existing import — if it's `import { InfoSection } from '@/components/note/info-section'`, change to `import { InfoSection, type NewProperty } from '@/components/note/info-section'`.

- [ ] **Step 2.3: Update the `InfoSection` props (~L1010-1023)**

Find the existing `<InfoSection>` block:

```tsx
<InfoSection
  properties={properties}
  newlyAddedPropertyId={newlyAddedPropertyId}
  isExpanded
  onToggleExpand={() => {}}
  onPropertyChange={handlePropertyChange}
  onPropertyNameChange={handlePropertyNameChange}
  onPropertyOrderChange={handlePropertyOrderChange}
  onAddProperty={handleAddProperty}
  onDeleteProperty={handleDeleteProperty}
  disabled={isDeleted}
  variant="inline"
  hideAddButton
/>
```

Replace with:

```tsx
<InfoSection
  properties={properties}
  newlyAddedPropertyId={newlyAddedPropertyId}
  isExpanded={!propertiesCollapsed}
  onToggleExpand={togglePropertiesCollapsed}
  onPropertyChange={handlePropertyChange}
  onPropertyNameChange={handlePropertyNameChange}
  onPropertyOrderChange={handlePropertyOrderChange}
  onAddProperty={handleAddPropertyWithExpand}
  onDeleteProperty={handleDeleteProperty}
  disabled={isDeleted}
  variant="embedded"
  hideAddButton
/>
```

- [ ] **Step 2.4: Update `GhostAffordanceRow`'s `onAddProperty` (~L1027-1036)**

Find the existing block right after the `InfoSection`:

```tsx
<GhostAffordanceRow
  availableTags={availableTags}
  recentTags={recentTags}
  currentTagIds={noteTags.map((t) => t.id)}
  onAddTag={handleAddTag}
  onCreateTag={handleCreateTag}
  onAddProperty={handleAddProperty}
  hasTags={noteTags.length > 0}
  disabled={isDeleted}
/>
```

Change `onAddProperty={handleAddProperty}` to `onAddProperty={handleAddPropertyWithExpand}`. Final block:

```tsx
<GhostAffordanceRow
  availableTags={availableTags}
  recentTags={recentTags}
  currentTagIds={noteTags.map((t) => t.id)}
  onAddTag={handleAddTag}
  onCreateTag={handleCreateTag}
  onAddProperty={handleAddPropertyWithExpand}
  hasTags={noteTags.length > 0}
  disabled={isDeleted}
/>
```

- [ ] **Step 2.5: Typecheck**

```bash
pnpm typecheck:node && pnpm typecheck:web
```

Expected: No new errors. Pre-existing failures in test files (`websocket.test.ts`, `folders.test.ts`, `sync-telemetry.ts`) per project notes are acceptable.

- [ ] **Step 2.6: Smoke test in dev**

```bash
pnpm dev
```

Manually verify in the running app:
1. Open a note that has at least one property
2. The "Properties" header (chevron + count + terracotta accent) is visible above the property rows
3. Click the chevron — property rows hide
4. Click again — they reappear
5. Reload the app or close/reopen the note — collapse state persists
6. With section collapsed, click "+ Add property" from the ghost affordance row — section auto-expands and the new row is focused

Stop dev server when done.

- [ ] **Step 2.7: Commit**

```bash
git add apps/desktop/src/renderer/src/pages/note.tsx
git commit -m "feat: collapsible properties section in note page"
```

---

## Task 3: Wire hook into `journal.tsx`

**Files:**
- Modify: `apps/desktop/src/renderer/src/pages/journal.tsx` (import area, hook call site near L373, ~L748-761, GhostAffordanceRow at ~L762-770)

**Background:** Same pattern as Task 2. Note that `handleAddProperty` here comes from `usePropertySection({ entityId: entry?.id ?? null, ... })`, so the noteId for the hook is `entry?.id ?? ''`. The `disabled` prop is not present on this `InfoSection` call (journal doesn't have an `isDeleted` concept the same way) — leave the `disabled` prop alone.

- [ ] **Step 3.1: Add the import**

Open `apps/desktop/src/renderer/src/pages/journal.tsx`. Add to existing imports:

```ts
import { usePropertiesCollapsed } from '@/hooks/use-properties-collapsed'
```

If `NewProperty` is not already imported, add `type NewProperty` to the existing import from `@/components/note/info-section`.

- [ ] **Step 3.2: Call the hook near the existing `usePropertySection` block (~L373)**

Immediately after the `usePropertySection` destructure block, add:

```ts
const [propertiesCollapsed, togglePropertiesCollapsed, setPropertiesCollapsed] =
  usePropertiesCollapsed(entry?.id ?? '')

const handleAddPropertyWithExpand = useCallback(
  (newProp: NewProperty) => {
    setPropertiesCollapsed(false)
    handleAddProperty(newProp)
  },
  [handleAddProperty, setPropertiesCollapsed]
)
```

- [ ] **Step 3.3: Update the `InfoSection` props (~L748-761)**

Find the existing block:

```tsx
<InfoSection
  properties={properties}
  newlyAddedPropertyId={newlyAddedPropertyId}
  isExpanded
  variant="inline"
  onToggleExpand={() => {}}
  onPropertyChange={handlePropertyChange}
  onPropertyNameChange={handlePropertyNameChange}
  onPropertyOrderChange={handlePropertyOrderChange}
  onAddProperty={handleAddProperty}
  onDeleteProperty={handleDeleteProperty}
  hideAddButton
/>
```

Replace with:

```tsx
<InfoSection
  properties={properties}
  newlyAddedPropertyId={newlyAddedPropertyId}
  isExpanded={!propertiesCollapsed}
  variant="embedded"
  onToggleExpand={togglePropertiesCollapsed}
  onPropertyChange={handlePropertyChange}
  onPropertyNameChange={handlePropertyNameChange}
  onPropertyOrderChange={handlePropertyOrderChange}
  onAddProperty={handleAddPropertyWithExpand}
  onDeleteProperty={handleDeleteProperty}
  hideAddButton
/>
```

- [ ] **Step 3.4: Update `GhostAffordanceRow`'s `onAddProperty` (~L762-770)**

Find:

```tsx
<GhostAffordanceRow
  availableTags={availableTags}
  recentTags={recentTags}
  currentTagIds={journalTags.map((t) => t.id)}
  onAddTag={handleAddTag}
  onCreateTag={handleCreateTag}
  onAddProperty={handleAddProperty}
  hasTags={journalTags.length > 0}
/>
```

Change `onAddProperty={handleAddProperty}` to `onAddProperty={handleAddPropertyWithExpand}`.

- [ ] **Step 3.5: Typecheck**

```bash
pnpm typecheck:node && pnpm typecheck:web
```

Expected: No new errors.

- [ ] **Step 3.6: Smoke test in dev**

```bash
pnpm dev
```

Manually verify in the running app:
1. Open a journal entry (any date with at least one custom property)
2. Click the "Properties" chevron — rows collapse
3. Reload — state persists
4. Add property while collapsed — auto-expands

Stop dev server when done.

- [ ] **Step 3.7: Commit**

```bash
git add apps/desktop/src/renderer/src/pages/journal.tsx
git commit -m "feat: collapsible properties section in journal page"
```

---

## Task 4: E2E test for note collapse persistence

**Files:**
- Create: `apps/desktop/e2e/properties-collapse.spec.ts` (or extend an existing notes spec — see Step 4.1)

**Background:** memry's E2E tests run against the BUILT bundle in `out/`, not source. After modifying source, you must rebuild before running E2E. Reference: project note `project_e2e_build_required.md`.

- [ ] **Step 4.1: Decide spec home**

Run:

```bash
ls apps/desktop/e2e/ | grep -E "(note|propert)"
```

If a notes-related spec exists (e.g., `notes.spec.ts`), append the new tests there. Otherwise create `apps/desktop/e2e/properties-collapse.spec.ts`. The remainder of this task assumes a new spec file; adjust file path if appending.

- [ ] **Step 4.2: Write the failing E2E test**

Create `apps/desktop/e2e/properties-collapse.spec.ts`. Inspect a sibling spec (e.g., the one that opens a note and reads `.bn-container` per project notes) for the exact `_electron.launch` boilerplate, vault setup, and helpers. Mirror that boilerplate.

The test body should:

```ts
import { test, expect, _electron as electron } from '@playwright/test'
// import boilerplate / fixtures from the existing notes spec

test('properties section collapse persists across reload (note)', async () => {
  const app = await launchAppWithVault() // helper from existing spec / fixture
  const page = await app.firstWindow()

  // 1. Navigate to a note that has at least one property
  await openNoteWithProperty(page, 'fixture-note-with-status')

  // 2. The chevron header is visible
  const header = page.getByRole('button', { name: /^properties/i })
  await expect(header).toBeVisible()
  await expect(header).toHaveAttribute('aria-expanded', 'true')

  // 3. Click to collapse
  await header.click()
  await expect(header).toHaveAttribute('aria-expanded', 'false')

  // 4. Property rows are no longer visible
  await expect(page.getByText('Status')).toBeHidden()

  // 5. Reload (close + reopen the same note via app navigation)
  await reopenSameNote(page)

  // 6. Header still shows collapsed
  await expect(page.getByRole('button', { name: /^properties/i })).toHaveAttribute(
    'aria-expanded',
    'false'
  )

  await app.close()
})

test('add property while collapsed auto-expands the section (note)', async () => {
  const app = await launchAppWithVault()
  const page = await app.firstWindow()

  await openNoteWithProperty(page, 'fixture-note-with-status')

  // Start collapsed
  await page.getByRole('button', { name: /^properties/i }).click()
  await expect(
    page.getByRole('button', { name: /^properties/i })
  ).toHaveAttribute('aria-expanded', 'false')

  // Trigger add property from the ghost affordance row
  await triggerGhostAddProperty(page) // helper that hovers the ghost row + clicks "+ Add property"
  await selectPropertyType(page, 'text') // helper that clicks the first option in the popup

  // Section auto-expands
  await expect(
    page.getByRole('button', { name: /^properties/i })
  ).toHaveAttribute('aria-expanded', 'true')

  await app.close()
})
```

If exact helper names differ in the existing harness, adapt — the helpers `launchAppWithVault`, `openNoteWithProperty`, `reopenSameNote`, `triggerGhostAddProperty`, `selectPropertyType` are placeholders for whatever the project's existing E2E helpers are called (look in `apps/desktop/e2e/fixtures/` or sibling specs).

- [ ] **Step 4.3: Build the bundle**

```bash
cd apps/desktop && npx electron-vite build && cd -
```

Expected: Build completes without errors. Output appears in `apps/desktop/out/`.

- [ ] **Step 4.4: Run the E2E test**

```bash
pnpm test:e2e -- properties-collapse
```

Expected: PASS. If it fails, check:
- Is the build output stale? Re-run Step 4.3.
- Is `better-sqlite3` ABI mismatched for Electron? Run `bash apps/desktop/scripts/ensure-native.sh electron`.

- [ ] **Step 4.5: Commit**

```bash
git add apps/desktop/e2e/properties-collapse.spec.ts
git commit -m "test: add e2e coverage for note properties collapse"
```

---

## Task 5: Extend E2E coverage to journal

**Files:**
- Modify: `apps/desktop/e2e/properties-collapse.spec.ts`

- [ ] **Step 5.1: Add the journal test**

Append to `apps/desktop/e2e/properties-collapse.spec.ts`:

```ts
test('properties section collapse persists across reload (journal)', async () => {
  const app = await launchAppWithVault()
  const page = await app.firstWindow()

  await openJournalEntryWithProperty(page) // helper that creates/opens a journal entry with at least one property

  const header = page.getByRole('button', { name: /^properties/i })
  await expect(header).toBeVisible()
  await header.click()
  await expect(header).toHaveAttribute('aria-expanded', 'false')

  await reopenSameJournalEntry(page)
  await expect(
    page.getByRole('button', { name: /^properties/i })
  ).toHaveAttribute('aria-expanded', 'false')

  await app.close()
})
```

- [ ] **Step 5.2: Rebuild + run**

```bash
cd apps/desktop && npx electron-vite build && cd -
pnpm test:e2e -- properties-collapse
```

Expected: Both note and journal specs PASS.

- [ ] **Step 5.3: Commit**

```bash
git add apps/desktop/e2e/properties-collapse.spec.ts
git commit -m "test: add e2e coverage for journal properties collapse"
```

---

## Task 6: Final verification + ship

- [ ] **Step 6.1: Lint**

```bash
pnpm lint
```

Expected: No new lint errors.

- [ ] **Step 6.2: Full typecheck**

```bash
pnpm typecheck:node && pnpm typecheck:web
```

Expected: No new errors. Pre-existing failures in `websocket.test.ts`, `folders.test.ts`, `sync-telemetry.ts` are acceptable per project notes.

- [ ] **Step 6.3: Run the full Vitest suite**

```bash
pnpm test --filter=desktop
```

Expected: All tests pass, including the new `use-properties-collapsed.test.ts`.

- [ ] **Step 6.4: Confirm with the user before pushing**

Do NOT push without explicit user approval. Summarize the work:
- 1 new hook + tests
- 2 page-wiring changes (note, journal)
- 2 new E2E specs

Ask the user whether to push the branch and open a PR.

- [ ] **Step 6.5: (After user approval) push + open PR**

```bash
git push -u origin feat/collapsible-properties-section
gh pr create --title "feat: collapsible properties section in note & journal" --body "$(cat <<'EOF'
## Summary
- Switch `InfoSection` from `variant="inline"` to `variant="embedded"` in note + journal pages, restoring the existing `InfoHeader` chevron toggle
- New `usePropertiesCollapsed(noteId)` hook persists per-note state in localStorage
- Add-property auto-expands the section when collapsed (wired through both `InfoSection` and `GhostAffordanceRow`)

Spec: `docs/superpowers/specs/2026-05-01-collapsible-properties-section-design.md`

## Test plan
- [x] Unit tests for `usePropertiesCollapsed` (default, toggle, setCollapsed, isolation, error fallback)
- [x] E2E: note properties collapse persists across reload
- [x] E2E: journal properties collapse persists across reload
- [x] E2E: add property while collapsed auto-expands section
- [x] Manual smoke test in dev: chevron, count badge, persistence, auto-expand
EOF
)"
```

- [ ] **Step 6.6: Worktree cleanup (after PR merges)**

```bash
git worktree remove ../memry-collapsible-props
git branch -d feat/collapsible-properties-section
```

---

## Self-Review Checklist (run after writing this plan)

**Spec coverage:**
- ✅ Goal A (visual noise on heavy notes): Tasks 2 + 3 restore the chevron, users can collapse
- ✅ Goal B (focus while writing): Tasks 2 + 3 + persistence (Task 1) — once collapsed, stays collapsed
- ✅ Default expanded on first open: hook returns `false` when key absent (Task 1, Step 1.1 first test)
- ✅ Persistence per note in localStorage: Task 1 hook
- ✅ Storage representation `"1"` only: Task 1 hook implementation
- ✅ Auto-expand on add-property: Task 2 Step 2.2 + Task 3 Step 3.2 (and the GhostAffordanceRow wiring at Steps 2.4 / 3.4)
- ✅ No changes to `InfoSection.tsx` / `InfoHeader.tsx`: confirmed in Tasks 2 + 3 file lists
- ✅ Template editor untouched: spec calls this out, no task touches `template-editor.tsx`
- ✅ Read-only / deleted note still toggles: chevron click passes through `disabled` only on add/edit, not on header click — verified by leaving `disabled={isDeleted}` unchanged in Task 2 Step 2.3
- ✅ Tests cover: hook unit (Task 1), E2E persistence (Task 4 + 5), E2E auto-expand (Task 4)

**Placeholder scan:** Helper names in Task 4/5 (`launchAppWithVault`, `openNoteWithProperty`, etc.) are explicitly flagged as project-specific placeholders to be adapted. No other "TBD" / "TODO" / "implement later".

**Type consistency:**
- Hook signature `[boolean, () => void, (next: boolean) => void]` consistent across spec, Task 1, Task 2, Task 3
- `handleAddPropertyWithExpand` named identically in Tasks 2 and 3
- `setPropertiesCollapsed` / `togglePropertiesCollapsed` / `propertiesCollapsed` triple consistent across both wiring tasks
- `NewProperty` type imported from `@/components/note/info-section` in both tasks
