# Spatial Canvas M7 — PR A (Opt-in Hardening) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two M6 pre-default-on hardening items, add rollout telemetry, and ship real user documentation for the spatial canvas — while the `spatialCanvas` feature flag stays default-**off**.

**Architecture:** A pure decision module (`canvas-note-lock.ts`) plus a thin React hook decide when a canvas note card must stay read-only, because an unauthenticated user has that same note live in a visible tab or on another card. The canvas overlay consults the decision on double-click and while a card is active. Telemetry gains two events and a `canvas` surface. Docs gain a real `user-guide/canvas/` section.

**Tech Stack:** TypeScript, React 19, Electron, Zod, Vitest (jsdom + node projects), Playwright E2E, VitePress, Tailwind (logical properties).

## Global Constraints

- **LIVE PRODUCTION BETA.** Backward compatibility is mandatory. No DB reset, no migration, no sync payload change, no crypto change in this PR.
- **The feature flag stays `false`** in `FEATURES_SETTINGS_DEFAULTS`. The default-on flip is PR B, not this plan.
- **No new canvas editing/authoring features.** M7 is rollout, not scope growth.
- **Telemetry enum additions deploy server-first.** `apps/sync-server/src/routes/telemetry.ts:28` validates `/telemetry/batch` with the _same shared_ `TelemetryBatchSchema` from `@memry/contracts`, so a deployed server on older contracts rejects the **entire batch** with a 400 — not just the unknown event. Merge to `main` → sync-server auto-deploys → verify → only then cut a desktop release.
- **Logging:** `createLogger('Scope')`. **User-facing errors:** `extractErrorMessage(err, fallback)` from `@/lib/ipc-error` (renderer only).
- **Tailwind logical properties** for all new UI: `ms/me`, `ps/pe`, `start/end`, `text-start/end`, `border-s/e`, `rounded-s/e`. Never `ml/mr`, `pl/pr`, `left/right`, `text-left/right`.
- **i18n:** English is the gated locale (`pnpm i18n:check`). New renderer strings go in `packages/i18n/src/locales/en/common.json`.
- **No `MEMRY_DOCS_IMPACT_SKIP`.** `pnpm docs:impact --base origin/main --strict` must pass on real docs.
- **Commits:** no `Co-Authored-By` trailers. Branch is `spatial-canvas-m7-rollout`.
- Spec: `docs/superpowers/specs/2026-07-22-spatial-canvas-m7-rollout-design.md`.

## File Structure

**Create**

| File                                                                     | Responsibility                                                                                                |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `apps/desktop/src/renderer/src/sync/collaboration-status.ts`             | `SyncStatus` type + `isCollaborationActive` — the single predicate both ContentArea and the canvas guard read |
| `apps/desktop/src/renderer/src/sync/collaboration-status.test.ts`        | Truth table for the predicate                                                                                 |
| `apps/desktop/src/renderer/src/pages/canvas/canvas-note-lock.ts`         | Pure lock decision + visible-note-tab collection + the card claim registry                                    |
| `apps/desktop/src/renderer/src/pages/canvas/canvas-note-lock.test.ts`    | Pure unit tests                                                                                               |
| `apps/desktop/src/renderer/src/pages/canvas/use-note-edit-lock.ts`       | React hook binding the pure module to `useSync` + `useTabs`, plus `lockReasonForCard`                         |
| `apps/desktop/src/renderer/src/pages/canvas/use-note-edit-lock.test.tsx` | jsdom integration against the **real** `TabProvider` driving a real split                                     |
| `apps/docs/src/user-guide/canvas/overview.md`                            | User docs — what a canvas is, enabling it, creating one                                                       |
| `apps/docs/src/user-guide/canvas/cards-and-links.md`                     | User docs — cards, links, editing, the read-only lock                                                         |
| `apps/docs/src/user-guide/canvas/sync-and-limits.md`                     | User docs — sync, conflict copies, images, limits                                                             |

**Modify**

| File                                                                                                                                           | Change                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `apps/desktop/src/renderer/src/contexts/sync-context.tsx:24`                                                                                   | Import `SyncStatus` from the new module instead of declaring it locally                             |
| `apps/desktop/src/renderer/src/components/note/content-area/ContentArea.tsx:1334-1335`                                                         | Use `isCollaborationActive(state.status)`                                                           |
| `apps/desktop/src/renderer/src/pages/canvas/canvas-card.tsx`                                                                                   | Additive `locked` prop + always-visible "Open in tab to edit" affordance                            |
| `apps/desktop/src/renderer/src/pages/canvas/canvas-card-overlay.tsx`                                                                           | Gate activation, claim/release, auto-deactivate when a note tab becomes visible, pass `locked` down |
| `apps/desktop/src/renderer/src/sync/yjs-doc-registry.test.ts`                                                                                  | R17 churn tests                                                                                     |
| `packages/contracts/src/telemetry-api.ts`                                                                                                      | `canvas_created`, `canvas_opened`, `canvas` surface                                                 |
| `packages/contracts/src/telemetry-api.test.ts`                                                                                                 | Assert the additions parse                                                                          |
| `apps/desktop/src/main/ipc/canvas-handlers.ts`                                                                                                 | Emit the two events                                                                                 |
| `apps/desktop/src/main/ipc/canvas-handlers.test.ts`                                                                                            | Assert emission                                                                                     |
| `packages/i18n/src/locales/en/common.json`                                                                                                     | `canvas.card.openToEdit`                                                                            |
| `apps/desktop/tests/e2e/canvas-editing.e2e.ts`                                                                                                 | Negative regression: unlocked card still activates                                                  |
| `apps/docs/src/.vitepress/config.ts`                                                                                                           | Canvas sidebar section                                                                              |
| `apps/docs/src/features.md`, `apps/docs/src/roadmap.md`, `apps/docs/src/user-guide/settings.md`, `apps/docs/src/user-guide/tabs-split-view.md` | Cross-links                                                                                         |
| `apps/docs/src/architecture/observability.md`                                                                                                  | Canvas rollout panel queries                                                                        |

### Why the split-view positive case is jsdom, not E2E

The lock only triggers when **two panes are visible at once**. `tab-pane.tsx:56` renders only each group's active tab, so a single-pane E2E can never reach the locked state. There is no reliable UI or test hook to create a split in Playwright — `tabs.e2e.ts:535`'s `createHorizontalSplit` dispatches a `test:split-view` CustomEvent that **no renderer code listens for**, so it is a silent no-op, and the tests using it carry `test.skip` fallbacks.

The real regression is therefore a jsdom integration test that mounts the **real `TabProvider`** and calls the real `splitView()` action — the precedent is `apps/desktop/src/renderer/src/pages/calendar.test.tsx:105-118`. E2E gets the _negative_ case only: with no note tab visible, a card must still activate normally, so the guard cannot silently break M6's happy path. This split is deliberate and is recorded in the spec.

---

### Task 1: The shared collaboration predicate

Extract the inline expression that decides whether Yjs collaboration is live, so `ContentArea` and the canvas guard cannot drift apart. Behavior-preserving.

**Files:**

- Create: `apps/desktop/src/renderer/src/sync/collaboration-status.ts`
- Create: `apps/desktop/src/renderer/src/sync/collaboration-status.test.ts`
- Modify: `apps/desktop/src/renderer/src/contexts/sync-context.tsx:24`
- Modify: `apps/desktop/src/renderer/src/components/note/content-area/ContentArea.tsx:1334-1335`

**Interfaces:**

- Produces: `type SyncStatus = 'idle' | 'syncing' | 'paused' | 'error' | 'offline' | 'unknown'` and `isCollaborationActive(status: SyncStatus): boolean`, both from `@/sync/collaboration-status`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/renderer/src/sync/collaboration-status.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { isCollaborationActive, type SyncStatus } from './collaboration-status'

describe('isCollaborationActive', () => {
  it('is true only for live sync statuses', () => {
    expect(isCollaborationActive('idle')).toBe(true)
    expect(isCollaborationActive('syncing')).toBe(true)
    expect(isCollaborationActive('offline')).toBe(true)
  })

  it('is false before a sync session exists or when it has failed', () => {
    expect(isCollaborationActive('unknown')).toBe(false)
    expect(isCollaborationActive('paused')).toBe(false)
    expect(isCollaborationActive('error')).toBe(false)
  })

  it('covers every SyncStatus member', () => {
    const all: SyncStatus[] = ['idle', 'syncing', 'paused', 'error', 'offline', 'unknown']
    expect(all.filter(isCollaborationActive)).toEqual(['idle', 'syncing', 'offline'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- collaboration-status`
Expected: FAIL — `Failed to resolve import "./collaboration-status"`.

- [ ] **Step 3: Write the module**

Create `apps/desktop/src/renderer/src/sync/collaboration-status.ts`:

```ts
/**
 * The single source of truth for "is Yjs collaboration live for note editors?".
 *
 * ContentArea gates useYjsCollaboration on this; the canvas note-card lock
 * (pages/canvas/canvas-note-lock.ts) gates on its NEGATION. Both must read this
 * one predicate: if two copies drift, the canvas guard silently stops matching
 * the condition it exists to guard, and unauthenticated split-view body clobber
 * comes back without any test going red.
 *
 * Collaboration is reachable only for an authenticated sync session — see
 * contexts/sync-context.tsx, where these statuses are produced.
 */
export type SyncStatus = 'idle' | 'syncing' | 'paused' | 'error' | 'offline' | 'unknown'

export function isCollaborationActive(status: SyncStatus): boolean {
  return status === 'idle' || status === 'syncing' || status === 'offline'
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop test:renderer -- collaboration-status`
Expected: PASS, 3 tests.

- [ ] **Step 5: Point `sync-context.tsx` at the shared type**

In `apps/desktop/src/renderer/src/contexts/sync-context.tsx`, delete the local declaration at line 24:

```ts
type SyncStatus = 'idle' | 'syncing' | 'paused' | 'error' | 'offline' | 'unknown'
```

and add to the import block near the other `@/` imports:

```ts
import type { SyncStatus } from '@/sync/collaboration-status'
```

- [ ] **Step 6: Point `ContentArea.tsx` at the shared predicate**

In `apps/desktop/src/renderer/src/components/note/content-area/ContentArea.tsx`, add next to the existing `import { useSync } from '@/contexts/sync-context'` at line 32:

```ts
import { isCollaborationActive } from '@/sync/collaboration-status'
```

Replace lines 1334-1335:

```ts
const syncActive =
  state.status === 'idle' || state.status === 'syncing' || state.status === 'offline'
```

with:

```ts
const syncActive = isCollaborationActive(state.status)
```

Change nothing else in this file. This is a pure extraction; every existing ContentArea test must stay green **without being edited**.

- [ ] **Step 7: Verify nothing regressed**

Run: `pnpm --filter @memry/desktop typecheck:web`
Expected: no errors.

Run: `pnpm --filter @memry/desktop test:renderer -- ContentArea`
Expected: PASS, unchanged count. If any ContentArea test needed editing, the extraction was not behavior-preserving — revert and redo.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/renderer/src/sync/collaboration-status.ts apps/desktop/src/renderer/src/sync/collaboration-status.test.ts apps/desktop/src/renderer/src/contexts/sync-context.tsx apps/desktop/src/renderer/src/components/note/content-area/ContentArea.tsx
git commit -m "refactor(sync): extract isCollaborationActive so editors and the canvas guard share one predicate"
```

---

### Task 2: Pure note-lock decision module

**Files:**

- Create: `apps/desktop/src/renderer/src/pages/canvas/canvas-note-lock.ts`
- Create: `apps/desktop/src/renderer/src/pages/canvas/canvas-note-lock.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks (types only, from `@/contexts/tabs`).
- Produces:
  - `type NoteLockReason = 'note-open-in-tab' | 'note-active-on-another-card'`
  - `evaluateNoteLock(input: NoteLockInput): NoteLockReason | null`
  - `collectVisibleNoteTabIds(tabGroups: Record<string, TabGroup>): Set<string>`
  - `createNoteCardClaims(): NoteCardClaims` and the module singleton `noteCardClaims`
  - `interface NoteCardClaims { claim(noteId: string, cardElementId: string): boolean; release(noteId: string, cardElementId: string): void; claimedBy(noteId: string): string | null }`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/renderer/src/pages/canvas/canvas-note-lock.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { TabGroup } from '@/contexts/tabs'
import {
  collectVisibleNoteTabIds,
  createNoteCardClaims,
  evaluateNoteLock
} from './canvas-note-lock'

const group = (
  id: string,
  tabs: Array<{ id: string; type: string; entityId?: string }>,
  activeTabId: string | null
): TabGroup =>
  ({
    id,
    tabs: tabs.map((t) => ({
      ...t,
      title: t.id,
      icon: '',
      path: '',
      isPinned: false,
      isModified: false,
      isPreview: false,
      isDeleted: false,
      openedAt: 0,
      lastAccessedAt: 0
    })),
    activeTabId,
    isActive: false,
    back: [],
    forward: []
  }) as unknown as TabGroup

describe('collectVisibleNoteTabIds', () => {
  it('collects the entityId of each group’s ACTIVE note tab', () => {
    const groups = {
      a: group('a', [{ id: 't1', type: 'note', entityId: 'n1' }], 't1'),
      b: group('b', [{ id: 't2', type: 'note', entityId: 'n2' }], 't2')
    }
    expect(collectVisibleNoteTabIds(groups)).toEqual(new Set(['n1', 'n2']))
  })

  it('ignores background tabs — only the active tab of a pane is mounted', () => {
    const groups = {
      a: group(
        'a',
        [
          { id: 't1', type: 'note', entityId: 'n1' },
          { id: 't2', type: 'canvas', entityId: 'c1' }
        ],
        't2'
      )
    }
    expect(collectVisibleNoteTabIds(groups)).toEqual(new Set())
  })

  it('ignores non-note active tabs and note tabs with no entityId', () => {
    const groups = {
      a: group('a', [{ id: 't1', type: 'canvas', entityId: 'c1' }], 't1'),
      b: group('b', [{ id: 't2', type: 'note' }], 't2')
    }
    expect(collectVisibleNoteTabIds(groups)).toEqual(new Set())
  })
})

describe('evaluateNoteLock', () => {
  const base = {
    collaborationActive: false,
    visibleNoteTabIds: new Set<string>(),
    claimedBy: null as string | null,
    cardElementId: 'card-1',
    noteId: 'n1'
  }

  it('never locks when collaboration is active (authenticated co-edit is safe)', () => {
    expect(
      evaluateNoteLock({ ...base, collaborationActive: true, visibleNoteTabIds: new Set(['n1']) })
    ).toBeNull()
    expect(evaluateNoteLock({ ...base, collaborationActive: true, claimedBy: 'card-2' })).toBeNull()
  })

  it('locks when the note is the active tab of a visible pane', () => {
    expect(evaluateNoteLock({ ...base, visibleNoteTabIds: new Set(['n1']) })).toBe(
      'note-open-in-tab'
    )
  })

  it('locks when another card already claims the note', () => {
    expect(evaluateNoteLock({ ...base, claimedBy: 'card-2' })).toBe('note-active-on-another-card')
  })

  it('does not lock a card against its own claim (re-activation stays allowed)', () => {
    expect(evaluateNoteLock({ ...base, claimedBy: 'card-1' })).toBeNull()
  })

  it('does not lock when nothing else holds the note', () => {
    expect(evaluateNoteLock(base)).toBeNull()
  })

  it('prefers the tab reason when both conditions hold', () => {
    expect(
      evaluateNoteLock({ ...base, visibleNoteTabIds: new Set(['n1']), claimedBy: 'card-2' })
    ).toBe('note-open-in-tab')
  })
})

describe('note card claims', () => {
  it('grants a free note to the first claimant and refuses the second', () => {
    const claims = createNoteCardClaims()
    expect(claims.claim('n1', 'card-1')).toBe(true)
    expect(claims.claim('n1', 'card-2')).toBe(false)
    expect(claims.claimedBy('n1')).toBe('card-1')
  })

  it('re-claiming by the same card is idempotent', () => {
    const claims = createNoteCardClaims()
    expect(claims.claim('n1', 'card-1')).toBe(true)
    expect(claims.claim('n1', 'card-1')).toBe(true)
  })

  it('releases only for the owner, then the note is claimable again', () => {
    const claims = createNoteCardClaims()
    claims.claim('n1', 'card-1')
    claims.release('n1', 'card-2')
    expect(claims.claimedBy('n1')).toBe('card-1')
    claims.release('n1', 'card-1')
    expect(claims.claimedBy('n1')).toBeNull()
    expect(claims.claim('n1', 'card-2')).toBe(true)
  })

  it('releasing an unclaimed note is a no-op', () => {
    const claims = createNoteCardClaims()
    expect(() => claims.release('n1', 'card-1')).not.toThrow()
    expect(claims.claimedBy('n1')).toBeNull()
  })

  it('keeps claims independent per note', () => {
    const claims = createNoteCardClaims()
    claims.claim('n1', 'card-1')
    expect(claims.claim('n2', 'card-2')).toBe(true)
    expect(claims.claimedBy('n1')).toBe('card-1')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- canvas-note-lock`
Expected: FAIL — `Failed to resolve import "./canvas-note-lock"`.

- [ ] **Step 3: Write the module**

Create `apps/desktop/src/renderer/src/pages/canvas/canvas-note-lock.ts`:

```ts
/**
 * Why a canvas note card sometimes refuses to become editable.
 *
 * ContentArea only engages Yjs collaboration for an authenticated sync session.
 * Unauthenticated users therefore edit through a NON-collaborative BlockNote
 * that debounce-saves whole markdown. Two such editors on one note (a note tab
 * in one pane + an active canvas card in another) clobber each other
 * last-save-wins, and each independently runs ContentArea's task
 * auto-conversion, so a checkbox can become two tasks.
 *
 * The rule is "the tab always wins": a card refuses to activate and stays a
 * read-only preview with an open-in-tab affordance. Authenticated users never
 * satisfy the first conjunct, so their shared-Y.Doc co-editing is untouched.
 *
 * Excalidraw-free and React-free so it unit-tests in jsdom, matching
 * canvas-active.ts.
 */
import type { TabGroup } from '@/contexts/tabs'

export type NoteLockReason = 'note-open-in-tab' | 'note-active-on-another-card'

export interface NoteLockInput {
  /** From isCollaborationActive(syncStatus). True => authenticated shared Y.Doc. */
  collaborationActive: boolean
  /** Note ids that are the ACTIVE tab of some pane (see collectVisibleNoteTabIds). */
  visibleNoteTabIds: ReadonlySet<string>
  /** Card element id currently claiming this note, or null. */
  claimedBy: string | null
  /** The card asking to activate. */
  cardElementId: string
  noteId: string
}

export function evaluateNoteLock(input: NoteLockInput): NoteLockReason | null {
  if (input.collaborationActive) return null
  if (input.visibleNoteTabIds.has(input.noteId)) return 'note-open-in-tab'
  if (input.claimedBy !== null && input.claimedBy !== input.cardElementId) {
    return 'note-active-on-another-card'
  }
  return null
}

/**
 * Note ids reachable for editing right now. components/split-view/tab-pane.tsx
 * renders ONLY `group.tabs.find(t => t.id === group.activeTabId)`, so a
 * background tab in the same group is unmounted and cannot clobber anything.
 * Checking active tabs is therefore exact, not an approximation — if tab
 * rendering ever keeps background tabs mounted, this function must change.
 */
export function collectVisibleNoteTabIds(tabGroups: Record<string, TabGroup>): Set<string> {
  const ids = new Set<string>()
  for (const group of Object.values(tabGroups)) {
    const active = group.tabs.find((tab) => tab.id === group.activeTabId)
    if (active?.type === 'note' && active.entityId) {
      ids.add(active.entityId)
    }
  }
  return ids
}

export interface NoteCardClaims {
  /** True when this card now owns the note (already-owner re-claims succeed). */
  claim(noteId: string, cardElementId: string): boolean
  /** No-op unless this card is the current owner. */
  release(noteId: string, cardElementId: string): void
  claimedBy(noteId: string): string | null
}

export function createNoteCardClaims(): NoteCardClaims {
  const claims = new Map<string, string>()
  return {
    claim(noteId, cardElementId) {
      const current = claims.get(noteId)
      if (current !== undefined && current !== cardElementId) return false
      claims.set(noteId, cardElementId)
      return true
    },
    release(noteId, cardElementId) {
      if (claims.get(noteId) === cardElementId) claims.delete(noteId)
    },
    claimedBy(noteId) {
      return claims.get(noteId) ?? null
    }
  }
}

/**
 * Module singleton — two CanvasCardLayer instances in two panes are separate
 * React trees, so the claim must live outside React. Mirrors the module-level
 * registry in sync/use-yjs-collaboration.ts. Tests use createNoteCardClaims().
 */
export const noteCardClaims = createNoteCardClaims()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop test:renderer -- canvas-note-lock`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/pages/canvas/canvas-note-lock.ts apps/desktop/src/renderer/src/pages/canvas/canvas-note-lock.test.ts
git commit -m "feat(canvas): pure note-edit lock decision + card claim registry"
```

---

### Task 3: `useNoteEditLock` hook

Bind the pure module to live contexts, and prove it against the **real** tab reducer driving a **real** split.

**Files:**

- Create: `apps/desktop/src/renderer/src/pages/canvas/use-note-edit-lock.ts`
- Create: `apps/desktop/src/renderer/src/pages/canvas/use-note-edit-lock.test.tsx`

**Interfaces:**

- Consumes: `evaluateNoteLock`, `collectVisibleNoteTabIds`, `noteCardClaims`, `NoteLockReason` from `./canvas-note-lock` (Task 2); `isCollaborationActive` from `@/sync/collaboration-status` (Task 1); `CanvasCardRef` from `./canvas-cards`.
- Produces:
  - `interface NoteEditLockContext { collaborationActive: boolean; visibleNoteTabIds: ReadonlySet<string> }`
  - `useNoteEditLock(): NoteEditLockContext`
  - `lockReasonForCard(ctx: NoteEditLockContext, card: CanvasCardRef): NoteLockReason | null`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/renderer/src/pages/canvas/use-note-edit-lock.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import { TabProvider, useTabActions, useTabs } from '@/contexts/tabs'
import { renderWithProviders, userEvent } from '@tests/utils/render'
import { noteCardClaims } from './canvas-note-lock'
import { useNoteEditLock, lockReasonForCard } from './use-note-edit-lock'
import type { CanvasCardRef } from './canvas-cards'

const syncStatus = { current: 'unknown' as string }
vi.mock('@/contexts/sync-context', () => ({
  useSync: () => ({ state: { status: syncStatus.current } })
}))

const CARD: CanvasCardRef = {
  elementId: 'card-1',
  entityType: 'note',
  entityId: 'note-1',
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  angle: 0
}

function Probe(): React.JSX.Element {
  const ctx = useNoteEditLock()
  const { openTab, splitView, setActiveGroup } = useTabActions()
  const { state } = useTabs()
  const primaryGroupId = Object.keys(state.tabGroups)[0]
  return (
    <div>
      <span data-testid="lock">{String(lockReasonForCard(ctx, CARD))}</span>
      <button type="button" onClick={() => splitView('horizontal', primaryGroupId)}>
        split
      </button>
      <button
        type="button"
        onClick={() =>
          // openTab takes Omit<Tab, 'id' | 'openedAt' | 'lastAccessedAt'>, so every
          // other Tab field is required — see contexts/tabs/types.ts.
          openTab({
            type: 'note',
            title: 'Note 1',
            icon: 'FileText',
            path: '/note-1',
            entityId: 'note-1',
            isPinned: false,
            isModified: false,
            isPreview: false,
            isDeleted: false
          })
        }
      >
        open-note
      </button>
      <button type="button" onClick={() => setActiveGroup(primaryGroupId)}>
        focus-primary
      </button>
    </div>
  )
}

const renderProbe = (): void => {
  renderWithProviders(
    <TabProvider>
      <Probe />
    </TabProvider>
  )
}

describe('useNoteEditLock', () => {
  beforeEach(() => {
    syncStatus.current = 'unknown'
    noteCardClaims.release('note-1', noteCardClaims.claimedBy('note-1') ?? '')
  })

  it('does not lock when the note is not open in any visible pane', async () => {
    renderProbe()
    expect(screen.getByTestId('lock')).toHaveTextContent('null')
  })

  it('locks an unauthenticated card when the note is live in the OTHER pane', async () => {
    const user = userEvent.setup()
    renderProbe()
    // Split, open the note in the newly-focused pane, then focus the primary
    // pane again — the exact split-view shape the guard exists for: the canvas
    // is in the focused pane while the note stays mounted in the sibling pane.
    await user.click(screen.getByText('split'))
    await user.click(screen.getByText('open-note'))
    await user.click(screen.getByText('focus-primary'))
    expect(screen.getByTestId('lock')).toHaveTextContent('note-open-in-tab')
  })

  it('does not lock an authenticated card even with the note live in the other pane', async () => {
    const user = userEvent.setup()
    syncStatus.current = 'idle'
    renderProbe()
    await user.click(screen.getByText('split'))
    await user.click(screen.getByText('open-note'))
    await user.click(screen.getByText('focus-primary'))
    expect(screen.getByTestId('lock')).toHaveTextContent('null')
  })

  it('locks when another card holds the claim', async () => {
    noteCardClaims.claim('note-1', 'card-2')
    renderProbe()
    expect(screen.getByTestId('lock')).toHaveTextContent('note-active-on-another-card')
    noteCardClaims.release('note-1', 'card-2')
  })

  it('never locks a non-note card', () => {
    // Same entityId as the "open" note on purpose: only note cards are guarded,
    // because task and event cards autosave field-level patches rather than a
    // whole-body last-write-wins markdown save.
    const taskCard: CanvasCardRef = { ...CARD, entityType: 'task' }
    expect(
      lockReasonForCard(
        { collaborationActive: false, visibleNoteTabIds: new Set(['note-1']) },
        taskCard
      )
    ).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- use-note-edit-lock`
Expected: FAIL — `Failed to resolve import "./use-note-edit-lock"`.

- [ ] **Step 3: Write the hook**

Create `apps/desktop/src/renderer/src/pages/canvas/use-note-edit-lock.ts`:

```ts
/**
 * Live inputs for the canvas note-edit lock: whether Yjs collaboration is
 * engaged (authenticated) and which notes are currently editable in a visible
 * pane. Kept separate from canvas-note-lock.ts so the decision stays pure.
 */
import { useMemo } from 'react'
import { useSync } from '@/contexts/sync-context'
import { useTabs } from '@/contexts/tabs'
import { isCollaborationActive } from '@/sync/collaboration-status'
import type { CanvasCardRef } from './canvas-cards'
import {
  collectVisibleNoteTabIds,
  evaluateNoteLock,
  noteCardClaims,
  type NoteLockReason
} from './canvas-note-lock'

export interface NoteEditLockContext {
  collaborationActive: boolean
  visibleNoteTabIds: ReadonlySet<string>
}

export function useNoteEditLock(): NoteEditLockContext {
  const { state: syncState } = useSync()
  const { state: tabState } = useTabs()
  const collaborationActive = isCollaborationActive(syncState.status)
  const visibleNoteTabIds = useMemo(
    () => collectVisibleNoteTabIds(tabState.tabGroups),
    [tabState.tabGroups]
  )
  return useMemo(
    () => ({ collaborationActive, visibleNoteTabIds }),
    [collaborationActive, visibleNoteTabIds]
  )
}

/**
 * Only note cards are guarded. Task and event cards autosave field-level
 * patches through their own IPC services, not a whole-body last-write-wins
 * markdown save, so they are not exposed to the M6 clobber.
 */
export function lockReasonForCard(
  ctx: NoteEditLockContext,
  card: CanvasCardRef
): NoteLockReason | null {
  if (card.entityType !== 'note') return null
  return evaluateNoteLock({
    collaborationActive: ctx.collaborationActive,
    visibleNoteTabIds: ctx.visibleNoteTabIds,
    claimedBy: noteCardClaims.claimedBy(card.entityId),
    cardElementId: card.elementId,
    noteId: card.entityId
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop test:renderer -- use-note-edit-lock`
Expected: PASS, 5 tests.

If `openTab` rejects the payload shape, read the `OpenTabOptions` type exported from `@/contexts/tabs` and match it exactly — do not change the hook to accommodate a wrong test fixture.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/pages/canvas/use-note-edit-lock.ts apps/desktop/src/renderer/src/pages/canvas/use-note-edit-lock.test.tsx
git commit -m "feat(canvas): useNoteEditLock binds the lock decision to sync + tab state"
```

---

### Task 4: Locked card rendering

**Files:**

- Modify: `apps/desktop/src/renderer/src/pages/canvas/canvas-card.tsx`
- Modify: `apps/desktop/src/renderer/src/pages/canvas/canvas-card.test.tsx`
- Modify: `packages/i18n/src/locales/en/common.json`

**Interfaces:**

- Consumes: `NoteLockReason` from `./canvas-note-lock` (Task 2).
- Produces: `CanvasCardProps` gains `locked?: NoteLockReason | null`.

- [ ] **Step 1: Add the i18n key**

In `packages/i18n/src/locales/en/common.json`, inside `canvas.card`, add after `"open": "Open in tab",`:

```json
      "openToEdit": "Open in tab to edit",
```

- [ ] **Step 2: Write the failing test**

Append to `apps/desktop/src/renderer/src/pages/canvas/canvas-card.test.tsx` inside the existing top-level `describe('CanvasCard', ...)`:

```tsx
it('marks a locked card and offers open-in-tab-to-edit', () => {
  const onRedirect = vi.fn()
  const state: CanvasEntityState = {
    status: 'ready',
    kind: 'note',
    title: 'My Note',
    emoji: null,
    body: 'the body text'
  }
  const cardRef = ref()
  render(
    <CanvasCard cardRef={cardRef} state={state} onRedirect={onRedirect} locked="note-open-in-tab" />
  )

  const root = document.querySelector('[data-canvas-card-id="e1"]')
  expect(root).toHaveAttribute('data-canvas-card-locked', 'true')

  fireEvent.click(screen.getByRole('button', { name: 'openToEdit' }))
  expect(onRedirect).toHaveBeenCalledWith(cardRef)
})

it('does not mark or gate an unlocked card', () => {
  const state: CanvasEntityState = {
    status: 'ready',
    kind: 'note',
    title: 'My Note',
    emoji: null,
    body: 'the body text'
  }
  render(<CanvasCard cardRef={ref()} state={state} onRedirect={vi.fn()} />)

  const root = document.querySelector('[data-canvas-card-id="e1"]')
  expect(root).not.toHaveAttribute('data-canvas-card-locked')
  expect(screen.queryByRole('button', { name: 'openToEdit' })).not.toBeInTheDocument()
})
```

Three things about this file that the assertions depend on, all already true at `canvas-card.test.tsx:1-30`:

- It mocks `useT` to return the **last dot-segment** of the key, so `t('canvas.card.openToEdit')` renders as the literal string `openToEdit`. Do not assert the English copy here.
- It uses `fireEvent`, not `userEvent`.
- Its card fixture is the local `ref()` helper with `elementId: 'e1'`.

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- canvas-card.test`
Expected: FAIL — no `data-canvas-card-locked` attribute, no matching button.

- [ ] **Step 4: Implement the locked variant**

In `apps/desktop/src/renderer/src/pages/canvas/canvas-card.tsx`:

Add to the imports:

```ts
import type { NoteLockReason } from './canvas-note-lock'
```

Extend the props interface:

```ts
interface CanvasCardProps {
  cardRef: CanvasCardRef
  state: CanvasEntityState | undefined
  onRedirect: (cardRef: CanvasCardRef) => void
  /**
   * Non-null when in-place editing is unavailable for this card (the same note
   * is live in a visible tab, or another card already owns it). The card stays
   * a read-only preview and points at the surface that can edit.
   */
  locked?: NoteLockReason | null
}
```

Update the component signature:

```ts
const CanvasCardInner = ({
  cardRef,
  state,
  onRedirect,
  locked
}: CanvasCardProps): React.JSX.Element => {
```

On the root `<div>`, add the attribute alongside the existing data attributes:

```tsx
      data-canvas-card-locked={locked ? 'true' : undefined}
```

Immediately before the closing `</div>` of the root element (after the status/preview branch chain), add:

```tsx
{
  locked ? (
    <button
      type="button"
      data-canvas-redirect=""
      onClick={handleRedirect}
      onPointerDown={(e) => e.stopPropagation()}
      className="pointer-events-auto flex w-full shrink-0 items-center justify-center gap-1 border-t border-border bg-muted/60 px-2 py-1 text-[10px] font-medium text-text-secondary hover:bg-muted hover:text-foreground"
    >
      <ArrowUpRight className="size-3" aria-hidden="true" />
      {t('canvas.card.openToEdit')}
    </button>
  ) : null
}
```

`data-canvas-redirect=""` matters: the overlay's capture-phase `dblclick` handler skips targets inside `[data-canvas-redirect]` (matrix #20), so a double-click on this footer must not try to activate the card either. `pointer-events-auto` matters because the card body is `pointer-events-none`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @memry/desktop test:renderer -- canvas-card.test`
Expected: PASS, including the two new tests.

Run: `pnpm i18n:check`
Expected: no missing English keys.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/pages/canvas/canvas-card.tsx apps/desktop/src/renderer/src/pages/canvas/canvas-card.test.tsx packages/i18n/src/locales/en/common.json
git commit -m "feat(canvas): locked card renders a read-only preview with an open-in-tab-to-edit action"
```

---

### Task 5: Wire the guard into the overlay

**Files:**

- Modify: `apps/desktop/src/renderer/src/pages/canvas/canvas-card-overlay.tsx`
- Modify: `apps/desktop/tests/e2e/canvas-editing.e2e.ts`

**Interfaces:**

- Consumes: `useNoteEditLock`, `lockReasonForCard` (Task 3); `noteCardClaims` (Task 2); `CanvasCard`'s `locked` prop (Task 4).

- [ ] **Step 1: Add the imports**

In `apps/desktop/src/renderer/src/pages/canvas/canvas-card-overlay.tsx`, after the existing `import { buildRedirectTab } from './canvas-redirect'`:

```ts
import { noteCardClaims } from './canvas-note-lock'
import { useNoteEditLock, lockReasonForCard } from './use-note-edit-lock'
```

- [ ] **Step 2: Read the lock context and keep it reachable imperatively**

After the existing `entitiesRef` effect (around line 87), add:

```ts
const lockCtx = useNoteEditLock()
// The capture-phase dblclick handler is imperative and is registered once,
// so it must read the latest lock inputs through a ref, not a closure.
const lockCtxRef = useRef(lockCtx)
useEffect(() => {
  lockCtxRef.current = lockCtx
}, [lockCtx])

const visibleRefsRef = useRef(visibleRefs)
useEffect(() => {
  visibleRefsRef.current = visibleRefs
}, [visibleRefs])
```

- [ ] **Step 3: Gate activation in the dblclick handler**

Replace the body of the `if (hit) { ... }` block inside `onDblClick` (currently lines 261-265):

```ts
if (hit) {
  e.preventDefault()
  e.stopPropagation()
  dispatchActive({ type: 'activate', id: hit.elementId })
}
```

with:

```ts
if (hit) {
  e.preventDefault()
  e.stopPropagation()
  // Unauthenticated + the note already live elsewhere => stay read-only.
  // Two non-collaborative editors on one note clobber each other and both
  // run ContentArea's task auto-conversion (M6 design §12/6).
  if (lockReasonForCard(lockCtxRef.current, hit)) {
    return
  }
  // Claim synchronously here, not in the effect below, so two panes racing
  // on the same note cannot both pass the gate in one tick. The effect
  // re-claims idempotently and owns the release.
  if (hit.entityType === 'note' && !noteCardClaims.claim(hit.entityId, hit.elementId)) {
    return
  }
  dispatchActive({ type: 'activate', id: hit.elementId })
}
```

- [ ] **Step 4: Own the claim lifecycle and deactivate when a tab takes over**

After the `useEffect` that registers the capture-phase listeners (after line 291), add:

```ts
// Release the claim when the card deactivates or the layer unmounts. Keyed on
// activeCardId only: visibleRefs changes on every geometry tick, and keying on
// it would churn claim/release during a drag.
useEffect(() => {
  if (!activeCardId) return
  const card = visibleRefsRef.current.find((c) => c.elementId === activeCardId)
  if (!card || card.entityType !== 'note') return
  const noteId = card.entityId
  noteCardClaims.claim(noteId, activeCardId)
  return () => noteCardClaims.release(noteId, activeCardId)
}, [activeCardId])

// A note tab becoming visible in another pane while a card is active would
// reopen the clobber window, so the card yields immediately. EmbeddedNoteEditor
// flushes its pending save on unmount, so nothing typed is lost.
useEffect(() => {
  const active = activeCardIdRef.current
  if (!active) return
  const card = visibleRefsRef.current.find((c) => c.elementId === active)
  if (card && lockReasonForCard(lockCtx, card)) {
    dispatchActive({ type: 'deactivate' })
  }
}, [lockCtx, dispatchActive])
```

- [ ] **Step 5: Pass `locked` to idle cards**

In the `cards` `useMemo` (line 321), inside the `.map`, compute the reason and pass it:

```tsx
      visibleRefs.map((card) => {
        const isActive = card.elementId === activeCardId
        const locked = isActive ? null : lockReasonForCard(lockCtx, card)
        return (
```

and on the `<CanvasCard>` element add:

```tsx
locked = { locked }
```

Then add `lockCtx` to the `useMemo` dependency array:

```ts
;[visibleRefs, entities, redirect, activeCardId, dispatchActive, lockCtx]
```

- [ ] **Step 6: Run the renderer suite**

Run: `pnpm --filter @memry/desktop test:renderer -- canvas`
Expected: PASS. `canvas-card-overlay.test.tsx` mounts the layer, so it now needs `SyncProvider`/`TabProvider` in scope — if it fails with `useSync must be used within` or `useTabs must be used within`, wrap the render in that test file with the providers it already uses elsewhere, or mock `./use-note-edit-lock` to return `{ collaborationActive: true, visibleNoteTabIds: new Set() }`. Prefer the mock: that test's subject is overlay geometry, not lock behavior, which Tasks 2-3 already cover.

Run: `pnpm --filter @memry/desktop typecheck:web`
Expected: no errors.

- [ ] **Step 7: Add the E2E negative regression**

In `apps/desktop/tests/e2e/canvas-editing.e2e.ts`, add inside the existing `test.describe('Spatial canvas — in-place editing (M6)')` block:

```ts
// M7 guard regression. The lock only triggers when the same note is live in
// ANOTHER visible pane; a single-pane canvas can never reach that state
// (tab-pane.tsx mounts only each group's active tab). So this asserts the
// guard does NOT over-trigger and silently break M6's happy path. The
// positive split-view case is covered by use-note-edit-lock.test.tsx against
// the real TabProvider, because Playwright has no reliable way to create a
// split (tabs.e2e.ts's `test:split-view` CustomEvent has no listener).
test('an unlocked note card still activates (M7 guard does not over-trigger)', async ({ page }) => {
  await openVault(page)
  await setSpatialCanvasFlag(page, true)
  await createCanvasFromSidebar(page)
  const noteId = await seedNote(page, `Unlocked ${Date.now()}`, 'body')
  await dropNote(page, noteId)

  const card = page.locator(`[data-canvas-card-entity="note:${noteId}"]`)
  await expect(card).toBeVisible({ timeout: 20000 })
  await expect(card).not.toHaveAttribute('data-canvas-card-locked', 'true')

  await dblclickCard(page, `note:${noteId}`)
  await expect(card).toHaveAttribute('data-canvas-card-state', 'active', { timeout: 20000 })
})
```

- [ ] **Step 8: Run the canvas E2E**

Run: `pnpm --filter @memry/desktop exec playwright test canvas-editing --config config/playwright.config.ts`
Expected: all tests PASS, including the new one and every pre-existing M6 test.

If the Electron binary fails to load native modules, run `pnpm --filter @memry/desktop rebuild:electron` first — the Node rebuild is not proof for the Electron runtime.

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/renderer/src/pages/canvas/canvas-card-overlay.tsx apps/desktop/tests/e2e/canvas-editing.e2e.ts
git commit -m "fix(canvas): keep an unauthenticated note card read-only when the note is live elsewhere"
```

---

### Task 6: R17 registry churn coverage

No behavior change — this produces the evidence that the shared Y.Doc registry survives rollout scale. It sits on the core note-editing path, so a leak here would hit every note tab once the flag is on for everyone.

**Files:**

- Modify: `apps/desktop/src/renderer/src/sync/yjs-doc-registry.test.ts`

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe('yjs-doc-registry', ...)` block in `apps/desktop/src/renderer/src/sync/yjs-doc-registry.test.ts`:

```ts
it('keeps refCount exact through interleaved acquire/release churn', () => {
  const destroy = vi.fn()
  const registry = createYjsDocRegistry(() => ({ destroy }))
  const consumers = Array.from({ length: 6 }, () => Symbol('consumer'))

  consumers.forEach((c) => registry.acquire('n1', c))
  expect(registry.refCount('n1')).toBe(6)

  // Release out of acquisition order, interleaved with a re-acquire.
  registry.release('n1', consumers[3])
  registry.release('n1', consumers[0])
  const late = Symbol('late')
  registry.acquire('n1', late)
  registry.release('n1', consumers[5])
  expect(registry.refCount('n1')).toBe(4)
  expect(destroy).not.toHaveBeenCalled()
  ;[consumers[1], consumers[2], consumers[4], late].forEach((c) => registry.release('n1', c))
  expect(registry.refCount('n1')).toBe(0)
  expect(destroy).toHaveBeenCalledTimes(1)
})

it('promotes exactly one survivor when the side-effect owner releases repeatedly', () => {
  const registry = createYjsDocRegistry(() => ({ destroy: vi.fn() }))
  const a = Symbol('a')
  const b = Symbol('b')
  const c = Symbol('c')
  registry.acquire('n1', a)
  registry.acquire('n1', b)
  registry.acquire('n1', c)
  expect(registry.isSideEffectOwner('n1', a)).toBe(true)

  registry.release('n1', a)
  const ownersAfterFirst = [b, c].filter((s) => registry.isSideEffectOwner('n1', s))
  expect(ownersAfterFirst).toHaveLength(1)

  registry.release('n1', ownersAfterFirst[0])
  const remaining = [b, c].filter(
    (s) => registry.refCount('n1') > 0 && registry.isSideEffectOwner('n1', s)
  )
  expect(remaining).toHaveLength(1)
})

it('survives a duplicate release without going negative or double-destroying', () => {
  const destroy = vi.fn()
  const registry = createYjsDocRegistry(() => ({ destroy }))
  const a = Symbol('a')
  registry.acquire('n1', a)
  registry.release('n1', a)
  registry.release('n1', a)
  expect(registry.refCount('n1')).toBe(0)
  expect(destroy).toHaveBeenCalledTimes(1)
})

it('re-creates a fresh entry after full teardown (no stale slot leak)', () => {
  const createEntry = vi.fn(() => ({ destroy: vi.fn() }))
  const registry = createYjsDocRegistry(createEntry)
  const a = Symbol('a')
  registry.acquire('n1', a)
  registry.release('n1', a)
  registry.acquire('n1', Symbol('b'))
  expect(createEntry).toHaveBeenCalledTimes(2)
  expect(registry.refCount('n1')).toBe(1)
})

it('refCount===1 stays byte-identical to the pre-registry path', () => {
  const destroy = vi.fn()
  const createEntry = vi.fn(() => ({ destroy }))
  const registry = createYjsDocRegistry(createEntry)
  const only = Symbol('only')
  registry.acquire('n1', only)
  expect(createEntry).toHaveBeenCalledTimes(1)
  expect(registry.isSideEffectOwner('n1', only)).toBe(true)
  registry.release('n1', only)
  expect(destroy).toHaveBeenCalledTimes(1)
})
```

- [ ] **Step 2: Run the tests**

Run: `pnpm --filter @memry/desktop test:renderer -- yjs-doc-registry`
Expected: PASS. These document existing behavior, so they should pass without touching `yjs-doc-registry.ts`. **If any fails, that is a real bug** — stop, report it, and fix `yjs-doc-registry.ts` rather than weakening the test.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/sync/yjs-doc-registry.test.ts
git commit -m "test(sync): churn coverage for the shared Yjs doc registry before canvas rollout"
```

---

### Task 7: Rollout telemetry

**Files:**

- Modify: `packages/contracts/src/telemetry-api.ts:53`, `:72`
- Modify: `packages/contracts/src/telemetry-api.test.ts`
- Modify: `apps/desktop/src/main/ipc/canvas-handlers.ts`
- Modify: `apps/desktop/src/main/ipc/canvas-handlers.test.ts`

**Interfaces:**

- Produces: `TelemetryEventName` gains `'canvas_created' | 'canvas_opened'`; `TelemetrySurface` gains `'canvas'`.

- [ ] **Step 1: Write the failing contracts test**

Append to `packages/contracts/src/telemetry-api.test.ts`:

```ts
describe('canvas rollout telemetry', () => {
  it('accepts the canvas rollout event names', () => {
    expect(TelemetryEventNameSchema.safeParse('canvas_created').success).toBe(true)
    expect(TelemetryEventNameSchema.safeParse('canvas_opened').success).toBe(true)
  })

  it('accepts the canvas surface', () => {
    expect(TelemetrySurfaceSchema.safeParse('canvas').success).toBe(true)
  })

  it('still rejects an unknown event name', () => {
    expect(TelemetryEventNameSchema.safeParse('canvas_exploded').success).toBe(false)
  })
})
```

Import `TelemetryEventNameSchema` and `TelemetrySurfaceSchema` at the top of that file if they are not already imported.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @memry/contracts test -- telemetry-api`
Expected: FAIL — `canvas_created` and `canvas` are not in the enums.

If the contracts package has no `test` script, run the suite from the repo root with `pnpm test` and filter the output; do not add a script in this PR.

- [ ] **Step 3: Extend the enums**

In `packages/contracts/src/telemetry-api.ts`, change the tail of `TelemetryEventNameSchema` (line 53) from:

```ts
  'canvas_asset_gc_reaped'
])
```

to:

```ts
  'canvas_asset_gc_reaped',
  'canvas_created',
  'canvas_opened'
])
```

And in `TelemetrySurfaceSchema`, change line 72 from:

```ts
  'updater'
])
```

to:

```ts
  'updater',
  'canvas'
])
```

Add this comment directly above `TelemetryEventNameSchema`:

```ts
// DEPLOY ORDER: the sync-server validates /telemetry/batch with THIS schema
// (apps/sync-server/src/routes/telemetry.ts). A server running older contracts
// rejects the ENTIRE batch with a 400, not just the unknown event — so any
// addition here must reach the deployed sync-server before a desktop release
// ships it.
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @memry/contracts test -- telemetry-api`
Expected: PASS.

- [ ] **Step 5: Write the failing handler test**

Append to `apps/desktop/src/main/ipc/canvas-handlers.test.ts`, following that file's existing mocking and handler-invocation helpers:

```ts
it('emits canvas_created when a canvas is created', async () => {
  await invokeHandler(CanvasChannels.invoke.CREATE, { title: 'Board' })
  expect(trackMainEvent).toHaveBeenCalledWith('canvas_created', {
    surface: 'canvas',
    action: 'create',
    objectType: 'canvas',
    result: 'success'
  })
})

it('emits canvas_opened when a canvas is fetched', async () => {
  const created = await invokeHandler(CanvasChannels.invoke.CREATE, { title: 'Board' })
  await invokeHandler(CanvasChannels.invoke.GET, created.id)
  expect(trackMainEvent).toHaveBeenCalledWith('canvas_opened', {
    surface: 'canvas',
    action: 'open',
    objectType: 'canvas',
    result: 'success'
  })
})

it('does not emit canvas_opened for a missing canvas', async () => {
  await invokeHandler(CanvasChannels.invoke.GET, 'does-not-exist')
  expect(trackMainEvent).not.toHaveBeenCalledWith('canvas_opened', expect.anything())
})
```

Use the file's own helper for invoking a registered `ipcMain.handle` callback and its own `trackMainEvent` mock. If `../telemetry/track` is not yet mocked in that file, add:

```ts
vi.mock('../telemetry/track', () => ({ trackMainEvent: vi.fn() }))
```

and import `trackMainEvent` from `'../telemetry/track'` so the assertions see the mock.

- [ ] **Step 6: Run to verify it fails**

Run: `pnpm --filter @memry/desktop test:main -- canvas-handlers`
Expected: FAIL — `trackMainEvent` not called with `canvas_created`.

- [ ] **Step 7: Emit the events**

In `apps/desktop/src/main/ipc/canvas-handlers.ts`, add to the imports:

```ts
import { trackMainEvent } from '../telemetry/track'
```

In the CREATE handler, after `const canvas = createCanvas(db, vaultKey, vaultId, input)` (line 93), add:

```ts
trackMainEvent('canvas_created', {
  surface: 'canvas',
  action: 'create',
  objectType: 'canvas',
  result: 'success'
})
```

Replace the GET handler body (lines 108-111):

```ts
createStringHandler(async (id) => {
  const { db, vaultKey } = await getCanvasContext()
  return getCanvas(db, vaultKey, id)
})
```

with:

```ts
createStringHandler(async (id) => {
  const { db, vaultKey } = await getCanvasContext()
  const canvas = getCanvas(db, vaultKey, id)
  if (canvas) {
    // Fires per successful load, so a tab-switch remount counts again. That
    // is the intended meaning ("canvas loads"), documented in
    // apps/docs/src/architecture/observability.md — it is NOT distinct opens.
    trackMainEvent('canvas_opened', {
      surface: 'canvas',
      action: 'open',
      objectType: 'canvas',
      result: 'success'
    })
  }
  return canvas
})
```

No dimensions and no identifiers are attached, so `SafeDimensionValueSchema` is satisfied by construction.

- [ ] **Step 8: Run to verify it passes**

Run: `pnpm --filter @memry/desktop test:main -- canvas-handlers`
Expected: PASS.

Run: `pnpm --filter @memry/desktop typecheck:node && pnpm check:contracts`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add packages/contracts/src/telemetry-api.ts packages/contracts/src/telemetry-api.test.ts apps/desktop/src/main/ipc/canvas-handlers.ts apps/desktop/src/main/ipc/canvas-handlers.test.ts
git commit -m "feat(telemetry): canvas_created + canvas_opened events on a canvas surface"
```

---

### Task 8: User documentation and dashboard queries

**Files:**

- Create: `apps/docs/src/user-guide/canvas/overview.md`
- Create: `apps/docs/src/user-guide/canvas/cards-and-links.md`
- Create: `apps/docs/src/user-guide/canvas/sync-and-limits.md`
- Modify: `apps/docs/src/.vitepress/config.ts`
- Modify: `apps/docs/src/features.md`, `apps/docs/src/roadmap.md`, `apps/docs/src/user-guide/settings.md`, `apps/docs/src/user-guide/tabs-split-view.md`
- Modify: `apps/docs/src/architecture/observability.md`

- [ ] **Step 1: Write `overview.md`**

Create `apps/docs/src/user-guide/canvas/overview.md`:

```markdown
# Canvas Overview

A canvas is an infinite, freeform board. You draw on it, and you place real
notes, tasks, and calendar events on it as cards. Nothing on a canvas is a copy:
a card points at the actual item, so editing it anywhere updates it everywhere.

Canvases are useful when an outline is the wrong shape for your thinking —
planning a project, mapping how ideas connect, sketching a diagram next to the
notes it explains.

## Turning it on

Canvas is opt-in. Open **Settings → Features** and turn on **Canvas**. The
setting is per device and persists across restarts.

Once enabled, a **Canvases** section appears in the sidebar.

## Creating and opening a canvas

- Hover the **Canvases** sidebar section and choose **New canvas**.
- Click any canvas in the sidebar to open it in a tab, like a note.
- Canvases open in the normal tab system, so you can split the view and keep a
  canvas beside a note. See [Tabs & Split View](../tabs-split-view.md).

## Drawing

The canvas uses a full drawing surface: freehand ink, shapes, arrows, text,
colors, multi-select, grouping, and undo/redo. A pen or stylus with pressure
support draws variable-width strokes where the hardware and OS report pressure.

Palm rejection depends on your operating system and hardware rather than on
memrynote, so resting your hand on a touchscreen while drawing may still
register. Test it on your own device before relying on it.

The drawing toolbar is provided by the underlying canvas engine and follows its
own language list, which does not always match memrynote's interface language.

## Next steps

- [Cards & Links](./cards-and-links.md) — putting notes, tasks, and events on a canvas
- [Sync & Limits](./sync-and-limits.md) — how canvases sync, and what to watch out for
```

- [ ] **Step 2: Write `cards-and-links.md`**

Create `apps/docs/src/user-guide/canvas/cards-and-links.md`:

```markdown
# Cards & Links

A **card** is a live reference to a note, task, or calendar event placed on a
canvas. The canvas stores the reference, never a copy of your content.

## Adding cards

- **Drag a note** from the sidebar onto the canvas.
- **Create a note in place** with the **New note** button at the bottom of the
  canvas. The note is created for real and immediately carded.
- Tasks and calendar events can be carded the same way once they exist.

Cards show a live preview: a note's title and the start of its body, a task's
title and status, an event's title and time. Rename or complete the item
anywhere in the app and the card updates.

If the underlying item is deleted, the card stays but is marked as deleted, so
you never lose the spatial context.

## Editing on the canvas

**Double-click a card** to edit it in place — the full note editor, the task
fields, or the event form, right on the board. Click anywhere else, or press
**Escape**, to go back to the preview.

Only one card is editable at a time. That is deliberate: it keeps large boards
responsive.

### When a card stays read-only

If a card shows **Open in tab to edit**, in-place editing is unavailable for it
right now. That happens when the same note is already open in another visible
pane, or is already being edited on another canvas card.

Editing the same note in two places at once, on a device that is not signed in
to sync, would let the two editors overwrite each other's text. Rather than risk
losing what you typed, the card stays a read-only preview and points you at the
surface that owns the edit. Click **Open in tab to edit** to jump there.

On a device signed in to sync, both surfaces share a single live document, so
this does not apply and you can edit in either place.

## Opening an item in a tab

Every card has an **↗ Open in tab** button. It opens a note in a note tab, a
task in the Tasks page with its detail drawer, and an event focused in the
Calendar.

Double-click edits in place; ↗ opens a tab. The two never trigger each other.

## Connecting cards

Draw an arrow from one card to another and it binds to both. Move a card and the
arrow follows. Links are saved with the canvas.

Canvas arrows are visual: they do not create wiki links or backlinks between the
underlying notes.
```

- [ ] **Step 3: Write `sync-and-limits.md`**

Create `apps/docs/src/user-guide/canvas/sync-and-limits.md`:

```markdown
# Canvas Sync & Limits

## How canvases sync

With sync enabled, canvases sync across your devices end-to-end encrypted, like
your notes. The server stores only ciphertext and never sees your board.

Cards sync as references. The notes, tasks, and events they point at sync
through their own channels, so a card on device B resolves to the same item.

## Conflict copies

Canvases are not real-time collaborative documents. If the same canvas is edited
on two devices before they sync, memrynote keeps one version as the canvas and
saves the other as a **conflict copy** — a second canvas in your sidebar.

Nothing is discarded. You open both and merge them by hand.

This is why editing one board simultaneously on two devices is best avoided;
editing different boards, or the same board at different times, is fine.

## Images and other assets

Images pasted or dropped onto a canvas are stored as attachments rather than
inside the board itself, so boards stay small and an identical image used twice
is stored once. Deleting the image, or the canvas, releases the stored copy.

## Size limit

A canvas has a maximum synced size. A board that grows past it is still saved on
your device, but stops syncing until it gets smaller, and memrynote tells you so
rather than failing silently. Splitting a very large board into several canvases
is the usual fix.

## Known limitations

- Real-time co-editing of one canvas is not supported (see conflict copies).
- Canvas arrows do not create backlinks between notes.
- Palm rejection and pen pressure depend on your hardware and OS.
- The drawing toolbar's language comes from the underlying canvas engine and may
  differ from memrynote's interface language.
- Canvas is opt-in per device — enabling it on one device does not enable it on
  another.
```

- [ ] **Step 4: Register the sidebar section**

In `apps/docs/src/.vitepress/config.ts`, inside `unifiedSidebar()`'s `User Guide` items array, add a new group immediately after the `Inbox` group and before `Workspace`:

```ts
        {
          text: 'Canvas',
          collapsed: true,
          items: [
            { text: 'Overview', link: '/user-guide/canvas/overview' },
            { text: 'Cards & Links', link: '/user-guide/canvas/cards-and-links' },
            { text: 'Sync & Limits', link: '/user-guide/canvas/sync-and-limits' }
          ]
        },
```

- [ ] **Step 5: Cross-link from existing pages**

In `apps/docs/src/features.md`, add a bullet to the feature list:

```markdown
- **Canvas** — infinite boards with ink, shapes, and live cards for notes, tasks, and events. Opt-in under Settings → Features. See [Canvas Overview](./user-guide/canvas/overview.md).
```

In `apps/docs/src/user-guide/settings.md`, in the Features section, add:

```markdown
- **Canvas** — enables the spatial canvas surface and its sidebar section. Off by default. See [Canvas Overview](./canvas/overview.md).
```

In `apps/docs/src/user-guide/tabs-split-view.md`, add:

```markdown
Canvases open as tabs too, so you can keep a board in one pane and a note in the other. Note that a note open in a visible pane is edited there, not on the canvas card — see [Cards & Links](./canvas/cards-and-links.md).
```

In `apps/docs/src/roadmap.md`, add:

```markdown
- **Canvas** — shipping as an opt-in feature (Settings → Features). Whiteboard sections (frames), canvas-wide card search and filtering, and real-time co-editing of a single board are not available yet.
```

Match each file's existing heading structure and bullet style; read the file before editing it.

- [ ] **Step 6: Add the dashboard queries**

In `apps/docs/src/architecture/observability.md`, add a new section immediately before `## Server Configuration`:

```markdown
## Canvas Rollout Panels (Grafana / Analytics Engine)

Panels for the spatial canvas rollout. Create these by hand in Grafana Cloud
against the Analytics Engine dataset; they are recorded here so the rollout is
reproducible and reviewable.

`canvas_opened` fires on every successful canvas load, so a tab-switch remount
counts again. Read it as "canvas loads", not "distinct canvases opened".

| Panel              | What it answers                        | Query                                                                                                                                                                       |
| ------------------ | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canvas adoption    | Are people turning it on and using it? | `SELECT toDate(timestamp) AS day, count() AS loads, uniq(installId) AS installs FROM telemetry WHERE eventName = 'canvas_opened' GROUP BY day ORDER BY day`                 |
| Canvases created   | Is creation growing or one-and-done?   | `SELECT toDate(timestamp) AS day, count() AS created FROM telemetry WHERE eventName = 'canvas_created' GROUP BY day ORDER BY day`                                           |
| Conflict-copy rate | Is last-write-wins hurting real users? | `SELECT toDate(timestamp) AS day, count() AS conflicts, uniq(installId) AS installs FROM telemetry WHERE eventName = 'canvas_sync_conflict_copy' GROUP BY day ORDER BY day` |
| Oversized canvases | Is the size cap being hit?             | `SELECT toDate(timestamp) AS day, count() AS blocked FROM telemetry WHERE eventName = 'canvas_too_large' GROUP BY day ORDER BY day`                                         |
| Unknown sync types | Mixed-version tripwire                 | `SELECT toDate(timestamp) AS day, count() AS skipped FROM telemetry WHERE eventName = 'sync_skipped_unknown_type' GROUP BY day ORDER BY day`                                |

Adjust table and column names to match the deployed Analytics Engine dataset
schema; the event names are the stable part.

Go/no-go for flipping the canvas feature flag on by default is recorded in
`docs/superpowers/specs/2026-07-22-spatial-canvas-m7-rollout-design.md` §7.
```

- [ ] **Step 7: Verify the docs gates**

Run: `pnpm docs:build`
Expected: build succeeds, no dead links. Fix any relative-link errors the build reports.

Run: `git add -A && git commit -m "docs(canvas): user guide, sidebar entry, and rollout dashboard queries"`

Run: `pnpm docs:impact --base origin/main --strict`
Expected: `covered` — **not** `missing-docs`. Do not set `MEMRY_DOCS_IMPACT_SKIP`. Note that `docs:impact` needs the changes committed to be seen.

---

### Task 9: Full gate run and pull request

- [ ] **Step 1: Run every gate**

```bash
pnpm typecheck && pnpm lint && pnpm ipc:check && pnpm i18n:check && pnpm check:architecture && pnpm check:contracts
```

Expected: all green. `pnpm ipc:check` should need no regeneration — this PR touches no IPC contract shape. If it reports the invoke map is stale, stop: something in the contracts change reached the IPC surface unexpectedly, and that needs explaining before proceeding.

- [ ] **Step 2: Run the test suites**

```bash
pnpm test:desktop && pnpm test:sync-server
```

Expected: green, including the coverage ratchet. If coverage dips, add cases to the pure modules (`canvas-note-lock.ts`) rather than loosening `coverage-thresholds.json`.

- [ ] **Step 3: Run the canvas E2E once more**

```bash
pnpm --filter @memry/desktop exec playwright test canvas --config config/playwright.config.ts
```

Expected: `canvas-surface`, `canvas-cards`, `canvas-linking`, and `canvas-editing` all pass.

- [ ] **Step 4: Confirm the flag is still off**

```bash
git diff origin/main -- packages/contracts/src/settings-schemas.ts
```

Expected: **no output**. If `FEATURES_SETTINGS_DEFAULTS` changed, the default-on flip leaked into PR A — revert it; it belongs to PR B.

- [ ] **Step 5: Check whitespace**

```bash
git diff --check
```

Expected: no output.

- [ ] **Step 6: Push and open a draft PR**

```bash
git push -u origin spatial-canvas-m7-rollout
```

Then open a **draft** PR against `main` titled `feat(canvas): M7 rollout — opt-in hardening, telemetry, and docs`, with a body covering:

- What ships: the unauthenticated split-view guard, R17 churn coverage, `canvas_created`/`canvas_opened` on a `canvas` surface, the user guide, and the rollout dashboard queries.
- **What does not ship: the default-on flip.** Link the go/no-go in the spec.
- **Deploy order, called out prominently:** merging deploys the sync-server with the new telemetry enums; do not cut a desktop release until that deploy is confirmed, or every telemetry batch from the new build is rejected with a 400.
- The two manual follow-ups: create the Grafana panels, and confirm #754 is live on the deployed sync-server.

No agent or tool branding anywhere in the PR description.

---

## Verification Summary

| Spec requirement                                           | Task                                                  |
| ---------------------------------------------------------- | ----------------------------------------------------- |
| §3 unauth split-view guard — predicate                     | 1, 2                                                  |
| §3 guard — live context binding + split-view regression    | 3                                                     |
| §3 guard — read-only card + open-in-tab affordance         | 4                                                     |
| §3 guard — activation gate, claim lifecycle, yield-to-tab  | 5                                                     |
| §3.5 E2E coverage                                          | 5 (negative case; positive case in 3, with rationale) |
| §4 R17 registry re-verification                            | 6                                                     |
| §5 telemetry events + surface + deploy order               | 7, 9                                                  |
| §5 Grafana/AE panel queries                                | 8                                                     |
| §6 user documentation + docs gate                          | 8                                                     |
| §7 PR B stays out of this PR                               | 9 (step 4)                                            |
| §8 backward compatibility (no schema/contract/flag change) | 9 (steps 1, 4)                                        |
| §10 full gate run                                          | 9                                                     |

M7 item "promote the flag to `FEATURE_KEYS` + Settings + i18n" needs no task: it is already on `main` and was verified during design (`feature-flags.ts:12`, `settings-schemas.ts:239`, `features-section.tsx:20`, `settings.json:48`). Task 9's gate run keeps `feature-flags.test.ts` and `i18n:check` green.
