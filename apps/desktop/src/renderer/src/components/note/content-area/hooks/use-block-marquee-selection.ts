/* eslint-disable @typescript-eslint/no-explicit-any */

import { useCallback, useEffect, useRef, useState } from 'react'
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
              // Re-focus the editor so keyboard actions (Backspace, Cmd+C,
              // Cmd+A) reach ProseMirror — promote() blurred it.
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
  }, [enabled, triggerContainerEl, editor])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (!hasSelectionRef.current) return
      clearSelection()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [clearSelection])

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
