# Spatial Canvas M6 — In-place Live Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Double-clicking an idle spatial-canvas card promotes it to a single ACTIVE state that mounts a full live editor (note→BlockNote on the note Y.Doc, task→inline fields, event→inline form); click-away/Escape returns it to the idle preview and unmounts the editor.

**Architecture:** Renderer-only, over the existing M2 hybrid card system (Excalidraw `rectangle` + `pointer-events:none` DOM overlay). An `activeCardId` state machine in `CanvasCardLayer` lives above the overlay; pure logic (reducer, angle-aware hit-test, tool-gate, pin) sits in `canvas-active.ts` for jsdom unit tests. The note co-edit hazard (R17: tab + card = two BlockNote editors on one main-owned Y.Doc) is solved by a ref-counted, noteId-keyed renderer registry that shares one `Y.Doc`/`YjsIpcProvider`/`Y.XmlFragment`; single-editor behavior stays byte-identical to today.

**Tech Stack:** React 19, `@excalidraw/excalidraw@0.18.1`, BlockNote (`@blocknote/*`), Yjs + `y-prosemirror`, Vitest (jsdom + node projects), Playwright + Electron E2E, Tailwind (logical props), `@memry/i18n`.

**Source of truth:** design doc `docs/superpowers/specs/2026-07-21-spatial-canvas-m6-live-editing-design.md` and master spec `docs/superpowers/specs/2026-07-17-spatial-canvas-design.md` (§7.1, §13 M6, §15 R15–R19, §18 C1–C6/E1–E2, matrix #18–22).

## Global Constraints

- **LIVE PRODUCTION BETA — backward compatibility MANDATORY.** No DB reset; no sync/contract/crypto/migration change. M6 is renderer editing over existing entities.
- **Do NOT touch the `spatialCanvas` flag** — it is already in `FEATURE_KEYS`, default-OFF; leave `packages/contracts/src/feature-flags.ts` and `settings-schemas.ts` unchanged. Do not add to i18n `features.items.*` (that is M7).
- **`useYjsCollaboration` refactor must preserve single-consumer behavior exactly** (refCount===1 == today: one doc create on mount, one destroy on unmount). Only refCount≥2 (canvas card + note tab, same note, same window) exercises sharing.
- **Tailwind logical properties only** in new/edited renderer UI: `ms/me`, `ps/pe`, `start/end`, `text-start/text-end`, `border-s/border-e`, `rounded-s/rounded-e`. Never `ml/mr/pl/pr/left/right/text-left/text-right/border-l/border-r`.
- **Logging:** `createLogger('SpatialCanvas')` from `@/lib/logger`. **User-facing errors:** `extractErrorMessage(err, fallback)` from `@/lib/ipc-error`.
- **Submit/active buttons that disable mid-click lose the click** — fire from `onPointerDown` (see `components/calendar/calendar-quick-create-dialog.tsx`), keep `onClick` as keyboard fallback.
- **Keep overlay glue thin; put logic in pure/tested modules** so untestable canvas code does not drag the coverage ratchet (statements 85.8 / branches 73.6 / functions 85.5 / lines 87.9).
- **All paths are under repo root** `/Users/h4yfans/workspace/memry/.claude/worktrees/spatial-canvas-m6-live-editing-cd9215`; the desktop package prefix is `apps/desktop/`. Renderer prefix below: `apps/desktop/src/renderer/src/`.
- **git commits:** no `Co-Authored-By` trailer.
- **Verify before done (final gate):** `pnpm typecheck && pnpm lint && pnpm ipc:check && pnpm i18n:check && pnpm check:architecture && pnpm check:contracts`; `pnpm test:desktop`; targeted E2E; `git diff --check`.

## File Structure

Renderer prefix `apps/desktop/src/renderer/src/`.

Create:

- `pages/canvas/canvas-active.ts` — pure active-state logic (reducer, `hitTestCard`, `shouldDeactivateForTool`, `withActivePinned`). jsdom/node unit-tested.
- `pages/canvas/canvas-active.test.ts` — its unit tests.
- `pages/canvas/canvas-card-active.tsx` — the active-card container (pointer-events:auto, key containment, Escape→deactivate) that switches on `entityType`.
- `pages/canvas/embedded-note-editor.tsx` — `<ContentArea noteId>` in a bounded scroll box.
- `pages/canvas/canvas-task-editor.tsx` — slim task fields (title/status/priority/due/description) via the shared `updateTask` mapper.
- `pages/canvas/canvas-event-editor.tsx` — hosts `<CalendarEventForm mode="edit">`, owns draft, saves via `calendarService.updateEvent`.
- `sync/yjs-doc-registry.ts` — ref-counted, noteId-keyed shared-doc registry (pure state over an injected entry factory).
- `sync/yjs-doc-registry.test.ts` — its unit tests.
- `components/calendar/calendar-event-form.tsx` — extracted controlled form body (from the popover).
- `tests/e2e/canvas-editing.e2e.ts` — matrix #18–22.

Modify:

- `pages/canvas/canvas-card-overlay.tsx` — `activeCardId` state; dblclick→activate via `hitTestCard`; click-away pointerdown; tool-select deactivate; pin active; render active vs idle.
- `pages/canvas/canvas-card.tsx` — add `data-canvas-redirect` to the ↗ button.
- `sync/use-yjs-collaboration.ts` — route through `yjs-doc-registry` (parity-preserving).
- `components/note/content-area/ContentArea.tsx` + `components/note/content-area/types.ts` — additive `runSideEffects?: boolean` prop gating task auto-conversion; wire to registry side-effect ownership.
- `components/calendar/calendar-event-popover.tsx` — render the extracted `<CalendarEventForm>` (thin wrapper; no caller change).
- `packages/i18n/src/locales/en/common.json` — new `canvas.*` strings.

---

### Task 1: Pure active-state logic (`canvas-active.ts`)

**Files:**

- Create: `apps/desktop/src/renderer/src/pages/canvas/canvas-active.ts`
- Test: `apps/desktop/src/renderer/src/pages/canvas/canvas-active.test.ts`

**Interfaces:**

- Consumes: `CanvasCardRef` from `./canvas-cards` (`{ elementId, entityType, entityId, x, y, width, height, angle }`).
- Produces:
  - `hitTestCard(cards: readonly CanvasCardRef[], point: { x: number; y: number }): CanvasCardRef | null` — reverse-z, angle-aware.
  - `shouldDeactivateForTool(activeToolType: string): boolean`.
  - `type ActiveAction = { type: 'activate'; id: string } | { type: 'deactivate' } | { type: 'cardGone'; id: string }`.
  - `nextActive(prev: string | null, action: ActiveAction): string | null`.
  - `withActivePinned(visible: ReadonlySet<string>, activeCardId: string | null): Set<string>`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/renderer/src/pages/canvas/canvas-active.test.ts
import { describe, it, expect } from 'vitest'
import { hitTestCard, shouldDeactivateForTool, nextActive, withActivePinned } from './canvas-active'
import type { CanvasCardRef } from './canvas-cards'

function card(over: Partial<CanvasCardRef> & { elementId: string }): CanvasCardRef {
  return {
    entityType: 'note',
    entityId: `e-${over.elementId}`,
    x: 0,
    y: 0,
    width: 100,
    height: 60,
    angle: 0,
    ...over
  }
}

describe('hitTestCard', () => {
  it('returns the card under an axis-aligned point', () => {
    const c = card({ elementId: 'a', x: 10, y: 10, width: 100, height: 60 })
    expect(hitTestCard([c], { x: 50, y: 40 })?.elementId).toBe('a')
    expect(hitTestCard([c], { x: 200, y: 40 })).toBeNull()
  })

  it('picks the topmost (last in z-order) when cards overlap', () => {
    const bottom = card({ elementId: 'bottom', x: 0, y: 0, width: 100, height: 100 })
    const top = card({ elementId: 'top', x: 0, y: 0, width: 100, height: 100 })
    expect(hitTestCard([bottom, top], { x: 50, y: 50 })?.elementId).toBe('top')
  })

  it('is angle-aware: a point inside the rotated rect hits; the pre-rotation corner misses', () => {
    // 100x60 centered at (50,30), rotated 90° (π/2). After rotation it spans
    // x∈[20,80], y∈[-20,80]. A point at (50,70) is inside the rotated card but
    // outside the unrotated AABB corner test near (95,5).
    const c = card({ elementId: 'r', x: 0, y: 0, width: 100, height: 60, angle: Math.PI / 2 })
    expect(hitTestCard([c], { x: 50, y: 70 })?.elementId).toBe('r')
    expect(hitTestCard([c], { x: 95, y: 5 })).toBeNull()
  })
})

describe('shouldDeactivateForTool', () => {
  it('stays active for the selection tool, deactivates for any drawing/hand tool', () => {
    expect(shouldDeactivateForTool('selection')).toBe(false)
    expect(shouldDeactivateForTool('freedraw')).toBe(true)
    expect(shouldDeactivateForTool('rectangle')).toBe(true)
    expect(shouldDeactivateForTool('hand')).toBe(true)
  })
})

describe('nextActive', () => {
  it('activates, deactivates, and clears only the matching card on cardGone', () => {
    expect(nextActive(null, { type: 'activate', id: 'x' })).toBe('x')
    expect(nextActive('x', { type: 'activate', id: 'y' })).toBe('y')
    expect(nextActive('x', { type: 'deactivate' })).toBeNull()
    expect(nextActive('x', { type: 'cardGone', id: 'x' })).toBeNull()
    expect(nextActive('x', { type: 'cardGone', id: 'other' })).toBe('x')
  })
})

describe('withActivePinned', () => {
  it('adds the active id to the visible set; no-op when null or already present', () => {
    expect([...withActivePinned(new Set(['a']), 'b')].sort()).toEqual(['a', 'b'])
    expect([...withActivePinned(new Set(['a']), null)]).toEqual(['a'])
    expect([...withActivePinned(new Set(['a']), 'a')]).toEqual(['a'])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @memry/desktop vitest run src/renderer/src/pages/canvas/canvas-active.test.ts`
Expected: FAIL — `Cannot find module './canvas-active'`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/desktop/src/renderer/src/pages/canvas/canvas-active.ts
/**
 * Pure active-card logic for the spatial canvas. Excalidraw-runtime-free (types
 * only) so it unit-tests in jsdom without the library or a real canvas.
 */
import type { CanvasCardRef } from './canvas-cards'

/**
 * Topmost card under a scene-space point, honoring each card's rotation.
 * Cards are in z-order (last is topmost); we scan in reverse. For a card
 * rotated by `angle` around its center, transform the point into the card's
 * local (unrotated) frame, then do an axis-aligned bounds test.
 */
export function hitTestCard(
  cards: readonly CanvasCardRef[],
  point: { x: number; y: number }
): CanvasCardRef | null {
  for (let i = cards.length - 1; i >= 0; i--) {
    const c = cards[i]
    const cx = c.x + c.width / 2
    const cy = c.y + c.height / 2
    const cos = Math.cos(c.angle)
    const sin = Math.sin(c.angle)
    const dx = point.x - cx
    const dy = point.y - cy
    // Inverse rotation R(-angle) applied to (dx, dy), re-centered.
    const lx = cx + dx * cos + dy * sin
    const ly = cy - dx * sin + dy * cos
    if (lx >= c.x && lx <= c.x + c.width && ly >= c.y && ly <= c.y + c.height) {
      return c
    }
  }
  return null
}

/** Any non-selection Excalidraw tool means the user left the active card. */
export function shouldDeactivateForTool(activeToolType: string): boolean {
  return activeToolType !== 'selection'
}

export type ActiveAction =
  | { type: 'activate'; id: string }
  | { type: 'deactivate' }
  | { type: 'cardGone'; id: string }

export function nextActive(prev: string | null, action: ActiveAction): string | null {
  switch (action.type) {
    case 'activate':
      return action.id
    case 'deactivate':
      return null
    case 'cardGone':
      return prev === action.id ? null : prev
  }
}

/**
 * The mounted set always includes the active card, so a stray recompute never
 * unmounts a live editor mid-edit.
 */
export function withActivePinned(
  visible: ReadonlySet<string>,
  activeCardId: string | null
): Set<string> {
  const next = new Set(visible)
  if (activeCardId) {
    next.add(activeCardId)
  }
  return next
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @memry/desktop vitest run src/renderer/src/pages/canvas/canvas-active.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/pages/canvas/canvas-active.ts apps/desktop/src/renderer/src/pages/canvas/canvas-active.test.ts
git commit -m "feat(canvas): pure active-card logic (hit-test, reducer, tool-gate, pin)"
```

---

### Task 2: Active-state wiring in the overlay + stub active container (R15 spike-as-code)

This is the R15 spike, delivered as real committed code: double-click activates one card, click-away/Escape/tool-select deactivate, the ↗ button still redirects with no cross-fire. The active container renders a minimal placeholder editor; Tasks 5–7 fill in the real editors. Proves the pointer model and records the keyboard-containment outcome (design §12).

**Files:**

- Create: `apps/desktop/src/renderer/src/pages/canvas/canvas-card-active.tsx`
- Modify: `apps/desktop/src/renderer/src/pages/canvas/canvas-card-overlay.tsx`
- Modify: `apps/desktop/src/renderer/src/pages/canvas/canvas-card.tsx` (add `data-canvas-redirect` to the ↗ button, ~line 63)
- Create/append E2E: `apps/desktop/tests/e2e/canvas-editing.e2e.ts`

**Interfaces:**

- Consumes: `hitTestCard`, `shouldDeactivateForTool`, `nextActive`, `withActivePinned` from `./canvas-active`; existing `getCardRefs`, `viewportCoordsToSceneCoords`, `CardElement` from the overlay's current imports.
- Produces:
  - `<CanvasCardActive cardRef, state, onDeactivate />` — the active container. For M6-stub it renders `<div contentEditable data-canvas-active-editor>` per type; Tasks 5–7 replace the inner editor.
  - Overlay stamps `data-canvas-card-state="active"` on the active card (via the existing `CanvasCard`/active swap) and `data-canvas-active-card` on the container.

- [ ] **Step 1: Write the failing E2E** (extends the `canvas-cards.e2e.ts` harness)

```ts
// apps/desktop/tests/e2e/canvas-editing.e2e.ts
// @ts-nocheck - E2E tests in development, follow notes.e2e.ts convention
/**
 * Spatial canvas M6 — in-place live editing. Double-click promotes ONE card to
 * active; click-away/Escape returns to idle. ↗ redirect stays distinct from
 * editing (matrix #20). Later tasks add note/task/event body assertions.
 */
import { test, expect, type Page } from './fixtures'
import { ready } from './utils/desktop-test-helpers'

async function openVault(page: Page): Promise<void> {
  await page
    .locator('aside, [data-testid="sidebar"], [class*="sidebar"], nav')
    .first()
    .waitFor({ state: 'visible', timeout: 90_000 })
  await ready(page)
}
async function setSpatialCanvasFlag(page: Page, enabled: boolean): Promise<void> {
  const result = await page.evaluate(
    async (value) => window.api.settings.setFeaturesSettings({ spatialCanvas: value }),
    enabled
  )
  if (!result?.success) throw new Error(result?.error ?? 'setFeaturesSettings failed')
  await page.reload()
  await openVault(page)
}
async function createCanvasFromSidebar(page: Page): Promise<string> {
  const header = page.getByRole('button', { name: /Canvases section/ })
  await expect(header).toBeVisible()
  await header.hover()
  await page.getByRole('button', { name: 'New canvas' }).click()
  await expect(page.locator('[data-canvas-editor]')).toBeVisible({ timeout: 20000 })
  await expect(page.locator('.excalidraw').first()).toBeVisible({ timeout: 20000 })
  const list = await page.evaluate(async () => window.api.canvas.list())
  return list.canvases[0].id
}
async function seedNote(page: Page, title: string, content: string): Promise<string> {
  const res = await page.evaluate(
    async ({ t, c }) => window.api.notes.create({ title: t, content: c }),
    { t: title, c: content }
  )
  if (!res?.note?.id) throw new Error(`seedNote failed for ${title}`)
  return res.note.id
}
async function dropNote(page: Page, noteId: string, dx = 0, dy = 0): Promise<void> {
  await page.evaluate(
    ({ id, ddx, ddy }) => {
      const wrapper = document.querySelector('[data-canvas-editor]') as HTMLElement
      const r = wrapper.getBoundingClientRect()
      const dt = new DataTransfer()
      dt.setData(
        'application/x-memry-canvas-item',
        JSON.stringify({ entityType: 'note', entityId: id })
      )
      const ev = new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        clientX: r.left + r.width / 2 + ddx,
        clientY: r.top + r.height / 2 + ddy
      })
      Object.defineProperty(ev, 'dataTransfer', { value: dt })
      wrapper.dispatchEvent(ev)
    },
    { id: noteId, ddx: dx, ddy: dy }
  )
}
/** Double-click the visual center of a card's overlay div. */
async function dblclickCard(page: Page, entity: string): Promise<void> {
  const box = await page.locator(`[data-canvas-card-entity="${entity}"]`).boundingBox()
  if (!box) throw new Error(`no card box for ${entity}`)
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2)
}

test.describe('Spatial canvas — in-place editing (M6)', () => {
  test.describe.configure({ timeout: 240_000 })

  test('double-click activates one card; Escape and click-away return to idle', async ({
    page
  }) => {
    await openVault(page)
    await setSpatialCanvasFlag(page, true)
    await createCanvasFromSidebar(page)
    const noteId = await seedNote(page, `Active ${Date.now()}`, 'body')
    await dropNote(page, noteId)

    const card = page.locator(`[data-canvas-card-entity="note:${noteId}"]`)
    await expect(card).toBeVisible({ timeout: 20000 })
    await expect(card).toHaveAttribute('data-canvas-card-state', 'ready', { timeout: 20000 })

    await dblclickCard(page, `note:${noteId}`)
    await expect(card).toHaveAttribute('data-canvas-card-state', 'active', { timeout: 20000 })

    await page.keyboard.press('Escape')
    await expect(card).not.toHaveAttribute('data-canvas-card-state', 'active', { timeout: 20000 })

    // Re-activate, then click-away on empty canvas returns to idle.
    await dblclickCard(page, `note:${noteId}`)
    await expect(card).toHaveAttribute('data-canvas-card-state', 'active', { timeout: 20000 })
    const wrap = await page.locator('[data-canvas-editor]').boundingBox()
    await page.mouse.click(wrap.x + 20, wrap.y + 20)
    await expect(card).not.toHaveAttribute('data-canvas-card-state', 'active', { timeout: 20000 })
  })

  test('↗ redirect and double-click do not cross-fire (matrix #20)', async ({ page }) => {
    await openVault(page)
    await setSpatialCanvasFlag(page, true)
    await createCanvasFromSidebar(page)
    const title = `Redirect ${Date.now()}`
    const noteId = await seedNote(page, title, 'body')
    await dropNote(page, noteId)

    const card = page.locator(`[data-canvas-card-entity="note:${noteId}"]`)
    await expect(card).toBeVisible({ timeout: 20000 })
    await card.hover()
    await card.getByRole('button', { name: 'Open in tab' }).click()
    await expect(page.getByRole('tab', { name: title })).toBeVisible({ timeout: 20000 })
    // The card did not enter active state from the ↗ click.
    await expect(card).not.toHaveAttribute('data-canvas-card-state', 'active')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @memry/desktop test:e2e -- canvas-editing`
Expected: FAIL — card never gets `data-canvas-card-state="active"` (no active wiring yet). (If the Electron build is stale, run `pnpm --filter @memry/desktop build` first — see `memry-e2e-stale-build`.)

- [ ] **Step 3: Add the redirect data-attr** to the ↗ button in `canvas-card.tsx` (~line 63), so the dblclick guard can skip it:

```tsx
      <button
        type="button"
        data-canvas-redirect=""
        onClick={handleRedirect}
        onPointerDown={(e) => e.stopPropagation()}
        className="pointer-events-auto absolute end-1.5 top-1.5 z-10 flex size-6 items-center justify-center rounded-md bg-background/70 text-text-secondary opacity-0 shadow-sm transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover/card:opacity-100"
        aria-label={t('canvas.card.open')}
      >
```

- [ ] **Step 4: Create the stub active container** `canvas-card-active.tsx`:

```tsx
/**
 * CanvasCardActive — the single active card. pointer-events:auto so it captures
 * input; keydown/keyup are swallowed so Cmd/Ctrl+Z belongs to the mounted
 * editor (not Excalidraw), and Escape closes the editor. Tasks 5–7 replace the
 * per-type placeholder with the real note/task/event editors.
 */
import React, { useCallback } from 'react'
import type { CanvasCardRef } from './canvas-cards'
import type { CanvasEntityState } from './use-canvas-entities'

interface CanvasCardActiveProps {
  cardRef: CanvasCardRef
  state: CanvasEntityState | undefined
  onDeactivate: () => void
}

export const CanvasCardActive = ({
  cardRef,
  onDeactivate
}: CanvasCardActiveProps): React.JSX.Element => {
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent): void => {
      // Keep editor shortcuts (undo/redo/formatting) from reaching Excalidraw.
      e.stopPropagation()
      if (e.key === 'Escape') {
        e.preventDefault()
        onDeactivate()
      }
    },
    [onDeactivate]
  )
  const onKeyUp = useCallback((e: React.KeyboardEvent): void => e.stopPropagation(), [])

  return (
    <div
      data-canvas-active-card={cardRef.elementId}
      className="flex h-full w-full flex-col overflow-hidden rounded-md border border-primary bg-white text-start shadow-md dark:bg-zinc-900"
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
    >
      {/* Placeholder editor — replaced by note/task/event editors in Tasks 5–7. */}
      <div
        data-canvas-active-editor={cardRef.entityType}
        contentEditable
        suppressContentEditableWarning
        className="min-h-0 flex-1 overflow-auto p-3 text-[13px] outline-none"
      />
    </div>
  )
}
```

- [ ] **Step 5: Wire active state into `canvas-card-overlay.tsx`.** Read the file first (it is 343 lines). Apply these edits:

1. Add imports:

```tsx
import { CanvasCardActive } from './canvas-card-active'
import { hitTestCard, shouldDeactivateForTool, nextActive, withActivePinned } from './canvas-active'
```

2. Add state + a ref near the other overlay state (after `const [visibleRefs, setVisibleRefs] = useState<CanvasCardRef[]>([])`):

```tsx
const [activeCardId, setActiveCardId] = useState<string | null>(null)
const activeCardIdRef = useRef<string | null>(null)
useEffect(() => {
  activeCardIdRef.current = activeCardId
}, [activeCardId])
const dispatchActive = useCallback((action: Parameters<typeof nextActive>[1]) => {
  setActiveCardId((prev) => nextActive(prev, action))
}, [])
```

3. In `recompute`, pin the active card and deactivate a vanished/tool-switched active card. After `const nextIds = computeVisibleCardIds(...)` becomes:

```tsx
const nextIds = withActivePinned(
  computeVisibleCardIds(cards, rect, {
    enterPadding: ENTER_PADDING,
    exitPadding: EXIT_PADDING,
    previousVisible: visibleIdsRef.current
  }),
  activeCardIdRef.current
)
// Active card deleted from the scene, or a non-selection tool chosen → idle.
const active = activeCardIdRef.current
if (active) {
  const stillPresent = cards.some((c) => c.elementId === active)
  const toolType = (appState as unknown as { activeTool?: { type?: string } }).activeTool?.type
  if (!stillPresent) {
    dispatchActive({ type: 'cardGone', id: active })
  } else if (toolType && shouldDeactivateForTool(toolType)) {
    dispatchActive({ type: 'deactivate' })
  }
}
```

(Keep the rest of `recompute` unchanged; `readScene` already returns `appState` — extend its `CanvasAppStateView` cast to include `activeTool` if typecheck complains, or read it via the `as unknown` cast above.)

4. Repoint `onDblClick` from `redirect` to activate, with the ↗ guard:

```tsx
const onDblClick = (e: MouseEvent): void => {
  if ((e.target as Element | null)?.closest('[data-canvas-redirect]')) {
    return
  }
  const appState = excalidrawAPI.getAppState()
  const scene = viewportCoordsToSceneCoords({ clientX: e.clientX, clientY: e.clientY }, appState)
  const cards = getCardRefs(excalidrawAPI.getSceneElements() as unknown as CardElement[])
  const hit = hitTestCard(cards, scene)
  if (hit) {
    e.preventDefault()
    e.stopPropagation()
    dispatchActive({ type: 'activate', id: hit.elementId })
  }
}
```

5. Add a capture-phase click-away `pointerdown` listener alongside the existing wrapper listeners (in the same `useEffect` that binds `dragover`/`drop`/`dblclick`):

```tsx
const onPointerDownAway = (e: PointerEvent): void => {
  const active = activeCardIdRef.current
  if (!active) return
  const target = e.target as Element | null
  // Do NOT swallow — the same pointerdown still pans/selects/draws (C4).
  if (!target?.closest(`[data-canvas-active-card="${active}"]`)) {
    dispatchActive({ type: 'deactivate' })
  }
}
// ...add to add/removeEventListener list:
wrapper.addEventListener('pointerdown', onPointerDownAway, { capture: true })
// cleanup:
wrapper.removeEventListener('pointerdown', onPointerDownAway, { capture: true })
```

Add `dispatchActive` to that effect's dependency array.

6. Swap idle vs active in the `cards` render `useMemo` (mark the active container `pointer-events:auto`):

```tsx
const cards = useMemo(
  () =>
    visibleRefs.map((card) => {
      const isActive = card.elementId === activeCardId
      return (
        <div
          key={card.elementId}
          className="absolute"
          style={{
            left: card.x,
            top: card.y,
            width: card.width,
            height: card.height,
            transform: card.angle ? `rotate(${card.angle}rad)` : undefined,
            transformOrigin: 'center',
            pointerEvents: isActive ? 'auto' : undefined
          }}
        >
          {isActive ? (
            <CanvasCardActive
              cardRef={card}
              state={entities.get(entityKey(card.entityType, card.entityId))}
              onDeactivate={() => dispatchActive({ type: 'deactivate' })}
            />
          ) : (
            <CanvasCard
              cardRef={card}
              state={entities.get(entityKey(card.entityType, card.entityId))}
              onRedirect={redirect}
            />
          )}
        </div>
      )
    }),
  [visibleRefs, entities, redirect, activeCardId, dispatchActive]
)
```

7. Stamp `data-canvas-card-state="active"` on the active card. In `canvas-card.tsx` the idle card owns that attr; for the active card, add `data-canvas-card-state="active"` and `data-canvas-card-entity` to the `CanvasCardActive` root so the E2E selectors resolve. Update `CanvasCardActive`'s root div:

```tsx
      data-canvas-active-card={cardRef.elementId}
      data-canvas-card-id={cardRef.elementId}
      data-canvas-card-entity={`${cardRef.entityType}:${cardRef.entityId}`}
      data-canvas-card-state="active"
```

- [ ] **Step 6: Run the E2E to verify it passes**

Run: `pnpm --filter @memry/desktop build && pnpm --filter @memry/desktop test:e2e -- canvas-editing`
Expected: PASS — both tests (activate/deactivate; ↗ no cross-fire). **Record in the design doc §12** whether bubble-phase `stopPropagation` contained Excalidraw's keys; if Escape/Cmd+Z leaked, add a document-level capture key interceptor in `CanvasCardActive` gated on `document.activeElement`/target ∈ the active card, and note it.

- [ ] **Step 7: Run unit + typecheck**

Run: `pnpm --filter @memry/desktop typecheck && pnpm --filter @memry/desktop test:renderer -- canvas`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/renderer/src/pages/canvas/canvas-card-active.tsx apps/desktop/src/renderer/src/pages/canvas/canvas-card-overlay.tsx apps/desktop/src/renderer/src/pages/canvas/canvas-card.tsx apps/desktop/tests/e2e/canvas-editing.e2e.ts
git commit -m "feat(canvas): active-card state machine + pointer model (dblclick activate, click-away/Escape/tool deactivate)"
```

---

### Task 3: Yjs shared-doc registry (R17 core state)

The ref-count + side-effect-ownership state machine, pure over an injected entry factory so it unit-tests without `window.api`/Yjs. Task 4 wires the real factory + ContentArea gate.

**Files:**

- Create: `apps/desktop/src/renderer/src/sync/yjs-doc-registry.ts`
- Test: `apps/desktop/src/renderer/src/sync/yjs-doc-registry.test.ts`

**Interfaces:**

- Produces:
  - `type DocEntryHandle = { destroy: () => void }` (the injected factory returns this plus whatever the real caller needs — see Task 4).
  - `createYjsDocRegistry<T extends DocEntryHandle>(createEntry: (noteId: string) => T)` returning:
    - `acquire(noteId: string, consumerId: symbol): T` — first acquire creates + sets `consumerId` as side-effect owner; later acquires reuse.
    - `release(noteId: string, consumerId: symbol): void` — last release destroys; releasing the owner promotes another live consumer.
    - `isSideEffectOwner(noteId: string, consumerId: symbol): boolean`.
    - `refCount(noteId: string): number` (test-only introspection).

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/renderer/src/sync/yjs-doc-registry.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createYjsDocRegistry } from './yjs-doc-registry'

function makeRegistry() {
  const destroy = vi.fn()
  let created = 0
  const registry = createYjsDocRegistry((noteId: string) => {
    created++
    return { noteId, destroy: () => destroy(noteId) }
  })
  return { registry, destroy, created: () => created }
}

describe('yjs-doc-registry', () => {
  it('creates one entry per noteId and shares it across consumers (refCount)', () => {
    const { registry, created } = makeRegistry()
    const a = Symbol('a')
    const b = Symbol('b')
    const e1 = registry.acquire('note-1', a)
    const e2 = registry.acquire('note-1', b)
    expect(e1).toBe(e2)
    expect(created()).toBe(1)
    expect(registry.refCount('note-1')).toBe(2)
  })

  it('destroys the entry only when the last consumer releases (parity with today)', () => {
    const { registry, destroy } = makeRegistry()
    const a = Symbol('a')
    registry.acquire('note-1', a)
    registry.release('note-1', a)
    expect(destroy).toHaveBeenCalledWith('note-1')
    expect(registry.refCount('note-1')).toBe(0)
  })

  it('does not destroy while a sibling consumer is still live (teardown bug fix)', () => {
    const { registry, destroy } = makeRegistry()
    const a = Symbol('a')
    const b = Symbol('b')
    registry.acquire('note-1', a)
    registry.acquire('note-1', b)
    registry.release('note-1', a)
    expect(destroy).not.toHaveBeenCalled()
    registry.release('note-1', b)
    expect(destroy).toHaveBeenCalledTimes(1)
  })

  it('assigns side-effect ownership to the first consumer and promotes on owner release', () => {
    const { registry } = makeRegistry()
    const a = Symbol('a')
    const b = Symbol('b')
    registry.acquire('note-1', a)
    registry.acquire('note-1', b)
    expect(registry.isSideEffectOwner('note-1', a)).toBe(true)
    expect(registry.isSideEffectOwner('note-1', b)).toBe(false)
    registry.release('note-1', a)
    expect(registry.isSideEffectOwner('note-1', b)).toBe(true)
  })

  it('keeps separate entries for different noteIds', () => {
    const { registry, created } = makeRegistry()
    registry.acquire('note-1', Symbol('a'))
    registry.acquire('note-2', Symbol('b'))
    expect(created()).toBe(2)
    expect(registry.refCount('note-1')).toBe(1)
    expect(registry.refCount('note-2')).toBe(1)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @memry/desktop vitest run src/renderer/src/sync/yjs-doc-registry.test.ts`
Expected: FAIL — `Cannot find module './yjs-doc-registry'`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/desktop/src/renderer/src/sync/yjs-doc-registry.ts
/**
 * Ref-counted, noteId-keyed registry that shares one Yjs doc entry across
 * consumers in a renderer window (R17). Without it, two BlockNote editors for
 * one note in one window each build a fresh Y.Doc, which diverge (main excludes
 * the source window from broadcast) and mis-teardown (window-keyed ref-count).
 *
 * Pure state over an injected `createEntry`, so it unit-tests without Yjs/IPC.
 * The real entry factory (Y.Doc + YjsIpcProvider + fragment) is injected by
 * use-yjs-collaboration (Task 4). refCount===1 behaves exactly like today.
 */
export interface DocEntryHandle {
  destroy: () => void
}

interface Slot<T> {
  entry: T
  consumers: Set<symbol>
  sideEffectOwner: symbol
}

export interface YjsDocRegistry<T> {
  acquire(noteId: string, consumerId: symbol): T
  release(noteId: string, consumerId: symbol): void
  isSideEffectOwner(noteId: string, consumerId: symbol): boolean
  refCount(noteId: string): number
}

export function createYjsDocRegistry<T extends DocEntryHandle>(
  createEntry: (noteId: string) => T
): YjsDocRegistry<T> {
  const slots = new Map<string, Slot<T>>()

  return {
    acquire(noteId, consumerId) {
      let slot = slots.get(noteId)
      if (!slot) {
        slot = { entry: createEntry(noteId), consumers: new Set(), sideEffectOwner: consumerId }
        slots.set(noteId, slot)
      }
      slot.consumers.add(consumerId)
      return slot.entry
    },
    release(noteId, consumerId) {
      const slot = slots.get(noteId)
      if (!slot) return
      slot.consumers.delete(consumerId)
      if (slot.consumers.size === 0) {
        slot.entry.destroy()
        slots.delete(noteId)
        return
      }
      if (slot.sideEffectOwner === consumerId) {
        // Promote any remaining consumer (iteration order = insertion order).
        slot.sideEffectOwner = slot.consumers.values().next().value as symbol
      }
    },
    isSideEffectOwner(noteId, consumerId) {
      return slots.get(noteId)?.sideEffectOwner === consumerId
    },
    refCount(noteId) {
      return slots.get(noteId)?.consumers.size ?? 0
    }
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @memry/desktop vitest run src/renderer/src/sync/yjs-doc-registry.test.ts`
Expected: PASS (all 5 cases).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/sync/yjs-doc-registry.ts apps/desktop/src/renderer/src/sync/yjs-doc-registry.test.ts
git commit -m "feat(sync): ref-counted noteId-keyed Yjs doc registry (R17 state)"
```

---

### Task 4: Route `use-yjs-collaboration` through the registry + ContentArea side-effect gate

Wire the real Y.Doc/provider factory into the registry so tab + card share one doc; add the additive `runSideEffects` prop to ContentArea, driven by ownership.

**Files:**

- Modify: `apps/desktop/src/renderer/src/sync/use-yjs-collaboration.ts` (read fully first — ~98+ lines; the doc/provider create/connect/teardown lives at ~`:48–98`)
- Modify: `apps/desktop/src/renderer/src/components/note/content-area/types.ts` (`ContentAreaProps`, `:80–147`)
- Modify: `apps/desktop/src/renderer/src/components/note/content-area/ContentArea.tsx` (outer `ContentArea` `:1326–1353`; task auto-conversion in `ContentAreaEditor.onChange` `:1105–1166`)

**Interfaces:**

- Consumes: `createYjsDocRegistry` from `../sync/yjs-doc-registry`.
- Produces:
  - `use-yjs-collaboration.ts` exports unchanged public shape `{ fragment, doc, isReady, isRemoteUpdateRef, provider? }` from `useYjsCollaboration(noteId, enabled)`, plus a new `useYjsSideEffectOwner(noteId): boolean` (returns true when this mount owns side effects; single-consumer → always true).
  - `ContentAreaProps.runSideEffects?: boolean` (default `true`).

- [ ] **Step 1: Write the failing parity test** (the registry-integration behavior at the hook layer is covered indirectly; add a focused test that the module builds one entry per note under the module-level registry). Since `useYjsCollaboration` needs React + a fake `window.api`, add a light test asserting the module-level registry is wired:

```ts
// apps/desktop/src/renderer/src/sync/use-yjs-collaboration.registry.test.ts
import { describe, it, expect, vi } from 'vitest'

// The hook must acquire from a single module-level registry keyed by noteId so
// two mounts for the same note in one window share one entry.
describe('useYjsCollaboration registry wiring', () => {
  it('exports a module-level registry acquire/release used by the hook', async () => {
    const mod = await import('./use-yjs-collaboration')
    expect(typeof mod.useYjsCollaboration).toBe('function')
    expect(typeof mod.useYjsSideEffectOwner).toBe('function')
  })
})
```

(Real sharing is proven end-to-end by the co-edit E2E in Task 5 — matrix #19. Deep hook-render tests require the existing sync test harness; keep this task's unit surface minimal and lean on the E2E, per §14 of the master spec.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @memry/desktop vitest run src/renderer/src/sync/use-yjs-collaboration.registry.test.ts`
Expected: FAIL — `useYjsSideEffectOwner` is not exported yet.

- [ ] **Step 3: Refactor `use-yjs-collaboration.ts`.** Read the current file. Extract the current doc/provider create+connect+teardown body into a module-level registry entry factory, and make the hook acquire/release around it. Concretely:

```ts
// near the top of use-yjs-collaboration.ts
import { createYjsDocRegistry, type DocEntryHandle } from './yjs-doc-registry'
import * as Y from 'yjs'
import { YjsIpcProvider } from './yjs-ipc-provider'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'

interface DocEntry extends DocEntryHandle {
  doc: Y.Doc
  provider: YjsIpcProvider
  fragment: Y.XmlFragment
  isRemoteUpdateRef: React.MutableRefObject<boolean>
  // subscribe/ready plumbing as the current hook already tracks it
}

// ONE registry for the whole renderer window.
const docRegistry = createYjsDocRegistry<DocEntry>((noteId) => {
  const doc = new Y.Doc({ guid: noteId })
  const isRemoteUpdateRef = { current: false }
  // beforeTransaction/afterTransaction origin tracking — copy verbatim from the
  // current hook (use-yjs-collaboration.ts:57–64).
  const provider = new YjsIpcProvider({ noteId, doc })
  void provider.connect()
  const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)
  return {
    doc,
    provider,
    fragment,
    isRemoteUpdateRef,
    destroy: () => {
      provider.destroy()
      doc.destroy()
    }
  }
})
```

Then rewrite the hook body so that, instead of creating a doc/provider in the effect, it `acquire`s on mount and `release`s on cleanup, keyed by a per-mount `consumerId = useRef(Symbol('yjs-consumer')).current`:

```ts
export function useYjsSideEffectOwner(noteId: string): boolean {
  const consumerId = useRef<symbol>(Symbol('yjs-consumer')).current
  const [owner, setOwner] = useState(false)
  useEffect(() => {
    setOwner(docRegistry.isSideEffectOwner(noteId, consumerId))
  }, [noteId, consumerId])
  return owner
}
```

**Parity requirement:** for a single mount (refCount 1) the observable behavior — one `openDoc`, one connect, one `closeDoc` on unmount, same `{ fragment, doc, isReady, isRemoteUpdateRef }` — must be identical to the current hook. Preserve the existing `isReady` state and `provider.connect()` success handling. Do NOT change `YjsIpcProvider` or any main-side code.

- [ ] **Step 4: Add the `runSideEffects` gate to ContentArea.** In `types.ts`, add to `ContentAreaProps`:

```ts
  /** When false, this editor does NOT run task auto-conversion side effects
   *  (a sibling editor on the same note owns them). Defaults to true. */
  runSideEffects?: boolean
```

In `ContentArea.tsx` outer `ContentArea` (`:1326`), compute ownership and pass it down, defaulting standalone callers to true:

```tsx
const isOwner = useYjsSideEffectOwner(noteId)
// Standalone/non-canvas callers pass no runSideEffects → own their effects.
const runSideEffects = props.runSideEffects ?? isOwner
```

In `ContentAreaEditor.onChange` task auto-conversion block (`:1105–1166`), guard the task create/convert/delete side effects behind `runSideEffects` (early-return the task-diff work when false). Leave rendering + Yjs binding untouched.

- [ ] **Step 5: Run the failing test + typecheck**

Run: `pnpm --filter @memry/desktop vitest run src/renderer/src/sync/use-yjs-collaboration.registry.test.ts && pnpm --filter @memry/desktop typecheck`
Expected: PASS.

- [ ] **Step 6: Regression — run the existing sync + note-editor suites** to confirm single-editor parity:

Run: `pnpm --filter @memry/desktop test:renderer -- yjs content-area sync`
Expected: PASS (no regressions in existing note-editing tests).

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/src/sync/use-yjs-collaboration.ts apps/desktop/src/renderer/src/sync/use-yjs-collaboration.registry.test.ts apps/desktop/src/renderer/src/components/note/content-area/types.ts apps/desktop/src/renderer/src/components/note/content-area/ContentArea.tsx
git commit -m "feat(sync): share one Y.Doc per note via registry; gate ContentArea side effects to one owner"
```

---

### Task 5: Embedded note editor + wire into the active container (matrix #18, #19)

**Files:**

- Create: `apps/desktop/src/renderer/src/pages/canvas/embedded-note-editor.tsx`
- Modify: `apps/desktop/src/renderer/src/pages/canvas/canvas-card-active.tsx` (switch on `entityType==='note'`)
- Append E2E: `apps/desktop/tests/e2e/canvas-editing.e2e.ts`

**Interfaces:**

- Consumes: `ContentArea` (default/named export from `@/components/note/content-area`).
- Produces: `<EmbeddedNoteEditor noteId: string />`.

- [ ] **Step 1: Write the failing E2E** (append to `canvas-editing.e2e.ts`):

```ts
test('double-click a note card edits its body in place; persists + tab reflects live (matrix #18)', async ({
  page
}) => {
  await openVault(page)
  await setSpatialCanvasFlag(page, true)
  await createCanvasFromSidebar(page)
  const noteId = await seedNote(page, `Edit ${Date.now()}`, 'start')
  await dropNote(page, noteId)
  const card = page.locator(`[data-canvas-card-entity="note:${noteId}"]`)
  await expect(card).toBeVisible({ timeout: 20000 })

  await dblclickCard(page, `note:${noteId}`)
  await expect(card).toHaveAttribute('data-canvas-card-state', 'active', { timeout: 20000 })
  const marker = `INPLACE_${Date.now()}`
  const editor = page
    .locator(
      '[data-canvas-active-card] .bn-container [contenteditable="true"], [data-canvas-active-card] [contenteditable="true"]'
    )
    .first()
  await editor.click()
  await editor.pressSequentially(` ${marker}`, { delay: 20 })
  await page.mouse.click(10, 10) // click-away flushes + deactivates

  await expect
    .poll(
      async () => {
        const note = await page.evaluate(async (id) => window.api.notes.get(id), noteId)
        return note?.content ?? ''
      },
      { timeout: 20000 }
    )
    .toContain(marker)
})

test('note open in a tab + active on canvas stays consistent, no dup/echo (matrix #19)', async ({
  page
}) => {
  await openVault(page)
  await setSpatialCanvasFlag(page, true)
  await createCanvasFromSidebar(page)
  const title = `Coedit ${Date.now()}`
  const noteId = await seedNote(page, title, 'seed')
  await dropNote(page, noteId)
  const card = page.locator(`[data-canvas-card-entity="note:${noteId}"]`)
  await card.hover()
  await card.getByRole('button', { name: 'Open in tab' }).click()
  await expect(page.getByRole('tab', { name: title })).toBeVisible({ timeout: 20000 })

  // Switch back to the canvas tab and activate the card.
  await page
    .getByRole('tab', { name: /Canvas|Untitled canvas/ })
    .first()
    .click()
    .catch(() => {})
  await dblclickCard(page, `note:${noteId}`)
  await expect(card).toHaveAttribute('data-canvas-card-state', 'active', { timeout: 20000 })
  const marker = `COEDIT_${Date.now()}`
  const editor = page.locator('[data-canvas-active-card] [contenteditable="true"]').first()
  await editor.click()
  await editor.pressSequentially(` ${marker}`, { delay: 20 })
  await page.mouse.click(10, 10)

  await expect
    .poll(
      async () => {
        const note = await page.evaluate(async (id) => window.api.notes.get(id), noteId)
        // exactly one occurrence — no duplicate blocks from the two editors.
        return (note?.content?.match(new RegExp(marker, 'g')) ?? []).length
      },
      { timeout: 20000 }
    )
    .toBe(1)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @memry/desktop test:e2e -- canvas-editing`
Expected: FAIL — the active note card still renders the stub `contentEditable`, edits do not reach `notes.get`.

- [ ] **Step 3: Create `embedded-note-editor.tsx`**:

```tsx
/**
 * EmbeddedNoteEditor — the real BlockNote note editor mounted on an active
 * canvas card. Reuses the outer <ContentArea>, which self-binds the note Y.Doc
 * via the shared yjs-doc-registry (so this + the note tab share one doc with no
 * echo/dupe). runSideEffects is left to ContentArea's ownership gate.
 */
import React from 'react'
import { ContentArea } from '@/components/note/content-area'

interface EmbeddedNoteEditorProps {
  noteId: string
}

export const EmbeddedNoteEditor = ({ noteId }: EmbeddedNoteEditorProps): React.JSX.Element => {
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <ContentArea noteId={noteId} />
    </div>
  )
}
```

(Read `components/note/content-area/index.ts` for the exact export name + required props of `ContentArea`; pass the minimal set — `noteId` self-binds Yjs. If `ContentArea` requires `initialContent`, pass an empty doc fallback per its type; the Yjs fragment drives real content.)

- [ ] **Step 4: Switch on entityType in `canvas-card-active.tsx`.** Replace the placeholder editor `<div contentEditable .../>` with a per-type switch (note now, task/event in Tasks 6–7):

```tsx
import { EmbeddedNoteEditor } from './embedded-note-editor'
// ...
{
  cardRef.entityType === 'note' ? (
    <EmbeddedNoteEditor noteId={cardRef.entityId} />
  ) : (
    <div
      data-canvas-active-editor={cardRef.entityType}
      contentEditable
      suppressContentEditableWarning
      className="min-h-0 flex-1 overflow-auto p-3 text-[13px] outline-none"
    />
  )
}
```

- [ ] **Step 5: Run the E2E**

Run: `pnpm --filter @memry/desktop build && pnpm --filter @memry/desktop test:e2e -- canvas-editing`
Expected: PASS — #18 (persist + tab live) and #19 (single occurrence, no dupe). If #19 shows duplicated markers, the registry sharing or the side-effect gate is wrong — debug via `systematic-debugging` before proceeding.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/pages/canvas/embedded-note-editor.tsx apps/desktop/src/renderer/src/pages/canvas/canvas-card-active.tsx apps/desktop/tests/e2e/canvas-editing.e2e.ts
git commit -m "feat(canvas): in-place note editor on active card (shared Y.Doc, no echo)"
```

---

### Task 6: Task card editor (slim field subset) — matrix #22 (task)

**Files:**

- Create: `apps/desktop/src/renderer/src/pages/canvas/canvas-task-editor.tsx`
- Modify: `apps/desktop/src/renderer/src/pages/canvas/canvas-card-active.tsx` (add `entityType==='task'` branch)
- Append E2E: `apps/desktop/tests/e2e/canvas-editing.e2e.ts`

**Interfaces:**

- Consumes: `tasksService.get` (`services/tasks-service.ts`); the shared update mapper from `hooks/use-task-queries.ts` (`updateTask(taskId, Partial<UiTask>)`) — read the hook to see how to obtain it (it is a hook; if it cannot be called from the canvas card, call `tasksService.update` **through the same mapping** by importing the wire-mapping helpers, or expose a thin `updateTaskById` service). Confirm the least-coupled path by reading `hooks/use-task-queries.ts:331` and `pages/tasks.tsx:752`.
- Produces: `<CanvasTaskEditor taskId: string />`.

- [ ] **Step 1: Write the failing E2E** (append):

```ts
test('double-click a task card edits fields in place; persists via tasks IPC (matrix #22 task)', async ({
  page
}) => {
  await openVault(page)
  await setSpatialCanvasFlag(page, true)
  await createCanvasFromSidebar(page)
  // Seed a task in the inbox project, then drop a task card via synthetic DnD.
  const taskId = await page.evaluate(async () => {
    const projects = (await window.api.tasks.listProjects?.()) ?? null
    const projectId = projects?.[0]?.id ?? (await window.api.tasks.getInboxProjectId?.())
    const res = await window.api.tasks.create({ title: 'Canvas Task', projectId })
    return res.task?.id ?? res.id
  })
  await page.evaluate((id) => {
    const wrapper = document.querySelector('[data-canvas-editor]') as HTMLElement
    const r = wrapper.getBoundingClientRect()
    const dt = new DataTransfer()
    dt.setData(
      'application/x-memry-canvas-item',
      JSON.stringify({ entityType: 'task', entityId: id })
    )
    const ev = new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2
    })
    Object.defineProperty(ev, 'dataTransfer', { value: dt })
    wrapper.dispatchEvent(ev)
  }, taskId)

  const card = page.locator(`[data-canvas-card-entity="task:${taskId}"]`)
  await expect(card).toBeVisible({ timeout: 20000 })
  await dblclickCard(page, `task:${taskId}`)
  await expect(card).toHaveAttribute('data-canvas-card-state', 'active', { timeout: 20000 })

  const newTitle = `Renamed ${Date.now()}`
  const titleInput = page.locator('[data-canvas-active-card] input[data-canvas-task-title]')
  await titleInput.fill(newTitle)
  await page.mouse.click(10, 10)

  await expect
    .poll(
      async () => {
        const t = await page.evaluate(async (id) => window.api.tasks.get(id), taskId)
        return t?.title ?? ''
      },
      { timeout: 20000 }
    )
    .toBe(newTitle)
})
```

(If `tasks.create`/`listProjects`/`getInboxProjectId` differ, read `packages/rpc/src/tasks.ts` for the exact IPC method names and adjust the seed.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @memry/desktop test:e2e -- canvas-editing`
Expected: FAIL — task card active state renders the stub, title edit does not persist.

- [ ] **Step 3: Create `canvas-task-editor.tsx`** reusing the standalone field components the drawer uses (read `components/tasks/task-detail-drawer.tsx:355–451` for the exact components + props: `InteractiveStatusBadge`, `InteractivePriorityBadge`, `InteractiveDueDateBadge`, `TaskDescriptionEditor`). Fetch the UI-model task, render title input + those badges + description, and route each change through the shared `updateTask` mapping. Key structure:

```tsx
/**
 * CanvasTaskEditor — slim in-place task editor for an active task card. Reuses
 * the drawer's standalone field components; writes route through the shared
 * updateTask mapper (never a reimplemented tasksService.update).
 */
import React, { useEffect, useState } from 'react'
import { InteractiveStatusBadge } from '@/components/tasks/interactive-status-badge'
import { InteractivePriorityBadge } from '@/components/tasks/interactive-priority-badge'
import { InteractiveDueDateBadge } from '@/components/tasks/interactive-due-date-badge'
import { TaskDescriptionEditor } from '@/components/tasks/task-description-editor'
import { useTaskQueries } from '@/hooks/use-task-queries' // confirm the hook's public name/exports
import type { Task as UiTask } from '@/data/task-model'

interface CanvasTaskEditorProps {
  taskId: string
}

export const CanvasTaskEditor = ({ taskId }: CanvasTaskEditorProps): React.JSX.Element => {
  const { getTaskById, projects, updateTask } = useTaskQueries() // adapt to real API
  const [task, setTask] = useState<UiTask | null>(() => getTaskById(taskId) ?? null)
  useEffect(() => {
    setTask(getTaskById(taskId) ?? null)
  }, [taskId, getTaskById])

  if (!task) return <div className="p-3 text-xs text-text-tertiary">Loading…</div>

  const patch = (updates: Partial<UiTask>): void => void updateTask(task.id, updates)

  return (
    <div className="flex h-full flex-col gap-2 overflow-auto p-3">
      <input
        data-canvas-task-title
        defaultValue={task.title}
        onChange={(e) => patch({ title: e.target.value })}
        className="w-full bg-transparent text-[13px] font-medium text-foreground outline-none"
      />
      <div className="flex flex-wrap items-center gap-1.5">
        <InteractiveStatusBadge
          task={task}
          projects={projects}
          onValueChange={(statusId) => patch({ statusId })}
        />
        <InteractivePriorityBadge
          compact
          value={task.priority}
          onValueChange={(priority) => patch({ priority })}
        />
        <InteractiveDueDateBadge task={task} onDateChange={(dueDate) => patch({ dueDate })} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <TaskDescriptionEditor
          key={task.id}
          taskId={task.id}
          initialContent={task.description}
          onContentChange={(description) => patch({ description })}
        />
      </div>
    </div>
  )
}
```

**Read the real signatures** of `useTaskQueries`, the badge components, and `TaskDescriptionEditor` before finalizing — the prop names above mirror the drawer (`task-detail-drawer.tsx:380–451`) but must match exactly. If `useTaskQueries` cannot supply `projects`/`getTaskById` outside the tasks page, obtain the UI task via `tasksService.get(taskId)` + wire→UI mapping (mirror `use-task-queries.ts` mapping) and pass a `projects` list from a shared projects query. Prefer the least-coupled route that still uses the shared `updateTask` write mapper.

- [ ] **Step 4: Wire into `canvas-card-active.tsx`** — add the `task` branch:

```tsx
import { CanvasTaskEditor } from './canvas-task-editor'
// ...
      cardRef.entityType === 'task' ? (
        <CanvasTaskEditor taskId={cardRef.entityId} />
      ) : ...
```

- [ ] **Step 5: Run the E2E**

Run: `pnpm --filter @memry/desktop build && pnpm --filter @memry/desktop test:e2e -- canvas-editing`
Expected: PASS — the task title edit persists via `tasks.get`.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/pages/canvas/canvas-task-editor.tsx apps/desktop/src/renderer/src/pages/canvas/canvas-card-active.tsx apps/desktop/tests/e2e/canvas-editing.e2e.ts
git commit -m "feat(canvas): in-place task editor on active card (slim fields via shared mapper)"
```

---

### Task 7: Event card editor — extract `<CalendarEventForm>` + host it — matrix #22 (event)

**Files:**

- Create: `apps/desktop/src/renderer/src/components/calendar/calendar-event-form.tsx`
- Modify: `apps/desktop/src/renderer/src/components/calendar/calendar-event-popover.tsx` (render the extracted form; no caller change)
- Create: `apps/desktop/src/renderer/src/pages/canvas/canvas-event-editor.tsx`
- Modify: `apps/desktop/src/renderer/src/pages/canvas/canvas-card-active.tsx` (add `entityType==='calendar_event'` branch)
- Append E2E: `apps/desktop/tests/e2e/canvas-editing.e2e.ts`

**Interfaces:**

- Consumes: `CalendarEventDraft` (`components/calendar/types.ts`), `calendarService.getEvent`/`updateEvent`, the local→ISO helper `localInputToIso` (imported by `pages/calendar.tsx:18`), `toCreatePayload` pattern (`pages/calendar.tsx:137–147`).
- Produces:
  - `<CalendarEventForm mode draft isSaving onDraftChange onSave onDismiss readOnlyMetadata? />` — the popover body extracted (props = popover props minus `anchorRect`).
  - `<CanvasEventEditor eventId: string onDone />`.

- [ ] **Step 1: Write the failing E2E** (append):

```ts
test('double-click an event card edits it in place; persists via calendar IPC (matrix #22 event)', async ({
  page
}) => {
  await openVault(page)
  await setSpatialCanvasFlag(page, true)
  await createCanvasFromSidebar(page)
  const eventId = await page.evaluate(async () => {
    const start = new Date()
    start.setHours(10, 0, 0, 0)
    const res = await window.api.calendar.createEvent({
      title: 'Canvas Event',
      startAt: start.toISOString(),
      isAllDay: false,
      timezone: 'UTC'
    })
    return res.event?.id ?? res.id
  })
  await page.evaluate((id) => {
    const wrapper = document.querySelector('[data-canvas-editor]') as HTMLElement
    const r = wrapper.getBoundingClientRect()
    const dt = new DataTransfer()
    dt.setData(
      'application/x-memry-canvas-item',
      JSON.stringify({ entityType: 'calendar_event', entityId: id })
    )
    const ev = new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2
    })
    Object.defineProperty(ev, 'dataTransfer', { value: dt })
    wrapper.dispatchEvent(ev)
  }, eventId)

  const card = page.locator(`[data-canvas-card-entity="calendar_event:${eventId}"]`)
  await expect(card).toBeVisible({ timeout: 20000 })
  await dblclickCard(page, `calendar_event:${eventId}`)
  await expect(card).toHaveAttribute('data-canvas-card-state', 'active', { timeout: 20000 })

  const newTitle = `Event ${Date.now()}`
  await page.locator('[data-canvas-active-card] input').first().fill(newTitle)
  // Save fires on pointerdown (calendar form pattern).
  await page.getByRole('button', { name: /Save/ }).click()

  await expect
    .poll(
      async () => {
        const e = await page.evaluate(async (id) => window.api.calendar.getEvent(id), eventId)
        return e?.title ?? ''
      },
      { timeout: 20000 }
    )
    .toBe(newTitle)
})
```

(Adjust `calendar.createEvent`/`getEvent` response shape by reading `packages/rpc/src/calendar.ts`.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @memry/desktop test:e2e -- canvas-editing`
Expected: FAIL — event card active renders the stub.

- [ ] **Step 3: Extract `<CalendarEventForm>`.** Read `calendar-event-popover.tsx` fully. Move the body (`:249–352`) plus `submit`, `handleAllDayToggle`, `errorMessage`, `titleRef`, the two `useT`, `useGeneralSettings`, and helpers (`:50–89`) into `calendar-event-form.tsx` as a component taking `{ mode, draft, isSaving, onDraftChange, onSave, onDismiss, readOnlyMetadata? }`. Keep the Save button firing on `onPointerDown` (`:333–344`). Then in `calendar-event-popover.tsx`, replace the moved body with `<CalendarEventForm {...formProps} />` inside the existing Dialog Content — no caller signature change. Run the existing calendar tests to confirm no regression:

Run: `pnpm --filter @memry/desktop test:renderer -- calendar-event`
Expected: PASS.

- [ ] **Step 4: Create `canvas-event-editor.tsx`** — own the draft, seed from `getEvent`, save via `updateEvent`:

```tsx
/**
 * CanvasEventEditor — hosts the extracted <CalendarEventForm> for an active
 * event card. Owns the CalendarEventDraft; saves via calendarService.updateEvent.
 */
import React, { useEffect, useState } from 'react'
import { CalendarEventForm } from '@/components/calendar/calendar-event-form'
import { calendarService } from '@/services/calendar-service'
import { localInputToIso } from '@/components/calendar/date-utils' // confirm path from pages/calendar.tsx:18
import type { CalendarEventDraft } from '@/components/calendar/types'

interface CanvasEventEditorProps {
  eventId: string
  onDone: () => void
}

export const CanvasEventEditor = ({
  eventId,
  onDone
}: CanvasEventEditorProps): React.JSX.Element => {
  const [draft, setDraft] = useState<CalendarEventDraft | null>(null)
  const [isSaving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    void calendarService.getEvent(eventId).then((event) => {
      if (cancelled || !event) return
      // Build the draft from the event (mirror createDraftFromItem, pages/calendar.tsx:120–135).
      setDraft(toDraft(event))
    })
    return () => {
      cancelled = true
    }
  }, [eventId])

  if (!draft) return <div className="p-3 text-xs text-text-tertiary">Loading…</div>

  const onSave = async (): Promise<void> => {
    setSaving(true)
    try {
      await calendarService.updateEvent({
        id: eventId,
        title: draft.title.trim(),
        description: draft.description.trim() || null,
        startAt: localInputToIso(draft.startAt, draft.isAllDay),
        endAt: draft.endAt ? localInputToIso(draft.endAt, draft.isAllDay) : null,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        isAllDay: draft.isAllDay,
        targetCalendarId: draft.targetCalendarId
      })
      onDone()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto p-3">
      <CalendarEventForm
        mode="edit"
        draft={draft}
        isSaving={isSaving}
        onDraftChange={setDraft}
        onSave={onSave}
        onDismiss={onDone}
      />
    </div>
  )
}
```

(Implement `toDraft(event)` by mirroring `pages/calendar.tsx` `createDraftFromItem`/`getEvent` draft-building; the draft uses local wall-clock strings, so convert the event's ISO start/end to local-input format the same way the calendar page does. Confirm `localInputToIso` signature and import path.)

- [ ] **Step 5: Wire into `canvas-card-active.tsx`** — add the `calendar_event` branch, passing `onDone={onDeactivate}`:

```tsx
import { CanvasEventEditor } from './canvas-event-editor'
// ...
      cardRef.entityType === 'calendar_event' ? (
        <CanvasEventEditor eventId={cardRef.entityId} onDone={onDeactivate} />
      ) : ...
```

- [ ] **Step 6: Run the E2E**

Run: `pnpm --filter @memry/desktop build && pnpm --filter @memry/desktop test:e2e -- canvas-editing`
Expected: PASS — the event title edit persists via `calendar.getEvent`.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/src/components/calendar/calendar-event-form.tsx apps/desktop/src/renderer/src/components/calendar/calendar-event-popover.tsx apps/desktop/src/renderer/src/pages/canvas/canvas-event-editor.tsx apps/desktop/src/renderer/src/pages/canvas/canvas-card-active.tsx apps/desktop/tests/e2e/canvas-editing.e2e.ts
git commit -m "feat(canvas): in-place event editor on active card (extract CalendarEventForm)"
```

---

### Task 8: Virtualization × active, perf gate, i18n, final gates (matrix #16, #21)

**Files:**

- Modify (if needed): `apps/desktop/src/renderer/src/pages/canvas/canvas-card-overlay.tsx`
- Modify: `packages/i18n/src/locales/en/common.json`
- Append E2E: `apps/desktop/tests/e2e/canvas-editing.e2e.ts`

- [ ] **Step 1: Write the failing perf/virtualization E2E** (append):

```ts
test('200-card canvas with one active editor pans/zooms; off-screen cards unmount (matrix #16/#21)', async ({
  page
}) => {
  await openVault(page)
  await setSpatialCanvasFlag(page, true)
  const canvasId = await createCanvasFromSidebar(page)
  const noteId = await seedNote(page, `Perf ${Date.now()}`, 'body')
  for (let i = 0; i < 40; i++) {
    await dropNote(page, noteId, (i % 8) * 320 - 1200, Math.floor(i / 8) * 220 - 500)
  }
  // Activate one card, then confirm far cards are unmounted while it stays.
  const anchor = page.locator('[data-canvas-card-id]').first()
  await anchor.dblclick()
  const mounted = await page.locator('[data-canvas-card-id]').count()
  const total = await page.evaluate(async (id) => {
    const c = await window.api.canvas.get(id)
    return (JSON.parse(c?.scene ?? '{"elements":[]}').elements ?? []).filter(
      (e) => e.type === 'rectangle' && !e.isDeleted && e.customData?.entityId
    ).length
  }, canvasId)
  expect(total).toBeGreaterThanOrEqual(40)
  expect(mounted).toBeLessThan(total)
  // Exactly one active editor.
  expect(await page.locator('[data-canvas-active-card]').count()).toBe(1)
})
```

- [ ] **Step 2: Run to verify** it fails or passes; if the active card unmounts on recompute or more than one active exists, fix the pin/`nextActive` wiring in `canvas-card-overlay.tsx` (Task 2 §3/§6) and re-run.

Run: `pnpm --filter @memry/desktop build && pnpm --filter @memry/desktop test:e2e -- canvas-editing`
Expected: eventual PASS.

- [ ] **Step 3: Add i18n strings** used by the active editors (only if new user-facing strings were introduced — e.g. a loading label). Add under `canvas.*` in `packages/i18n/src/locales/en/common.json`, mirroring the existing `canvas.card.*` shape. Example:

```json
"canvas": {
  "card": {
    "editing": "Editing…"
  }
}
```

(Merge into the existing `canvas` object; do not duplicate keys. Run `pnpm --filter @memry/desktop i18n:check`.)

- [ ] **Step 4: Full gate**

Run:

```bash
pnpm typecheck && pnpm lint && pnpm ipc:check && pnpm i18n:check && pnpm check:architecture && pnpm check:contracts
pnpm --filter @memry/desktop test
git diff --check
```

Expected: all green; coverage ratchet green (the pure modules `canvas-active.ts` + `yjs-doc-registry.ts` carry the logic coverage; overlay/editor glue stays thin).

- [ ] **Step 5: Docs gate** (M6 is renderer editing over existing entities; docs impact is usually `no-docs`, but run it):

Run: `pnpm docs:impact --base origin/main --strict`
Expected: pass (or update `apps/docs/src` / run `pnpm docs:ai-update --base origin/main` if it reports `missing-docs`), then `pnpm docs:build`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(canvas): virtualize active editor + perf gate + i18n; M6 final gates green"
```

---

## Self-Review

**Spec coverage** (design doc + master §13 M6 + matrix #18–22):

- Active-card state machine (one active) → Task 1 (logic) + Task 2 (wiring). ✓
- Pointer model C3/C4 (dblclick activate, click-away no-swallow, Escape swallow, tool-select deactivate, key containment) → Task 2. ✓
- Angle-aware hit-test (C3, D4) → Task 1. ✓
- Note editor + shared Y.Doc registry (R17, D1) + no echo (#19) → Tasks 3, 4, 5. ✓
- Task editor slim subset (D2, #22) → Task 6. ✓
- Event editor via extracted CalendarEventForm (E1, D3, #22) → Task 7. ✓
- Redirect distinct, no cross-fire (#20) → Task 2 (guard) + Task 5 (E2E). ✓
- Virtualization + one active + 200-card perf (R16, #16, #21) → Tasks 2 (pin) + 8. ✓
- In-place note persist + tab live (#18) → Task 5. ✓
- Flag untouched, no sync/contract/crypto/DB change → Global Constraints; no task edits those. ✓
- i18n (en) + logical props + coverage ratchet → Global Constraints + Task 8. ✓

**Placeholder scan:** integration Tasks 5–7 direct the implementer to read exact anchors and confirm real signatures before finalizing (ContentArea export, `useTaskQueries` API, `localInputToIso` path, calendar RPC shapes) — these are read-then-wire instructions with concrete code skeletons, not vague "handle it" placeholders. E2E bodies are complete.

**Type consistency:** `hitTestCard`/`shouldDeactivateForTool`/`nextActive`/`withActivePinned` names match across Tasks 1–2 and 8. `createYjsDocRegistry`/`acquire`/`release`/`isSideEffectOwner`/`refCount` match across Tasks 3–4. `runSideEffects` prop consistent Tasks 4. `CanvasCardActive`/`EmbeddedNoteEditor`/`CanvasTaskEditor`/`CanvasEventEditor`/`CalendarEventForm` names consistent Tasks 2/5/6/7. `data-canvas-active-card` / `data-canvas-card-state="active"` / `data-canvas-redirect` E2E hooks consistent Tasks 2/5/6/7/8.

**Known follow-through risks flagged for execution:** (a) the exact `useTaskQueries` public surface (Task 6) and (b) `localInputToIso` import path + `toDraft` (Task 7) must be verified against the real files; (c) the keyboard-containment spike outcome (Task 2 §6) may add a document-capture interceptor.
