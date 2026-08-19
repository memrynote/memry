/* eslint-disable @typescript-eslint/no-explicit-any */

import { useCallback, useEffect, useRef, useState } from 'react'
import { createLogger } from '@/lib/logger'
import { hasSelectableTextAt, shouldStartMarquee } from '../marquee-hit-test'
import { classifyBlocks, indentTaskBlock, outdentTaskBlock } from './task-block-marquee-indent'

const log = createLogger('Hook:Marquee')

/**
 * How far the pointer must travel before a press becomes a drag. Direction-
 * agnostic on purpose: whether this gesture may be a marquee at all was already
 * settled at mousedown by `hasSelectableTextAt`, so all this threshold does is
 * keep a plain click from flashing a selection box.
 */
const DRAG_THRESHOLD_PX = 5
const ACTIVE_ATTR = 'data-marquee-active'

export interface MarqueeRect {
  left: number
  top: number
  width: number
  height: number
}

export interface BlockHighlightRect {
  id: string
  left: number
  top: number
  width: number
  height: number
}

interface UseBlockMarqueeSelectionOptions {
  editor: any
  /** The `.bn-container` ref — used to query `.bn-block[data-id]` for hit-testing + ordering. */
  blockContainerRef: React.RefObject<HTMLDivElement | null>
  /** The outer wrapper element that owns the listener and the overlay coordinate space. */
  triggerContainerEl: HTMLDivElement | null
  enabled?: boolean
  onDeleteSelectedBlocks?: (ids: string[]) => boolean
}

interface UseBlockMarqueeSelectionReturn {
  marqueeRect: MarqueeRect | null
  highlightRects: ReadonlyArray<BlockHighlightRect>
  isActive: boolean
  selectedBlockIds: ReadonlySet<string>
  clearSelection: () => void
}

interface OriginPoint {
  clientX: number
  clientY: number
}

function rectsIntersect(
  a: DOMRect,
  b: { left: number; top: number; right: number; bottom: number }
): boolean {
  return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom)
}

interface MeasuredBlock {
  element: HTMLElement
  rect: DOMRect
}

// Find the blocks a marquee box covers without measuring the whole note.
//
// Blocks live in normal block flow: siblings stack top-to-bottom in document
// order and a nested block is laid out inside its parent's box. So across the
// document-order list `rect.top` is non-decreasing, and any block that precedes
// another without being its ancestor finishes before that one starts. Those two
// facts are enough to skip everything above and below the marquee, which is why
// a drag on a 500-block note costs the same as a drag on a 5-block one.
//
// Nothing here is cached. `blocks` is re-queried and every rect is re-read on
// the frame it is used, so scrolling mid-drag, a resize, a sidebar toggle, an
// image settling to its final height, a zoom change or a block appearing can
// never feed a stale rect into the selection — the only way a wrong rect gets
// in is if the browser hands us one.
//
// TRIPWIRE, read this before changing how blocks are laid out. Both facts above
// hold only while every `.bn-block` is in normal block flow. What was checked to
// establish that: `@blocknote/xl-multi-column` is not a dependency, there is no
// column block in `editor-schema.ts`, and no rule in `base.css` floats a
// `.bn-block`, positions one absolutely, or puts siblings side by side.
//
// Introducing ANY non-normal-flow block layout — multi-column blocks,
// side-by-side callouts, floats, absolute positioning — breaks those facts, and
// this function then returns a WRONG selection rather than a slow one. That
// selection feeds bulk delete/move, so the failure is data loss, not a glitch.
// The tests cannot catch it: they build normal-flow DOM and compare against an
// exhaustive scan of that same DOM, so they stay green while the assumption is
// false. Revisit this function — pruning has to become per-column — as part of
// any such change, not after a bug report.
function collectMarqueeHits(
  container: HTMLElement,
  blocks: ArrayLike<HTMLElement>,
  box: { left: number; top: number; right: number; bottom: number }
): MeasuredBlock[] {
  // Binary search for the first block that starts below the marquee's bottom
  // edge. Every later block starts at least as low, so none of them intersect.
  let lo = 0
  let hi = blocks.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (blocks[mid].getBoundingClientRect().top > box.bottom) hi = mid
    else lo = mid + 1
  }

  const hits: MeasuredBlock[] = []
  let stopIndex = -1
  for (let i = lo - 1; i >= 0; i -= 1) {
    const element = blocks[i]
    const rect = element.getBoundingClientRect()
    if (rect.bottom < box.top) {
      // This block ends above the marquee. Every earlier block is either one of
      // its ancestors or finishes before it starts, so the ancestors are the
      // only boxes left that can still reach down into the marquee.
      stopIndex = i
      break
    }
    if (rectsIntersect(rect, box)) hits.push({ element, rect })
  }
  hits.reverse()

  if (stopIndex === -1) return hits

  const ancestors: MeasuredBlock[] = []
  let node = blocks[stopIndex].parentElement
  while (node && node !== container) {
    if (node.matches('.bn-block[data-id]')) {
      const rect = node.getBoundingClientRect()
      if (rectsIntersect(rect, box)) ancestors.push({ element: node, rect })
    }
    node = node.parentElement
  }
  // Walked innermost-first; document order wants the outermost ancestor first,
  // and every ancestor precedes every block the backwards scan collected.
  ancestors.reverse()
  return [...ancestors, ...hits]
}

function getOrderedBlockIds(container: HTMLElement, ids: ReadonlySet<string>): string[] {
  if (ids.size === 0) return []
  const ordered: string[] = []
  const all = container.querySelectorAll<HTMLElement>('.bn-block[data-id]')
  all.forEach((el) => {
    const id = el.getAttribute('data-id')
    if (id && ids.has(id) && !ordered.includes(id)) {
      ordered.push(id)
    }
  })
  return ordered
}

interface BlockNode {
  id: string
  children?: ReadonlyArray<BlockNode>
}

// Reduce a marquee selection to its outermost blocks. `editor.removeBlocks`
// throws "Blocks with the following IDs could not be found" if asked to remove
// both a block and one of its descendants: removing the ancestor already
// deletes the descendant, so the descendant id no longer resolves and the
// WHOLE transaction rolls back (nothing gets deleted). The rect hit-test
// naturally selects nested children alongside their parents, so prune any id
// whose ancestor is also selected before deleting. Stale ids (not present in
// the document) drop out too, which also avoids the same throw.
export function topLevelSelectedBlockIds(
  document: ReadonlyArray<BlockNode>,
  selected: ReadonlySet<string>
): string[] {
  const out: string[] = []
  const walk = (blocks: ReadonlyArray<BlockNode>): void => {
    for (const block of blocks) {
      if (selected.has(block.id)) {
        out.push(block.id)
        // Descendants are removed implicitly with this ancestor — don't recurse.
        continue
      }
      if (block.children?.length) walk(block.children)
    }
  }
  walk(document)
  return out
}

export function useBlockMarqueeSelection({
  editor,
  blockContainerRef,
  triggerContainerEl,
  enabled = true,
  onDeleteSelectedBlocks
}: UseBlockMarqueeSelectionOptions): UseBlockMarqueeSelectionReturn {
  const [marqueeRect, setMarqueeRect] = useState<MarqueeRect | null>(null)
  const [highlightRects, setHighlightRects] = useState<ReadonlyArray<BlockHighlightRect>>([])
  const [isActive, setIsActive] = useState(false)
  const [selectedBlockIds, setSelectedBlockIds] = useState<ReadonlySet<string>>(() => new Set())

  const selectedRef = useRef<Set<string>>(new Set())
  const hasSelectionRef = useRef(false)
  const teardownDragRef = useRef<(() => void) | null>(null)

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

  // Re-measure every still-selected block's DOM rect and rebuild the
  // overlay highlight list. Called after nest/unnest because the block's
  // x-offset (and sometimes y) shifts with indentation depth. Also
  // prunes any id whose DOM node disappeared as a defensive guard.
  const recomputeHighlightRects = useCallback((): void => {
    const container = blockContainerRef.current
    const trigger = triggerContainerEl
    if (!container || !trigger) return
    const triggerBounds = trigger.getBoundingClientRect()
    const nextRects: BlockHighlightRect[] = []
    const stillSelected = new Set<string>()
    container.querySelectorAll<HTMLElement>('.bn-block[data-id]').forEach((el) => {
      const id = el.getAttribute('data-id')
      if (!id || !selectedRef.current.has(id)) return
      if (stillSelected.has(id)) return
      stillSelected.add(id)
      const rect = el.getBoundingClientRect()
      nextRects.push({
        id,
        left: rect.left - triggerBounds.left,
        top: rect.top - triggerBounds.top,
        width: rect.width,
        height: rect.height
      })
    })
    selectedRef.current = stillSelected
    setHighlightRects(nextRects)
    setSelectedBlockIds(new Set(stillSelected))
  }, [blockContainerRef, triggerContainerEl])

  // Indent every marquee-selected block by one level. Routes each block
  // to the correct nesting API based on its type:
  //   - textblocks (paragraph, bulletListItem, heading, etc.) use
  //     BlockNote's built-in `nestBlock`, gated on `canNestBlock`
  //   - taskBlocks use the `parentTaskId` prop + tasksService.update
  //     path via `indentTaskBlock` — mirroring the single-task Tab
  //     handler in `task-block-renderer.tsx`. BlockNote's `nestBlock`
  //     crashes on non-textblock custom blocks because it assumes a
  //     TextSelection inside a textblock; the ReactNodeView corrupts
  //     and the next iteration blows up in syncNodeSelection.descAt.
  //   - other non-textblock blocks (file, youtubeEmbed) have no
  //     analogous hierarchy mechanism and stay silently skipped.
  //
  // Both loops iterate in FORWARD order — matches the "flat siblings
  // under common predecessor" semantics of the single-task Tab handler:
  // after B nests under A, C's previous top-level sibling is still A
  // (now carrying B as a child), so C also nests directly under A as
  // B's sibling.
  //
  const indentSelectedBlocks = useCallback((): void => {
    const container = blockContainerRef.current
    if (!container) return
    const ordered = getOrderedBlockIds(container, selectedRef.current)
    if (ordered.length === 0) return
    const { textblocks, taskBlocks, other } = classifyBlocks(editor, ordered)
    if (other.length > 0) {
      log.debug('indent skipping non-nestable blocks', other)
    }
    if (textblocks.length === 0 && taskBlocks.length === 0) return
    try {
      editor.prosemirrorView?.focus?.()
    } catch (err) {
      log.debug('Failed to focus PM view before indent', err)
    }
    try {
      for (const id of textblocks) {
        try {
          editor.setTextCursorPosition(id, 'start')
          if (editor.canNestBlock?.()) editor.nestBlock()
        } catch (err) {
          log.debug('nestBlock failed for id', id, err)
        }
      }
      for (const id of taskBlocks) {
        try {
          const outcome = indentTaskBlock(editor, id)
          if (outcome.kind === 'skipped') {
            log.debug('indentTaskBlock skipped', id, outcome.reason)
          }
        } catch (err) {
          log.debug('indentTaskBlock failed for id', id, err)
        }
      }
    } finally {
      requestAnimationFrame(recomputeHighlightRects)
    }
  }, [editor, blockContainerRef, recomputeHighlightRects])

  // Outdent every marquee-selected block by one level. Both the textblock
  // and taskBlock loops run in REVERSE order:
  //   - textblocks: BlockNote's `unnestBlock` lifts the block out and
  //     places it immediately after the parent, so reverse iteration
  //     preserves sibling order in the resulting flat list.
  //   - taskBlocks: `outdentTaskBlock` replaces the parent with
  //     `[newParent, promotedSelf]`. Processing bottom-up lifts the
  //     last nested child first, keeping remaining siblings in their
  //     original order under the (shrinking) parent.
  const outdentSelectedBlocks = useCallback((): void => {
    const container = blockContainerRef.current
    if (!container) return
    const ordered = getOrderedBlockIds(container, selectedRef.current)
    if (ordered.length === 0) return
    const { textblocks, taskBlocks, other } = classifyBlocks(editor, ordered)
    if (other.length > 0) {
      log.debug('outdent skipping non-nestable blocks', other)
    }
    if (textblocks.length === 0 && taskBlocks.length === 0) return
    try {
      editor.prosemirrorView?.focus?.()
    } catch (err) {
      log.debug('Failed to focus PM view before outdent', err)
    }
    try {
      for (let i = textblocks.length - 1; i >= 0; i -= 1) {
        const id = textblocks[i]
        try {
          editor.setTextCursorPosition(id, 'start')
          if (editor.canUnnestBlock?.()) editor.unnestBlock()
        } catch (err) {
          log.debug('unnestBlock failed for id', id, err)
        }
      }
      for (let i = taskBlocks.length - 1; i >= 0; i -= 1) {
        const id = taskBlocks[i]
        try {
          const outcome = outdentTaskBlock(editor, id)
          if (outcome.kind === 'skipped') {
            log.debug('outdentTaskBlock skipped', id, outcome.reason)
          }
        } catch (err) {
          log.debug('outdentTaskBlock failed for id', id, err)
        }
      }
    } finally {
      requestAnimationFrame(recomputeHighlightRects)
    }
  }, [editor, blockContainerRef, recomputeHighlightRects])

  useEffect(() => {
    if (!enabled) return
    const trigger = triggerContainerEl
    if (!trigger) return

    const onMouseDown = (event: globalThis.MouseEvent): void => {
      if (event.button !== 0) return
      if (!shouldStartMarquee(event.target)) return

      const blockContainer = blockContainerRef.current
      if (!blockContainer) return

      teardownDragRef.current?.()
      teardownDragRef.current = null

      if (hasSelectionRef.current) {
        selectedRef.current = new Set()
        setSelectedBlockIds(new Set())
        setHighlightRects([])
        hasSelectionRef.current = false
      }

      // The marquee start rule (#1444), and its position here is load-bearing.
      // A press on text is a text selection, so we decline — but only AFTER the
      // clearing above, so pressing into text still dismisses a stale block
      // highlight instead of leaving it competing with the caret; and BEFORE the
      // document listeners below, so declining registers nothing at all.
      if (hasSelectableTextAt(event.target)) return

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
        collectMarqueeHits(blockContainer, blockEls, { left, top, right, bottom }).forEach(
          ({ element, rect: blockRect }) => {
            const id = element.getAttribute('data-id')
            if (!id || next.has(id)) return
            next.add(id)
            nextRects.push({
              id,
              left: blockRect.left - triggerBounds.left,
              top: blockRect.top - triggerBounds.top,
              width: blockRect.width,
              height: blockRect.height
            })
          }
        )
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
          // Straight-line distance from the press, and nothing else. This gesture
          // already earned the right to be a marquee at mousedown by starting
          // outside selectable text, so the only question left is click or drag.
          //
          // Direction used to be decided here instead — a minimum vertical
          // travel plus an exemption for mostly-horizontal drags that began in
          // editable text — and that is precisely what made the outcome depend
          // on the drag angle: from one press inside a paragraph, straight down
          // selected blocks and down-and-right selected text, with nothing on
          // screen to tell the user which they were about to get. Re-introducing
          // any direction test here brings that back (#1441).
          const dx = moveEvent.clientX - origin.clientX
          const dy = moveEvent.clientY - origin.clientY
          if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return
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

        if (finalIds.size === 0) {
          setHighlightRects([])
          setSelectedBlockIds(new Set())
          hasSelectionRef.current = false
          return
        }

        try {
          window.getSelection()?.removeAllRanges()
        } catch (err) {
          log.warn('Failed to clear native selection on marquee finalize', err)
        }

        setSelectedBlockIds(finalIds)
        hasSelectionRef.current = true
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
  }, [enabled, triggerContainerEl, editor, blockContainerRef])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!hasSelectionRef.current) return

      if (event.key === 'Escape') {
        clearSelection()
        return
      }

      // Tab / Shift+Tab on a marquee selection: indent/outdent every
      // selected block as a group. Matches BlockNote's single-cursor
      // Tab behavior but extends it to multi-block selections. Marquee
      // selection is preserved across the operation so repeated Tab
      // "walks" the group deeper/shallower. Capture-phase + preventDefault
      // beats both PM's own Tab handler and the browser's focus cycling.
      if (event.key === 'Tab') {
        if (selectedRef.current.size === 0) return
        event.preventDefault()
        event.stopPropagation()
        if (event.shiftKey) {
          outdentSelectedBlocks()
        } else {
          indentSelectedBlocks()
        }
        return
      }

      // Backspace / Delete on a marquee selection: remove every
      // visually-selected block. This intentionally bypasses PM's
      // native cross-block deletion so textblocks and custom blocks
      // (taskBlock, file, youtubeEmbed) share the same block-only path.
      if (event.key === 'Backspace' || event.key === 'Delete') {
        if (selectedRef.current.size === 0) return
        event.preventDefault()
        event.stopPropagation()
        // Prune nested descendants: removeBlocks throws (and rolls back the
        // entire deletion) when given both a block and a descendant of it.
        const doc = Array.isArray(editor?.document) ? (editor.document as BlockNode[]) : null
        const ids = doc
          ? topLevelSelectedBlockIds(doc, selectedRef.current)
          : Array.from(selectedRef.current)
        if (ids.length === 0) {
          clearSelection()
          return
        }
        if (onDeleteSelectedBlocks?.(ids)) {
          clearSelection()
          return
        }
        try {
          editor.removeBlocks(ids)
        } catch (err) {
          log.warn('Failed to remove marquee-selected blocks', err)
        }
        clearSelection()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [clearSelection, editor, indentSelectedBlocks, onDeleteSelectedBlocks, outdentSelectedBlocks])

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

  return {
    marqueeRect,
    highlightRects,
    isActive,
    selectedBlockIds,
    clearSelection
  }
}
