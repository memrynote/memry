# Marquee Margin Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend block marquee selection so users can start the drag from the empty gray strip on the left/right of the BlockNote editor (the `px-24` padding around the centered note content), not just from inside `.bn-container`.

**Architecture:** Lift the marquee mousedown listener from `.bn-container` (inside `ContentArea`) up to a new `marquee-zone` wrapper in `pages/note.tsx`. The wrapper uses `-mx-24 px-24` to extend its hit area into the parent's 96px horizontal padding without changing visual layout. Refactor `useBlockMarqueeSelection` to take two refs/elements: a `triggerContainerEl` (where the listener attaches and where the overlay is rendered, in *its* coordinate space) and a `blockContainerRef` (the existing `.bn-container`, used only for `.bn-block` queries + ordering). The overlay is rendered into the wrapper via `createPortal`. The existing `focus-at-end` `onMouseDown` handler moves up from `editor-click-area` to the new wrapper so clicks anywhere around the editor still focus it at end.

**Tech Stack:** React 19, BlockNote (shadcn), Tailwind, TypeScript strict, Playwright (Electron) for e2e.

---

## Out of scope

- Extending the trigger zone past the parent's `px-24` padding into the truly outer gray space on viewports > 64rem (would require attaching at the scroll-container level with broader filters; explicitly declined in clarifying questions).
- Reworking BlockNote's internal selection model.
- Changing how the selection commits to ProseMirror (`editor.setSelection(firstId, lastId)`) — that path is unchanged.
- Touch / pen input support — mouse only, matching current implementation.

---

## File Structure

**Modify:**
- `apps/desktop/src/renderer/src/components/note/content-area/hooks/use-block-marquee-selection.ts`
  - Refactor: split `containerRef` into `blockContainerRef` (for `.bn-block` queries) + `triggerContainerEl` (for listeners + overlay coords).
  - Switch from `onContainerMouseDownCapture` (React handler returned to caller) to imperative `addEventListener` on the trigger element via `useEffect`. Caller no longer attaches anything in JSX.
  - Move `data-marquee-active` from `containerRef.current` to `triggerContainerEl`.
  - Update outside-click detector to consult the trigger element.
  - Keep `getOrderedBlockIds` scoped to `blockContainerRef.current` so we never accidentally pick up `.bn-block` elements from elsewhere on the page.
  - Remove `onContainerMouseDownCapture` from the return shape.

- `apps/desktop/src/renderer/src/components/note/content-area/ContentArea.tsx`
  - Accept new optional prop `marqueeZoneEl: HTMLDivElement | null`.
  - Pass `editorContainerRef` (the `.bn-container` ref) as `blockContainerRef`, and `marqueeZoneEl` as `triggerContainerEl` to the marquee hook. Fall back to the inner ref's element when `marqueeZoneEl` is `null` (e.g. tests, embedded uses) so behavior is unchanged for any other caller.
  - Remove `onMouseDownCapture={marquee.onContainerMouseDownCapture}` and `data-marquee-active` from the inline `.bn-container` div.
  - Stop rendering `<BlockMarqueeOverlay>` inline; render it via `createPortal` into `marqueeZoneEl` (when present).

- `apps/desktop/src/renderer/src/components/note/content-area/types.ts`
  - Add `marqueeZoneEl?: HTMLDivElement | null` to `ContentAreaProps`.

- `apps/desktop/src/renderer/src/pages/note.tsx`
  - Add `const [marqueeZoneEl, setMarqueeZoneEl] = useState<HTMLDivElement | null>(null)`.
  - Wrap the existing `editor-click-area` div in a new `<div ref={setMarqueeZoneEl} className="marquee-zone relative -mx-24 px-24">`.
  - Move the existing `onMouseDown={...focusAtEnd...}` handler from `editor-click-area` UP to the new wrapper.
  - Pass `marqueeZoneEl={marqueeZoneEl}` to `<ContentArea />`.

- `apps/desktop/src/renderer/src/assets/base.css`
  - Replace `.bn-container[data-marquee-active='true']` selectors with `.marquee-zone[data-marquee-active='true']` selectors. Highlight + overlay rect classes (`.marquee-block-highlight`, `.marquee-overlay`) stay as-is — they're position-agnostic.
  - Update the documentation comment to reflect the new mount point ("rendered inside `.marquee-zone`, which is `position: relative`").

- `apps/desktop/tests/e2e/marquee-selection.e2e.ts`
  - Add new tests for margin-area drags (left strip → editor, right strip → editor, vertical drag entirely inside the gray strip).
  - Add a regression test that clicking (no drag) in the gray strip focuses the editor at end (no marquee fires).

**Create:** _none_

---

## Architectural Notes for Implementer

### Why a callback-ref + state instead of a `useRef` for the marquee zone

The hook needs to attach a `mousedown` listener whenever the trigger element first becomes available. `useRef` doesn't notify on `.current` change, so a `useEffect` keyed off `triggerContainerRef.current` would attach at mount time only and miss the case where the element appears later (Suspense boundaries, conditional rendering, etc.). Using `useState<HTMLDivElement | null>` + `setMarqueeZoneEl` as the JSX `ref` callback gives us a real React state change the hook can depend on.

`blockContainerRef` stays a `useRef` because it's local to `ContentArea`, only read inside event callbacks (no need for the effect to re-fire when it changes).

### Why `createPortal` for the overlay

The overlay used to live inside `.bn-container` because that's where the marquee state lived. Now the overlay must render inside `.marquee-zone` so its absolute coordinates line up with the new (larger) trigger area. But the marquee state still lives in `ContentArea` (which owns `editor`), and `.marquee-zone` lives in `note.tsx`. A portal lets `ContentArea` render into a DOM node it doesn't own without lifting state up to `note.tsx`. Cheap, idiomatic, no prop drilling of the marquee state.

### Why `-mx-24 px-24` works without clipping

The grandparent scroll container in `note-layout.tsx:61` is `overflow-y-auto overflow-x-visible`. Horizontal overflow renders, so the wrapper's negative margin extends visually into the parent's `px-24` padding zone without being clipped. The wrapper re-adds the same `px-24` padding internally so children render at the same horizontal position as before. Only the *hit area* grows.

### Coordinate space sanity check

- Block hit-test uses `el.getBoundingClientRect()` (viewport coords) for both the marquee rect (built from `clientX/Y`) and each `.bn-block`. Intersection works regardless of which container coordinates are relative to.
- Overlay positioning uses `blockRect.left - triggerBounds.left` etc. — relative to the new wrapper. `position: relative` on `.marquee-zone` makes these work.
- Clamping uses `triggerBounds`, so the marquee rectangle can extend all the way to the edge of the gray strip (the wrapper edge) and no further. Good UX.

### Focus-at-end + marquee coexistence

When the user mousedowns in the gray strip:
1. Capture phase: marquee handler runs on `.marquee-zone`, records origin, attaches global `mousemove`/`mouseup`, returns without calling `preventDefault`.
2. Bubble phase: the `onMouseDown` handler on `.marquee-zone` (moved up from `editor-click-area`) calls `e.preventDefault()` and `focusAtEndRef.current?.()`. Caret jumps to end.
3a. **No drag** → mouseup with no movement → marquee tears down without promoting → caret stays at end. Click feels like "click empty space to focus editor". ✅
3b. **Drag** → mousemove crosses promote threshold → `promote()` blurs the editor → marquee renders. The brief focus blip from step 2 is invisible because no paint happens between mousedown and the first mousemove. ✅

We do **not** rewrite focus-at-end to wait for mouseup — current behavior already works for the existing bottom-padding use case and we're matching it for the gray strip.

### What about clicks INSIDE the editor vs INSIDE the gray strip?

The `focus-at-end` handler short-circuits when the target is inside `.bn-block-content` (it lets BlockNote handle the click). The marquee `shouldStartMarquee` filter only excludes buttons / links / inputs / BlockNote menus. Both filters are unchanged — they just operate from a higher mount point.

---

## Tasks

### Task 1: Add failing e2e tests for margin-area marquee

**Files:**
- Modify: `apps/desktop/tests/e2e/marquee-selection.e2e.ts`

- [ ] **Step 1: Add a `.marquee-zone` selector constant near the existing constants**

```ts
const EDITOR_CONTAINER = '.bn-container'
const MARQUEE_ZONE = '.marquee-zone'
const EDITABLE_SELECTOR = `${EDITOR_CONTAINER} [contenteditable="true"]`
const BLOCK_SELECTOR = '.bn-block[data-id]'
const HIGHLIGHTED_SELECTOR = '.marquee-block-highlight'
const OVERLAY_SELECTOR = '.marquee-overlay'
```

- [ ] **Step 2: Add helper that returns the marquee zone bounding box**

```ts
async function getMarqueeZoneBox(page: Page) {
  const box = await page.locator(MARQUEE_ZONE).first().boundingBox()
  if (!box) throw new Error('marquee zone not found')
  return box
}
```

- [ ] **Step 3: Add the failing test "drag from left gray strip into editor selects blocks"**

Append inside the existing `test.describe('Block marquee selection', ...)` block:

```ts
test('drags from LEFT gray strip into editor and selects blocks', async ({ page }) => {
  await createNote(page, `Marquee Left Strip ${Date.now()}`)
  await focusEditor(page)
  await typeBlocks(page, [
    'First block in left-strip drag',
    'Second block in left-strip drag',
    'Third block in left-strip drag'
  ])
  await page.waitForTimeout(400)

  const zone = await getMarqueeZoneBox(page)
  const first = await getBlockBox(page, 0)
  const last = await getBlockBox(page, 2)

  // Start ~24px in from the LEFT edge of the marquee zone (well outside .bn-container)
  // at the vertical center of the first block.
  const startX = zone.x + 24
  const startY = first.y + first.height / 2
  // End in the gutter to the LEFT of the editor, level with the last block's bottom.
  const endX = zone.x + 24
  const endY = last.y + last.height - 4

  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(endX, endY, { steps: 14 })

  await expect(page.locator(OVERLAY_SELECTOR)).toBeVisible({ timeout: 2000 })
  expect(await page.locator(HIGHLIGHTED_SELECTOR).count()).toBeGreaterThanOrEqual(2)

  await page.mouse.up()
  await page.waitForTimeout(150)

  await expect(page.locator(OVERLAY_SELECTOR)).toHaveCount(0)
  expect(await page.locator(HIGHLIGHTED_SELECTOR).count()).toBeGreaterThanOrEqual(2)
})
```

- [ ] **Step 4: Add the failing test "drag from right gray strip into editor selects blocks"**

```ts
test('drags from RIGHT gray strip into editor and selects blocks', async ({ page }) => {
  await createNote(page, `Marquee Right Strip ${Date.now()}`)
  await focusEditor(page)
  await typeBlocks(page, [
    'First block in right-strip drag',
    'Second block in right-strip drag',
    'Third block in right-strip drag'
  ])
  await page.waitForTimeout(400)

  const zone = await getMarqueeZoneBox(page)
  const first = await getBlockBox(page, 0)
  const last = await getBlockBox(page, 2)

  // Start ~24px in from the RIGHT edge of the marquee zone.
  const startX = zone.x + zone.width - 24
  const startY = first.y + first.height / 2
  const endX = startX
  const endY = last.y + last.height - 4

  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(endX, endY, { steps: 14 })

  await expect(page.locator(OVERLAY_SELECTOR)).toBeVisible({ timeout: 2000 })
  expect(await page.locator(HIGHLIGHTED_SELECTOR).count()).toBeGreaterThanOrEqual(2)

  await page.mouse.up()
  await page.waitForTimeout(150)

  await expect(page.locator(OVERLAY_SELECTOR)).toHaveCount(0)
  expect(await page.locator(HIGHLIGHTED_SELECTOR).count()).toBeGreaterThanOrEqual(2)
})
```

- [ ] **Step 5: Add the regression test "click in gray strip focuses editor and does not marquee"**

```ts
test('regression: single click in gray strip focuses editor without marquee', async ({ page }) => {
  await createNote(page, `Marquee Strip Click ${Date.now()}`)
  await focusEditor(page)
  await typeBlocks(page, ['Only block for strip-click test'])
  await page.waitForTimeout(400)

  const zone = await getMarqueeZoneBox(page)
  const block = await getBlockBox(page, 0)

  await page.mouse.click(zone.x + 24, block.y + block.height / 2)
  await page.waitForTimeout(150)

  await expect(page.locator(OVERLAY_SELECTOR)).toHaveCount(0)
  await expect(page.locator(HIGHLIGHTED_SELECTOR)).toHaveCount(0)

  // Editor should be focused after the gutter click — typing appends text.
  await page.keyboard.type(' EXTRA')
  await page.waitForTimeout(150)
  const editable = page.locator(EDITABLE_SELECTOR).first()
  await expect(editable).toContainText('EXTRA')
})
```

- [ ] **Step 6: Run the new tests and confirm they fail**

Run: `pnpm --filter desktop test:e2e -- marquee-selection.e2e.ts -g "gray strip"`
Expected: the three new tests fail (locator `.marquee-zone` not found, OR overlay doesn't appear when starting outside `.bn-container`). The 6 pre-existing tests still pass.

- [ ] **Step 7: Commit the failing tests**

```bash
git add apps/desktop/tests/e2e/marquee-selection.e2e.ts
git commit -m "test: add failing e2e cases for marquee gray-strip drag"
```

---

### Task 2: Refactor `useBlockMarqueeSelection` to support a separate trigger element

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/note/content-area/hooks/use-block-marquee-selection.ts`

- [ ] **Step 1: Update the options interface**

Replace the existing `UseBlockMarqueeSelectionOptions` with:

```ts
interface UseBlockMarqueeSelectionOptions {
  editor: any
  /** The `.bn-container` ref — used to query `.bn-block[data-id]` for hit-testing + ordering. */
  blockContainerRef: React.RefObject<HTMLDivElement | null>
  /** The outer wrapper element that owns the listener and the overlay coordinate space. */
  triggerContainerEl: HTMLDivElement | null
  enabled?: boolean
}
```

- [ ] **Step 2: Update the return interface — drop `onContainerMouseDownCapture`**

```ts
interface UseBlockMarqueeSelectionReturn {
  marqueeRect: MarqueeRect | null
  highlightRects: ReadonlyArray<BlockHighlightRect>
  isActive: boolean
  selectedBlockIds: ReadonlySet<string>
  clearSelection: () => void
}
```

- [ ] **Step 3: Update destructured args + the `clearSelection` callback to use `triggerContainerEl`**

Replace the function signature line:

```ts
export function useBlockMarqueeSelection({
  editor,
  blockContainerRef,
  triggerContainerEl,
  enabled = true
}: UseBlockMarqueeSelectionOptions): UseBlockMarqueeSelectionReturn {
```

Replace the body of `clearSelection`:

```ts
const clearSelection = useCallback((): void => {
  teardownDragRef.current?.()
  teardownDragRef.current = null
  selectedRef.current = new Set()
  setSelectedBlockIds(new Set())
  setHighlightRects([])
  setMarqueeRect(null)
  setIsActive(false)
  hasSelectionRef.current = false
  if (triggerContainerEl) triggerContainerEl.removeAttribute(ACTIVE_ATTR)
}, [triggerContainerEl])
```

- [ ] **Step 4: Replace `onContainerMouseDownCapture` (React callback) with an imperative `useEffect` that attaches `mousedown`**

Delete the `onContainerMouseDownCapture = useCallback(...)` block. Replace with:

```ts
useEffect(() => {
  if (!enabled) return
  const trigger = triggerContainerEl
  if (!trigger) return

  const onMouseDown = (event: globalThis.MouseEvent): void => {
    if (event.button !== 0) return
    if (!shouldStartMarquee(event.target)) return

    const blockContainer = blockContainerRef.current
    if (!blockContainer) return

    // Mid-drag re-entry guard.
    teardownDragRef.current?.()
    teardownDragRef.current = null

    if (hasSelectionRef.current) {
      selectedRef.current = new Set()
      setSelectedBlockIds(new Set())
      setHighlightRects([])
      hasSelectionRef.current = false
    }

    const origin: OriginPoint = { clientX: event.clientX, clientY: event.clientY }
    let lastMove: OriginPoint = { clientX: event.clientX, clientY: event.clientY }
    let isMarquee = false
    let rafId: number | null = null

    const cancelRaf = (): void => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId)
        rafId = null
      }
    }

    const promote = (): void => {
      isMarquee = true
      setIsActive(true)
      trigger.setAttribute(ACTIVE_ATTR, 'true')
      try {
        const view = editor?.prosemirrorView
        const dom = view?.dom as HTMLElement | undefined
        dom?.blur()
      } catch (err) {
        log.warn('Failed to blur PM view on marquee start', err)
      }
      try {
        window.getSelection()?.removeAllRanges()
      } catch (err) {
        log.warn('Failed to clear native selection on marquee start', err)
      }
    }

    const tick = (): void => {
      rafId = null
      const triggerBounds = trigger.getBoundingClientRect()
      const clampedX = Math.max(
        triggerBounds.left,
        Math.min(lastMove.clientX, triggerBounds.right)
      )
      const clampedY = Math.max(
        triggerBounds.top,
        Math.min(lastMove.clientY, triggerBounds.bottom)
      )

      const left = Math.min(origin.clientX, clampedX)
      const right = Math.max(origin.clientX, clampedX)
      const top = Math.min(origin.clientY, clampedY)
      const bottom = Math.max(origin.clientY, clampedY)

      const blockEls = blockContainer.querySelectorAll<HTMLElement>('.bn-block[data-id]')
      const next = new Set<string>()
      const nextRects: BlockHighlightRect[] = []
      blockEls.forEach((el) => {
        const id = el.getAttribute('data-id')
        if (!id || next.has(id)) return
        const blockRect = el.getBoundingClientRect()
        if (rectsIntersect(blockRect, { left, top, right, bottom })) {
          next.add(id)
          nextRects.push({
            id,
            left: blockRect.left - triggerBounds.left,
            top: blockRect.top - triggerBounds.top,
            width: blockRect.width,
            height: blockRect.height
          })
        }
      })
      selectedRef.current = next
      setHighlightRects(nextRects)

      setMarqueeRect({
        left: left - triggerBounds.left,
        top: top - triggerBounds.top,
        width: right - left,
        height: bottom - top
      })
    }

    const onMove = (moveEvent: globalThis.MouseEvent): void => {
      lastMove = { clientX: moveEvent.clientX, clientY: moveEvent.clientY }

      if (!isMarquee) {
        const dx = Math.abs(moveEvent.clientX - origin.clientX)
        const dy = Math.abs(moveEvent.clientY - origin.clientY)
        if (dy < VERTICAL_PROMOTE_PX) return
        if (dx > HORIZONTAL_LIMIT_PX && dx > dy) return
        promote()
      }

      moveEvent.preventDefault()
      if (rafId === null) {
        rafId = requestAnimationFrame(tick)
      }
    }

    const finalize = (): void => {
      const finalIds = new Set(selectedRef.current)
      setMarqueeRect(null)
      setIsActive(false)
      trigger.removeAttribute(ACTIVE_ATTR)
      setSelectedBlockIds(finalIds)
      hasSelectionRef.current = finalIds.size > 0
      if (finalIds.size === 0) setHighlightRects([])

      if (finalIds.size >= 2) {
        const ordered = getOrderedBlockIds(blockContainer, finalIds)
        if (ordered.length >= 2) {
          const firstId = ordered[0]
          const lastId = ordered[ordered.length - 1]
          try {
            isApplyingPmSelectionRef.current = true
            editor.setSelection(firstId, lastId)
            try {
              editor.prosemirrorView?.focus?.()
            } catch (err) {
              log.debug('Failed to refocus PM after marquee', err)
            }
            queueMicrotask(() => {
              isApplyingPmSelectionRef.current = false
            })
          } catch (err) {
            isApplyingPmSelectionRef.current = false
            log.debug('PM setSelection rejected (likely nested blocks)', err)
          }
        }
      }
    }

    const teardown = (): void => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      cancelRaf()
      teardownDragRef.current = null
    }

    function onUp(): void {
      teardown()
      if (isMarquee) {
        finalize()
      }
    }

    teardownDragRef.current = teardown
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  trigger.addEventListener('mousedown', onMouseDown, true)
  return () => {
    trigger.removeEventListener('mousedown', onMouseDown, true)
    teardownDragRef.current?.()
    teardownDragRef.current = null
    trigger.removeAttribute(ACTIVE_ATTR)
  }
}, [enabled, triggerContainerEl, blockContainerRef, editor])
```

The listener is attached in **capture** phase (`true`) — same semantics as the old `onMouseDownCapture`.

- [ ] **Step 5: Update the outside-click detector to consult the trigger element**

Replace the existing `useEffect` that listens for outside-click teardown:

```ts
useEffect(() => {
  const onMouseDown = (event: globalThis.MouseEvent): void => {
    if (!hasSelectionRef.current) return
    const trigger = triggerContainerEl
    if (!trigger) return
    if (event.target instanceof Node && trigger.contains(event.target)) return
    clearSelection()
  }
  document.addEventListener('mousedown', onMouseDown, true)
  return () => document.removeEventListener('mousedown', onMouseDown, true)
}, [clearSelection, triggerContainerEl])
```

- [ ] **Step 6: Update the unmount cleanup effect**

Replace the trailing cleanup `useEffect`:

```ts
useEffect(() => {
  const trigger = triggerContainerEl
  return () => {
    teardownDragRef.current?.()
    teardownDragRef.current = null
    if (trigger) trigger.removeAttribute(ACTIVE_ATTR)
  }
}, [triggerContainerEl])
```

- [ ] **Step 7: Update the return statement**

```ts
return {
  marqueeRect,
  highlightRects,
  isActive,
  selectedBlockIds,
  clearSelection
}
```

- [ ] **Step 8: Run typecheck on the desktop package**

Run: `pnpm --filter desktop typecheck`
Expected: errors in `ContentArea.tsx` complaining about the old `containerRef` arg / missing `triggerContainerEl` and the unused `marquee.onContainerMouseDownCapture` reference. (Those will be fixed in Task 3.) No errors inside the hook itself.

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/renderer/src/components/note/content-area/hooks/use-block-marquee-selection.ts
git commit -m "refactor(marquee): split block container from trigger container in marquee hook"
```

---

### Task 3: Wire `ContentArea` to the new hook shape and portal the overlay

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/note/content-area/types.ts`
- Modify: `apps/desktop/src/renderer/src/components/note/content-area/ContentArea.tsx`

- [ ] **Step 1: Add the new prop to `ContentAreaProps`**

In `types.ts`, append inside `ContentAreaProps`:

```ts
  /**
   * The outer wrapper element that owns the marquee selection trigger area
   * (and the overlay's coordinate space). When omitted, falls back to the
   * inner `.bn-container` so callers that don't want the extended hit area
   * still get the original behavior.
   */
  marqueeZoneEl?: HTMLDivElement | null
```

- [ ] **Step 2: Destructure `marqueeZoneEl` in `ContentAreaEditor`**

In `ContentArea.tsx`, add `marqueeZoneEl` to the destructured props of `ContentAreaEditor`:

```ts
const ContentAreaEditor = memo(function ContentAreaEditor({
  // ...existing props...
  yjsFragment,
  isRemoteUpdateRef,
  marqueeZoneEl
}: ContentAreaEditorProps) {
```

- [ ] **Step 3: Compute the effective trigger element with state for fallback**

Right before the `useBlockMarqueeSelection` call (around line 287), add:

```ts
// Use a state-tracked element for the inner .bn-container so we can fall
// back to it when no outer marqueeZoneEl is provided. The state-backed
// callback ref keeps the marquee hook's effect re-running on first mount.
const [innerContainerEl, setInnerContainerEl] = useState<HTMLDivElement | null>(null)
const setEditorContainerRef = useCallback((el: HTMLDivElement | null) => {
  editorContainerRef.current = el
  setInnerContainerEl(el)
}, [])

const triggerEl = marqueeZoneEl ?? innerContainerEl
```

- [ ] **Step 4: Update the `useBlockMarqueeSelection` call site**

Replace lines 287-292:

```ts
const marquee = useBlockMarqueeSelection({
  editor,
  blockContainerRef: editorContainerRef,
  triggerContainerEl: triggerEl,
  enabled: editable
})
```

- [ ] **Step 5: Wire the `.bn-container` div to use the new ref-callback and remove the old marquee handler**

Replace the `<div ref={editorContainerRef} ...>` block (lines 448-460) with:

```jsx
<div
  ref={setEditorContainerRef}
  className={cn(
    'bn-container flex-1 min-h-[300px] relative',
    stickyToolbar && 'sticky-toolbar-enabled'
  )}
  role="application"
  aria-label="Rich text editor"
  onContextMenu={handleEditorContextMenu}
>
  {!marqueeZoneEl && (
    <BlockMarqueeOverlay rect={marquee.marqueeRect} highlights={marquee.highlightRects} />
  )}
  <BlockNoteView
    editor={editor}
    editable={editable}
    onChange={(): void => {
```

(Keep everything else inside the BlockNoteView open tag unchanged.)

The inline overlay is the **fallback** path used when no `marqueeZoneEl` is wired up.

- [ ] **Step 6: Add the portal-based overlay for the wired-up case**

Add `import { createPortal } from 'react-dom'` near the top of `ContentArea.tsx` if it isn't already imported.

Right before the closing `</div>` of the outer `containerRef` div (at the end of the JSX, around line 575+), add:

```jsx
{marqueeZoneEl &&
  createPortal(
    <BlockMarqueeOverlay rect={marquee.marqueeRect} highlights={marquee.highlightRects} />,
    marqueeZoneEl
  )}
```

- [ ] **Step 7: Make sure `ContentArea` (the outer wrapper before the memoization) forwards the new prop**

Search for the `ContentArea` outer function (the one that calls `<ContentAreaEditor {...props} ... />`) and confirm that all props in `ContentAreaProps` flow through. Because `ContentAreaProps` is spread or accepts the type, adding the new optional field should require no extra plumbing — but verify with grep:

Run: search `<ContentAreaEditor` in `ContentArea.tsx` and confirm the spread/explicit-prop list passes `marqueeZoneEl`.

If it's an explicit prop list, add `marqueeZoneEl={props.marqueeZoneEl}` to the call.

- [ ] **Step 8: Run typecheck**

Run: `pnpm --filter desktop typecheck`
Expected: clean (the only known pre-existing failures are in `websocket.test.ts` and `folders.test.ts` per CLAUDE.md, ignore those).

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/renderer/src/components/note/content-area/types.ts \
        apps/desktop/src/renderer/src/components/note/content-area/ContentArea.tsx
git commit -m "refactor(marquee): consume new hook shape and portal overlay into trigger zone"
```

---

### Task 4: Add the `marquee-zone` wrapper in `pages/note.tsx`

**Files:**
- Modify: `apps/desktop/src/renderer/src/pages/note.tsx`

- [ ] **Step 1: Add the `marqueeZoneEl` state**

Find the existing `editorContainerRef` declaration around line 206:

```ts
const editorContainerRef = useRef<HTMLDivElement>(null)
```

Add directly below it:

```ts
const [marqueeZoneEl, setMarqueeZoneEl] = useState<HTMLDivElement | null>(null)
```

If `useState` isn't already imported in `note.tsx`, add it: `import { useState, ... } from 'react'`. (It almost certainly already is — verify.)

- [ ] **Step 2: Wrap `editor-click-area` in the new `marquee-zone` div**

Find the existing `editor-click-area` div around line 975-989:

```jsx
{/* Main content - BlockNote Editor */}
<div
  ref={editorContainerRef}
  role="presentation"
  className="editor-click-area flex-1 pb-[30vh] relative"
  onMouseDown={(e) => {
    const target = e.target as HTMLElement
    if (
      target.closest('[contenteditable="true"]')?.contains(target) &&
      target.closest('.bn-block-content')
    )
      return
    if (target.closest('button, a, input')) return
    e.preventDefault()
    focusAtEndRef.current?.()
  }}
>
```

Replace with:

```jsx
{/* Main content - BlockNote Editor */}
<div
  ref={setMarqueeZoneEl}
  className="marquee-zone relative -mx-24 px-24 flex-1 flex flex-col"
  onMouseDown={(e) => {
    const target = e.target as HTMLElement
    if (
      target.closest('[contenteditable="true"]')?.contains(target) &&
      target.closest('.bn-block-content')
    )
      return
    if (target.closest('button, a, input')) return
    e.preventDefault()
    focusAtEndRef.current?.()
  }}
>
  <div
    ref={editorContainerRef}
    role="presentation"
    className="editor-click-area flex-1 pb-[30vh] relative"
  >
```

(Note: the `flex-1 flex flex-col` on the outer wrapper preserves the flex-column behavior so `editor-click-area` still grows to fill remaining vertical space. The original `editor-click-area` was a direct child of the parent flex column with `flex-1`; the new wrapper takes that role.)

- [ ] **Step 3: Add the matching closing `</div>` for the new wrapper**

Find the existing `</div>` that closes the old `editor-click-area` div (right after `</EditorErrorBoundary>` around line 1016). After it, add one more `</div>` to close the new `marquee-zone` wrapper.

Resulting structure:

```jsx
<div
  ref={setMarqueeZoneEl}
  className="marquee-zone relative -mx-24 px-24 flex-1 flex flex-col"
  onMouseDown={...}
>
  <div
    ref={editorContainerRef}
    role="presentation"
    className="editor-click-area flex-1 pb-[30vh] relative"
  >
    <EditorErrorBoundary ...>
      <ContentArea ... />
    </EditorErrorBoundary>
  </div>
</div>
```

- [ ] **Step 4: Pass `marqueeZoneEl` to `ContentArea`**

Inside the `<ContentArea ... />` JSX call (around line 996-1014), add a new prop:

```jsx
<ContentArea
  key={`${noteId}-${externalUpdateCount}`}
  noteId={noteId}
  // ...all existing props...
  focusAtEndRef={focusAtEndRef}
  marqueeZoneEl={marqueeZoneEl}
/>
```

- [ ] **Step 5: Run typecheck**

Run: `pnpm --filter desktop typecheck`
Expected: clean (other than known pre-existing failures).

- [ ] **Step 6: Run lint**

Run: `pnpm --filter desktop lint`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/src/pages/note.tsx
git commit -m "feat(marquee): mount marquee zone wrapper around editor with extended hit area"
```

---

### Task 5: Update CSS to apply marquee-active styles to the new wrapper

**Files:**
- Modify: `apps/desktop/src/renderer/src/assets/base.css`

- [ ] **Step 1: Update the marquee section comment**

Replace the documentation comment block at lines 2247-2256 with:

```css
/* ============================================================================
   MARQUEE BLOCK SELECTION
   ============================================================================ */

/*
 * Highlight rectangles are absolute-positioned overlay divs (not attribute
 * mutations on .bn-block) because ProseMirror's MutationObserver reverts any
 * DOM mutation it didn't make. The overlay is rendered (via portal) into the
 * `.marquee-zone` wrapper, which is `position: relative` and extends
 * horizontally beyond .bn-container into the parent's px-24 padding so users
 * can start a marquee from the gray gutter on either side of the editor.
 */
```

- [ ] **Step 2: Replace the `.bn-container[data-marquee-active]` selectors**

Find lines 2273-2278 (or thereabouts):

```css
.bn-container[data-marquee-active='true'] {
  cursor: default;
  user-select: none;
}
.bn-container[data-marquee-active='true'] * {
  user-select: none !important;
}
```

Replace with:

```css
.marquee-zone[data-marquee-active='true'] {
  cursor: default;
  user-select: none;
}
.marquee-zone[data-marquee-active='true'] * {
  user-select: none !important;
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/assets/base.css
git commit -m "style(marquee): scope active-state selectors to .marquee-zone"
```

---

### Task 6: Run the full e2e suite and verify

**Files:** _none — verification only_

- [ ] **Step 1: Run the marquee e2e tests**

Run: `pnpm --filter desktop test:e2e -- marquee-selection.e2e.ts`
Expected: all 9 tests pass (6 pre-existing + 3 new).

- [ ] **Step 2: Run lint, typecheck, ipc:check across the workspace**

Run: `pnpm lint && pnpm typecheck && pnpm ipc:check`
Expected: lint clean, typecheck clean except known pre-existing test-file failures, ipc:check clean.

- [ ] **Step 3: Run unit tests**

Run: `pnpm --filter desktop test`
Expected: pass.

- [ ] **Step 4: Manual smoke check (`pnpm dev`)**

Open a note with several blocks. Verify:
1. Drag from left gray strip into editor → marquee rectangle appears, blocks highlight, release → blocks remain highlighted, Backspace deletes them. ✅
2. Drag from right gray strip → same. ✅
3. Drag downward inside the editor (existing behavior) → still works. ✅
4. Click in left gray strip → caret jumps to end of editor, no marquee. ✅
5. Click and short horizontal drag inside a paragraph → text selection works, no marquee. ✅
6. Slash menu / formatting toolbar → click them, no marquee. ✅
7. Resize window narrow → wrapper still works (no clipping). ✅
8. Click in note title → title focuses, no marquee, no spurious editor focus. ✅
9. Click in tags row / backlinks → their handlers fire, no marquee. ✅

If any step fails, root-cause it before proceeding.

- [ ] **Step 5: Final commit (changelog / docs only if needed)**

If the smoke check exposes a regression, fix it in a focused commit. Otherwise no commit needed for this task.

---

## Risks & Edge Cases

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| `createPortal` rendering before `marqueeZoneEl` is set produces a single-frame flicker | Low | The portal block is `null` when `marqueeZoneEl` is null. State update on the ref-callback triggers a re-render in the same React batch as the parent's first commit, so by the time `ContentArea` mounts the trigger element is usually already set. The fallback inline overlay covers the rare in-between frame. |
| `-mx-24 px-24` extends into a sibling's padding when the parent flex column is misconfigured | Low | The parent in `note-layout.tsx:62-64` is `mx-auto w-full px-24 ... flex flex-col` with no children that have negative siblings; visual review confirms only `editor-click-area` would benefit. Other siblings (NoteTitle, TagsRow, BacklinksSection) sit above/below in the flex column, never horizontally adjacent. |
| Focus-at-end fires on every gray-strip mousedown, briefly stealing focus from another element | Very Low | Only if user clicks gray strip while another element is focused. The existing behavior already does this for the bottom padding. Acceptable. |
| `data-marquee-active` no longer applies to `.bn-container` so any consumer of that selector breaks | Low | Grep for `data-marquee-active` across the repo before committing — confirmed only base.css references it. Updated in the same commit. |
| E2E gray-strip drag fails on narrow viewports where `px-24` shrinks below the click target | Low | E2E runs at default Playwright viewport (1280x720) which leaves ample room. If we ever shrink the test viewport, revisit. |
| Switching from React `onMouseDownCapture` to imperative `addEventListener` changes the order relative to other React handlers | Medium | The new listener is `capture: true` on the wrapper, so it still fires before bubble-phase handlers on descendants (including `editor-click-area`'s `onMouseDown`). Manually verified during smoke test step 4 of Task 6. |
| `setEditorContainerRef` callback creates a new function each render and re-fires the ref | Low | Wrapped in `useCallback` with empty deps so the identity is stable. |

---

## Open Questions

_(none — clarifying questions resolved before plan was written: trigger zone = editor + 96px padding only; gray-strip click focuses editor at end)_

---

## Self-Review Notes

- **Spec coverage:** all behaviors from the user request ("select blocks when dragging from left/right space around the editor") are covered by Tasks 1, 4 (wrapper + listener relocation) and verified in Task 1's e2e tests.
- **Placeholder scan:** no TBDs, no "add error handling" hand-waves, every code step is concrete.
- **Type consistency:** `triggerContainerEl: HTMLDivElement | null` used consistently in hook + ContentArea + types.ts. `blockContainerRef: React.RefObject<HTMLDivElement | null>` consistent. `marqueeZoneEl` prop name consistent across types.ts, ContentArea.tsx, note.tsx.
- **TDD:** tests added before implementation (Task 1 → Tasks 2-5 → Task 6 verifies). Each implementation task has its own focused commit so a bisect would catch a regression cleanly.
