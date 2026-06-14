# Triggered Inline Date Pill Color (#E56458) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an inline `@`-date pill render red (`#E56458`) once its reminder has fired, persisting until the pill is edited.

**Architecture:** Renderer-only presentational overlay. A `note_date` reminder's `triggeredAt != null` is the source of truth. `ContentArea` reads fired anchor ids via `useRemindersForTarget('note_date', noteId)`, an effect + `MutationObserver` toggles `data-fired="true"` on matching pill DOM, and one CSS rule swaps `--date-mention-color` to red. No DB column, markdown, or CRDT change.

**Tech Stack:** React 19, BlockNote inline content (raw DOM node-views), TanStack Query, Vitest (jsdom, renderer project), Playwright (Electron e2e).

**Spec:** `docs/superpowers/specs/2026-06-13-triggered-inline-date-pill-color-design.md`

---

## File Structure

- **Create** `apps/desktop/src/renderer/src/components/note/content-area/use-triggered-date-pills.ts`
  — all overlay logic: `computeFiredAnchorIds` (pure), `applyFiredState` (pure DOM), `watchFiredPills` (observer), `useTriggeredDatePills` (DOM hook), `useFiredDatePillAnchors` (data hook).
- **Create** `apps/desktop/src/renderer/src/components/note/content-area/use-triggered-date-pills.test.ts`
  — unit/integration tests for the above (jsdom).
- **Modify** `apps/desktop/src/renderer/src/assets/base.css` (after line 2429) — `data-fired` color rule.
- **Modify** `apps/desktop/src/renderer/src/components/note/content-area/ContentArea.tsx` (~line 173) — wire the two hooks.
- **Modify** `apps/desktop/tests/e2e/inline-date-ghost.e2e.ts` — computed-color assertion.

Note on testing split: deterministically firing a reminder through the scheduler in e2e is flaky, so the full data→DOM wiring is covered by jsdom tests (Tasks 1-4) and the e2e (Task 8) verifies only the CSS contract on a real Electron renderer (set `data-fired`, assert computed color).

---

### Task 1: `computeFiredAnchorIds` pure helper

**Files:**

- Create: `apps/desktop/src/renderer/src/components/note/content-area/use-triggered-date-pills.ts`
- Test: `apps/desktop/src/renderer/src/components/note/content-area/use-triggered-date-pills.test.ts`

- [ ] **Step 1: Write the failing test**

Create the test file with:

```ts
import { describe, it, expect } from 'vitest'
import { computeFiredAnchorIds } from './use-triggered-date-pills'

describe('computeFiredAnchorIds', () => {
  it('includes only rows with both triggeredAt and anchorId', () => {
    const ids = computeFiredAnchorIds([
      { anchorId: 'a1', triggeredAt: '2026-06-13T12:00:00Z' },
      { anchorId: 'a2', triggeredAt: null }, // pending — not fired
      { anchorId: null, triggeredAt: '2026-06-13T12:00:00Z' } // no anchor
    ])
    expect([...ids]).toEqual(['a1'])
  })

  it('returns an empty set when nothing has fired', () => {
    expect(computeFiredAnchorIds([]).size).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project renderer src/components/note/content-area/use-triggered-date-pills.test.ts`
Expected: FAIL — `computeFiredAnchorIds` is not exported / module not found.

- [ ] **Step 3: Write minimal implementation**

Create `use-triggered-date-pills.ts` with:

```ts
/**
 * Presentational overlay that recolors inline date pills whose reminder has
 * fired. Fired state is per-device (derived from the reminders DB) and is never
 * written into pill props or note markdown.
 */

/** Reminder fields needed to decide fired state. */
interface FiredCandidate {
  anchorId: string | null
  triggeredAt: string | null
}

/**
 * Anchor ids of note_date reminders that have fired at least once (triggeredAt
 * stamped). Survives dismiss/snooze; cleared only when the pill is re-armed.
 */
export function computeFiredAnchorIds(reminders: FiredCandidate[]): Set<string> {
  const ids = new Set<string>()
  for (const r of reminders) {
    if (r.triggeredAt && r.anchorId) ids.add(r.anchorId)
  }
  return ids
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project renderer src/components/note/content-area/use-triggered-date-pills.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/note/content-area/use-triggered-date-pills.ts apps/desktop/src/renderer/src/components/note/content-area/use-triggered-date-pills.test.ts
git commit -m "feat(date-pill): computeFiredAnchorIds helper"
```

---

### Task 2: `applyFiredState` pure DOM helper

**Files:**

- Modify: `apps/desktop/src/renderer/src/components/note/content-area/use-triggered-date-pills.ts`
- Test: `apps/desktop/src/renderer/src/components/note/content-area/use-triggered-date-pills.test.ts`

- [ ] **Step 1: Write the failing test**

Append to the test file (and add `applyFiredState` to the import from `./use-triggered-date-pills`):

```ts
import { applyFiredState } from './use-triggered-date-pills'

function makePill(anchorId: string): HTMLElement {
  const el = document.createElement('span')
  el.className = 'date-mention'
  el.setAttribute('data-anchor-id', anchorId)
  return el
}

describe('applyFiredState', () => {
  it('sets data-fired on fired pills and leaves others untouched', () => {
    const container = document.createElement('div')
    const p1 = makePill('a1')
    const p2 = makePill('a2')
    container.append(p1, p2)

    applyFiredState(container, new Set(['a1']))

    expect(p1.getAttribute('data-fired')).toBe('true')
    expect(p2.hasAttribute('data-fired')).toBe(false)
  })

  it('removes data-fired when an anchor is no longer fired', () => {
    const container = document.createElement('div')
    const p1 = makePill('a1')
    p1.setAttribute('data-fired', 'true')
    container.append(p1)

    applyFiredState(container, new Set())

    expect(p1.hasAttribute('data-fired')).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project renderer src/components/note/content-area/use-triggered-date-pills.test.ts`
Expected: FAIL — `applyFiredState` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `use-triggered-date-pills.ts`:

```ts
/**
 * Toggle `data-fired` on every date pill in `container` so CSS can recolor fired
 * ones. Idempotent — safe to call repeatedly.
 */
export function applyFiredState(container: HTMLElement, firedAnchorIds: Set<string>): void {
  const pills = container.querySelectorAll<HTMLElement>('.date-mention[data-anchor-id]')
  pills.forEach((pill) => {
    const anchorId = pill.getAttribute('data-anchor-id')
    if (anchorId && firedAnchorIds.has(anchorId)) {
      pill.setAttribute('data-fired', 'true')
    } else {
      pill.removeAttribute('data-fired')
    }
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project renderer src/components/note/content-area/use-triggered-date-pills.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/note/content-area/use-triggered-date-pills.ts apps/desktop/src/renderer/src/components/note/content-area/use-triggered-date-pills.test.ts
git commit -m "feat(date-pill): applyFiredState DOM helper"
```

---

### Task 3: `watchFiredPills` MutationObserver helper

**Files:**

- Modify: `apps/desktop/src/renderer/src/components/note/content-area/use-triggered-date-pills.ts`
- Test: `apps/desktop/src/renderer/src/components/note/content-area/use-triggered-date-pills.test.ts`

- [ ] **Step 1: Write the failing test**

Append to the test file (add `watchFiredPills` to the import):

```ts
import { watchFiredPills } from './use-triggered-date-pills'

describe('watchFiredPills', () => {
  it('re-applies fired state when a pill is added after setup', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const stop = watchFiredPills(container, () => new Set(['a1']))

    const p1 = makePill('a1')
    container.appendChild(p1)
    await new Promise((resolve) => setTimeout(resolve, 0)) // let the observer flush

    expect(p1.getAttribute('data-fired')).toBe('true')
    stop()
    container.remove()
  })

  it('stops re-applying after cleanup', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const stop = watchFiredPills(container, () => new Set(['a1']))
    stop()

    const p1 = makePill('a1')
    container.appendChild(p1)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(p1.hasAttribute('data-fired')).toBe(false)
    container.remove()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project renderer src/components/note/content-area/use-triggered-date-pills.test.ts`
Expected: FAIL — `watchFiredPills` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `use-triggered-date-pills.ts`:

```ts
/**
 * Re-apply fired state whenever BlockNote recreates pill DOM (raw node-views are
 * rebuilt on updateBlock). `getFiredAnchorIds` is read lazily so the latest set
 * is used on every mutation. Returns a cleanup that disconnects the observer.
 */
export function watchFiredPills(
  container: HTMLElement,
  getFiredAnchorIds: () => Set<string>
): () => void {
  const observer = new MutationObserver(() => {
    applyFiredState(container, getFiredAnchorIds())
  })
  observer.observe(container, { childList: true, subtree: true })
  return () => observer.disconnect()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project renderer src/components/note/content-area/use-triggered-date-pills.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/note/content-area/use-triggered-date-pills.ts apps/desktop/src/renderer/src/components/note/content-area/use-triggered-date-pills.test.ts
git commit -m "feat(date-pill): watchFiredPills observer helper"
```

---

### Task 4: `useTriggeredDatePills` DOM hook

**Files:**

- Modify: `apps/desktop/src/renderer/src/components/note/content-area/use-triggered-date-pills.ts`
- Test: `apps/desktop/src/renderer/src/components/note/content-area/use-triggered-date-pills.test.ts`

- [ ] **Step 1: Write the failing test**

Append to the test file (add `useTriggeredDatePills` to the import and `import { renderHook } from '@testing-library/react'` at the top):

```ts
import { renderHook } from '@testing-library/react'
import { useTriggeredDatePills } from './use-triggered-date-pills'

describe('useTriggeredDatePills', () => {
  it('applies fired state on change and after pill DOM is recreated', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const containerRef = { current: container }
    const p1 = makePill('a1')
    container.appendChild(p1)

    const { rerender, unmount } = renderHook(
      ({ ids }) => useTriggeredDatePills(containerRef, ids),
      { initialProps: { ids: new Set<string>() } }
    )
    expect(p1.hasAttribute('data-fired')).toBe(false)

    rerender({ ids: new Set(['a1']) })
    expect(p1.getAttribute('data-fired')).toBe('true')

    // a recreated pill (same anchor) picks up fired state via the observer
    const p2 = makePill('a1')
    container.replaceChild(p2, p1)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(p2.getAttribute('data-fired')).toBe('true')

    unmount()
    container.remove()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project renderer src/components/note/content-area/use-triggered-date-pills.test.ts`
Expected: FAIL — `useTriggeredDatePills` not exported.

- [ ] **Step 3: Write minimal implementation**

Add the React imports at the top of `use-triggered-date-pills.ts` (above the file's first declaration):

```ts
import { useEffect, useMemo, useRef } from 'react'
import type { RefObject } from 'react'
```

Then append the hook:

```ts
/**
 * Paint fired date pills inside the editor container via `data-fired`. Applies
 * immediately when the fired set changes and re-applies when BlockNote recreates
 * pill DOM.
 */
export function useTriggeredDatePills(
  containerRef: RefObject<HTMLElement | null>,
  firedAnchorIds: Set<string>
): void {
  const firedRef = useRef(firedAnchorIds)
  firedRef.current = firedAnchorIds

  useEffect(() => {
    const container = containerRef.current
    if (container) applyFiredState(container, firedAnchorIds)
  }, [containerRef, firedAnchorIds])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    return watchFiredPills(container, () => firedRef.current)
  }, [containerRef])
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project renderer src/components/note/content-area/use-triggered-date-pills.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/note/content-area/use-triggered-date-pills.ts apps/desktop/src/renderer/src/components/note/content-area/use-triggered-date-pills.test.ts
git commit -m "feat(date-pill): useTriggeredDatePills DOM hook"
```

---

### Task 5: `useFiredDatePillAnchors` data hook

**Files:**

- Modify: `apps/desktop/src/renderer/src/components/note/content-area/use-triggered-date-pills.ts`

No new test: the derivation is covered by `computeFiredAnchorIds` (Task 1) and the wiring by the e2e (Task 8). This hook is thin glue over `useRemindersForTarget` and the IPC due event.

- [ ] **Step 1: Add the imports**

Add to the import block at the top of `use-triggered-date-pills.ts`:

```ts
import { useRemindersForTarget } from '@/hooks/use-reminders'
```

- [ ] **Step 2: Add the hook**

Append to `use-triggered-date-pills.ts`:

```ts
/**
 * Fired anchor ids for a note's inline date pills. `useRemindersForTarget`
 * already invalidates on create/delete/dismiss, but not on a reminder *firing*,
 * so we also refetch on the due event to recolor a pill live while the note is
 * open.
 */
export function useFiredDatePillAnchors(noteId: string | undefined): Set<string> {
  const { reminders, refetch } = useRemindersForTarget('note_date', noteId ?? '')

  const refetchRef = useRef(refetch)
  refetchRef.current = refetch

  useEffect(() => {
    if (!noteId) return
    return window.api.onReminderDue((event) => {
      const matches = event.reminders.some(
        (r) => r.targetType === 'note_date' && r.targetId === noteId
      )
      if (matches) refetchRef.current()
    })
  }, [noteId])

  return useMemo(() => computeFiredAnchorIds(reminders), [reminders])
}
```

- [ ] **Step 3: Typecheck the file**

Run: `pnpm --filter @memry/desktop typecheck:web`
Expected: PASS (0 errors). Confirms `useRemindersForTarget` return shape, `window.api.onReminderDue` typing, and the `event.reminders` `targetType`/`targetId` fields line up.

- [ ] **Step 4: Re-run the unit tests (no regressions)**

Run: `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project renderer src/components/note/content-area/use-triggered-date-pills.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/note/content-area/use-triggered-date-pills.ts
git commit -m "feat(date-pill): useFiredDatePillAnchors data hook"
```

---

### Task 6: CSS `data-fired` rule

**Files:**

- Modify: `apps/desktop/src/renderer/src/assets/base.css` (insert after line 2429, i.e. after the `.dark ... :not([data-remind='none'])` block and before the `:hover` block)

- [ ] **Step 1: Add the rule**

Insert this block immediately after line 2429 (`}` closing the dark blue rule):

```css
/* Fired (triggered) reminder pill → red until the pill is edited. Set by
   useTriggeredDatePills via data-fired; overrides the blue affordance above
   (same specificity, later in source). One color for both themes. */
.bn-shadcn .bn-editor .date-mention[data-fired='true'],
.dark .bn-editor .date-mention[data-fired='true'],
.date-mention[data-fired='true'] {
  --date-mention-color: #e56458;
}
```

- [ ] **Step 2: Verify it parses (lint + whitespace)**

Run: `pnpm --filter @memry/desktop lint` and `git diff --check`
Expected: PASS — no lint or trailing-whitespace errors in `base.css`.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/assets/base.css
git commit -m "style(date-pill): red color for fired (triggered) pills"
```

---

### Task 7: Wire the hooks into `ContentArea`

**Files:**

- Modify: `apps/desktop/src/renderer/src/components/note/content-area/ContentArea.tsx` (import block + ~line 173)

- [ ] **Step 1: Add the import**

Add near the other content-area imports (e.g. just below the `use-date-mention-prefs` import at line 78, keeping import grouping sensible):

```ts
import { useFiredDatePillAnchors, useTriggeredDatePills } from './use-triggered-date-pills'
```

- [ ] **Step 2: Call the hooks**

Immediately after line 173 (`const linkMentionHover = useLinkMentionHover(editorContainerRef)`), add:

```ts
// Recolor inline date pills whose reminder has fired (red, per-device overlay).
const firedDatePillAnchors = useFiredDatePillAnchors(noteId)
useTriggeredDatePills(editorContainerRef, firedDatePillAnchors)
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @memry/desktop typecheck:web`
Expected: PASS (0 errors). `noteId` is an in-scope prop; `editorContainerRef` is `RefObject<HTMLDivElement>`, assignable to the hook's `RefObject<HTMLElement | null>`.

- [ ] **Step 4: Lint**

Run: `pnpm --filter @memry/desktop lint`
Expected: PASS — no unused-import or hooks-deps warnings.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/note/content-area/ContentArea.tsx
git commit -m "feat(date-pill): wire fired-pill overlay into ContentArea"
```

---

### Task 8: E2E computed-color assertion + final verification

**Files:**

- Modify: `apps/desktop/tests/e2e/inline-date-ghost.e2e.ts` (add one test inside the existing `describe` block)

- [ ] **Step 1: Add the e2e test**

Add this test alongside the other pill tests (mirrors the commit pattern at lines 201-213):

```ts
test('a fired (triggered) date pill renders in the triggered color', async ({ page }) => {
  await createNote(page, uniqueLabel('Fired pill color'))
  await focusEditor(page)

  // Commit a timed pill (one Tab — the complete phrase parses).
  await page.keyboard.type('@today at 23:00')
  await page.keyboard.press('Tab')

  const pill = page.locator(PILL).first()
  await expect(pill).toBeVisible()

  // Simulate the overlay marking this pill fired, then assert the CSS contract:
  // --date-mention-color resolves to #e56458 = rgb(229, 100, 88).
  await pill.evaluate((el) => el.setAttribute('data-fired', 'true'))
  const color = await pill.evaluate((el) => getComputedStyle(el).color)
  expect(color).toBe('rgb(229, 100, 88)')
})
```

- [ ] **Step 2: Build the renderer for e2e**

Run: `pnpm --filter @memry/desktop exec electron-vite build`
Expected: build succeeds (e2e runs against `out/`, not the dev server).

- [ ] **Step 3: Run the e2e suite for this file**

Run: `pnpm --filter @memry/desktop test:e2e -- inline-date-ghost`
Expected: PASS — the new test plus the existing pill tests are green.

- [ ] **Step 4: Full verification sweep**

Run each and confirm green:

- `pnpm --filter @memry/desktop typecheck:web`
- `pnpm --filter @memry/desktop lint`
- `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project renderer src/components/note/content-area/use-triggered-date-pills.test.ts`
- `git diff --check`

Expected: all PASS (typecheck 0 errors, lint clean, 7 unit tests pass, no whitespace errors).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/tests/e2e/inline-date-ghost.e2e.ts
git commit -m "test(e2e): fired date pill renders in triggered color"
```

---

## Self-Review

**Spec coverage:**

- "fires → red automatically, persists on reload" → Task 5 (`triggeredAt` read + due-event refetch), Task 7 (wired). ✅
- "whole pill" → Task 6 (single `--date-mention-color` override). ✅
- "stays red until edited" → relies on `update(remindAt)` clearing `triggeredAt` (verified in spec, no code change needed); covered by `computeFiredAnchorIds` filter. ✅
- "survives dismiss" → `triggeredAt` retained by `dismiss` (verified in spec); `computeFiredAnchorIds` keys on `triggeredAt`, not `status`. ✅
- Read path / apply mechanism A / CSS / edge cases / testing → Tasks 1-8. ✅

**Placeholder scan:** No TBD/TODO; every code step shows full code; commands have expected output. ✅

**Type consistency:** `computeFiredAnchorIds(FiredCandidate[])`, `applyFiredState(HTMLElement, Set<string>)`, `watchFiredPills(HTMLElement, () => Set<string>)`, `useTriggeredDatePills(RefObject<HTMLElement|null>, Set<string>)`, `useFiredDatePillAnchors(string|undefined): Set<string>` — names/signatures consistent across tasks and the ContentArea call site. `Reminder` exposes `anchorId`/`triggeredAt` (contracts), `ReminderWithTarget` (due event) exposes `targetType`/`targetId`. ✅
