/* eslint-disable @typescript-eslint/no-explicit-any */

import { useCallback, useEffect, useRef, useState } from 'react'
import { TextSelection } from 'prosemirror-state'
import type { Node as PMNode } from 'prosemirror-model'
import { createLogger } from '@/lib/logger'

const log = createLogger('Hook:Marquee')

const VERTICAL_PROMOTE_PX = 15
const HORIZONTAL_LIMIT_PX = 8
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

function shouldStartMarquee(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.closest('[data-marquee-ignore]')) return false
  if (target.closest('button, a, input, textarea, select, [role="button"]')) return false
  if (
    target.closest(
      '.bn-side-menu, .bn-formatting-toolbar, .bn-suggestion-menu, .bn-link-toolbar, .bn-drag-handle-menu'
    )
  ) {
    return false
  }
  return true
}

function rectsIntersect(
  a: DOMRect,
  b: { left: number; top: number; right: number; bottom: number }
): boolean {
  return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom)
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

interface BlockContainerEntry {
  pos: number
  node: PMNode
}

// Walk the PM doc once to find positions of every blockContainer node whose
// id is in `ids`. Returns a flat lookup keyed by BlockNote block id. Recurses
// into nested children (taskBlock subtasks etc.) so the position map matches
// the DOM-flat order returned by getOrderedBlockIds.
function findBlockContainerPositions(
  doc: PMNode,
  ids: ReadonlySet<string>
): Map<string, BlockContainerEntry> {
  const out = new Map<string, BlockContainerEntry>()
  if (ids.size === 0) return out
  doc.descendants((node, pos) => {
    if (node.type.name !== 'blockContainer') return true
    const id = node.attrs?.id as string | undefined
    if (id && ids.has(id) && !out.has(id)) {
      out.set(id, { pos, node })
    }
    return true
  })
  return out
}

export function useBlockMarqueeSelection({
  editor,
  blockContainerRef,
  triggerContainerEl,
  enabled = true
}: UseBlockMarqueeSelectionOptions): UseBlockMarqueeSelectionReturn {
  const [marqueeRect, setMarqueeRect] = useState<MarqueeRect | null>(null)
  const [highlightRects, setHighlightRects] = useState<ReadonlyArray<BlockHighlightRect>>([])
  const [isActive, setIsActive] = useState(false)
  const [selectedBlockIds, setSelectedBlockIds] = useState<ReadonlySet<string>>(() => new Set())

  const selectedRef = useRef<Set<string>>(new Set())
  const hasSelectionRef = useRef(false)
  const isApplyingPmSelectionRef = useRef(false)
  // True when applyPmSelection actually dispatched a real PM selection
  // backing the marquee. False for the all-non-textblock branch where
  // we keep the visual highlight + selectedRef as the source of truth
  // and let our own Backspace handler do the work. Drives whether the
  // editor.onSelectionChange listener is allowed to clear us.
  const pmSelectionBackedRef = useRef(false)
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
    pmSelectionBackedRef.current = false
    if (triggerContainerEl) triggerContainerEl.removeAttribute(ACTIVE_ATTR)
  }, [triggerContainerEl])

  useEffect(() => {
    if (!enabled) return
    const trigger = triggerContainerEl
    if (!trigger) return

    const onMouseDown = (event: globalThis.MouseEvent): void => {
      if (event.button !== 0) return
      if (!shouldStartMarquee(event.target)) return

      // Whether this gesture started inside editable text. Affects the promotion
      // gate: text-selection-preservation only matters when there is text to
      // select. Drags that start in the gutter promote on any vertical motion.
      const startedInsideEditableText =
        event.target instanceof Element &&
        event.target.closest('[contenteditable="true"]') !== null

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
          // Drags that start inside editable text must be clearly vertical so we
          // don't steal "drag right to highlight a word" gestures. Drags that start
          // in the gutter (no text to select) promote on any vertical motion.
          if (dy < VERTICAL_PROMOTE_PX) return
          if (startedInsideEditableText && dx > HORIZONTAL_LIMIT_PX && dx > dy) return
          promote()
        }

        moveEvent.preventDefault()
        if (rafId === null) {
          rafId = requestAnimationFrame(tick)
        }
      }

      const applyPmSelection = (finalIds: ReadonlySet<string>): boolean => {
        const ordered = getOrderedBlockIds(blockContainer, finalIds)
        if (ordered.length === 0) return false

        const view = editor?.prosemirrorView
        if (!view) return false
        const { state } = view

        // One PM-doc walk for every selected block id.
        const positions = findBlockContainerPositions(state.doc, new Set(ordered))
        if (positions.size === 0) return false

        // If EVERY selected block is non-textblock (taskBlock, file,
        // youtubeEmbed — all the content:'none' custom blocks), skip
        // setting a PM selection altogether. PM has no valid TextSelection
        // anchor in such a range and would either throw, snap to a
        // textblock OUTSIDE the range, or silently degrade. The
        // marquee-side Backspace handler operates on selectedRef.current
        // via editor.removeBlocks, so the visual highlight stays the
        // authoritative source of truth and Backspace works uniformly.
        const allNonTextblock = ordered.every((id) => {
          const entry = positions.get(id)
          const innerBlock = entry?.node.firstChild
          return innerBlock != null && !innerBlock.type.isTextblock
        })
        if (allNonTextblock) {
          // No PM selection to set. Mark the marquee as NOT backed by
          // a PM selection so the onSelectionChange listener (which
          // exists to clear the marquee when the user moves the cursor)
          // doesn't fire on spurious editor selection events from async
          // re-renders. Backspace, Escape, and click-outside still clear
          // via their own listeners.
          pmSelectionBackedRef.current = false
          return true
        }

        try {
          isApplyingPmSelectionRef.current = true
          pmSelectionBackedRef.current = true

          if (ordered.length === 1) {
            const entry = positions.get(ordered[0])
            if (!entry) return false

            // Single textblock — preserve the existing TextSelection
            // path so the regression at marquee-selection.e2e.ts:409
            // (selectedText.toContain('Tall heading')) keeps passing.
            const innerBlock = entry.node.firstChild
            if (!innerBlock) return false
            const innerStart = entry.pos + 2
            const innerEnd = innerStart + innerBlock.content.size
            const tr = state.tr.setSelection(TextSelection.create(state.doc, innerStart, innerEnd))
            view.dispatch(tr)
          } else {
            // Multi-block path: build a TextSelection whose endpoints
            // bracket the first/last selected blockContainer nodes at
            // depth 0. PM walks the range to find valid textblock
            // anchors — works for mixed (textblock + non-textblock)
            // ranges because at least one textblock is reachable.
            const firstEntry = positions.get(ordered[0])
            const lastEntry = positions.get(ordered[ordered.length - 1])
            if (!firstEntry || !lastEntry) return false

            const from = firstEntry.pos
            const to = lastEntry.pos + lastEntry.node.nodeSize

            const $from = state.doc.resolve(from)
            const $to = state.doc.resolve(to)
            const tr = state.tr.setSelection(TextSelection.between($from, $to))
            view.dispatch(tr)
          }

          // Re-focus the editor so keyboard actions (Backspace, Cmd+C,
          // Cmd+A) reach ProseMirror — promote() blurred it.
          try {
            editor.prosemirrorView?.focus?.()
          } catch (err) {
            log.debug('Failed to refocus PM after marquee', err)
          }
          // requestAnimationFrame (not queueMicrotask) so the guard
          // outlives the secondary onSelectionChange tick that
          // view.focus() triggers — otherwise the listener at the bottom
          // of this hook clears our just-set selection.
          requestAnimationFrame(() => {
            isApplyingPmSelectionRef.current = false
          })
          return true
        } catch (err) {
          isApplyingPmSelectionRef.current = false
          log.debug('PM selection apply failed (marquee fallback to clear)', err)
          return false
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

        const ok = applyPmSelection(finalIds)
        if (ok) {
          setSelectedBlockIds(finalIds)
          hasSelectionRef.current = true
        } else {
          // Couldn't produce a real editor-owned selection — clear the
          // marquee highlight instead of leaving a visual-only (inert)
          // selection on screen that Backspace/Cmd+C/Cmd+A can't act on.
          setHighlightRects([])
          setSelectedBlockIds(new Set())
          hasSelectionRef.current = false
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
  }, [enabled, triggerContainerEl, editor])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!hasSelectionRef.current) return

      if (event.key === 'Escape') {
        clearSelection()
        return
      }

      // Backspace / Delete on a marquee selection: remove every
      // visually-selected block. This intentionally bypasses PM's
      // native cross-block deletion so it works uniformly for
      // textblocks AND non-textblock custom blocks (taskBlock, file,
      // youtubeEmbed) — applyPmSelection can only set a real PM
      // selection on textblock content, so we keep selectedRef as the
      // authoritative source of truth for what the marquee covers.
      if (event.key === 'Backspace' || event.key === 'Delete') {
        const ids = Array.from(selectedRef.current)
        if (ids.length === 0) return
        event.preventDefault()
        event.stopPropagation()
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
  }, [clearSelection, editor])

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

  useEffect(() => {
    if (!editor?.onSelectionChange) return
    const unsubscribe = editor.onSelectionChange(() => {
      if (isApplyingPmSelectionRef.current) return
      if (!hasSelectionRef.current) return
      // When the marquee isn't backed by a PM selection (all-non-
      // textblock case), editor selection changes are unrelated to
      // the marquee and must NOT clear it. Async task block re-renders,
      // IPC callbacks, focus changes, etc. all emit selectionchange
      // events that would otherwise destroy the marquee state.
      if (!pmSelectionBackedRef.current) return
      clearSelection()
    })
    return () => {
      try {
        unsubscribe?.()
      } catch (err) {
        log.warn('Failed to unsubscribe from editor.onSelectionChange', err)
      }
    }
  }, [editor, clearSelection])

  return {
    marqueeRect,
    highlightRects,
    isActive,
    selectedBlockIds,
    clearSelection
  }
}
