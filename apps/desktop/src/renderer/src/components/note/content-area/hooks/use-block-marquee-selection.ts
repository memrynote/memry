/* eslint-disable @typescript-eslint/no-explicit-any */

import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
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
  containerRef: React.RefObject<HTMLDivElement | null>
  enabled?: boolean
}

interface UseBlockMarqueeSelectionReturn {
  marqueeRect: MarqueeRect | null
  highlightRects: ReadonlyArray<BlockHighlightRect>
  isActive: boolean
  selectedBlockIds: ReadonlySet<string>
  clearSelection: () => void
  onContainerMouseDownCapture: (event: ReactMouseEvent<HTMLDivElement>) => void
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
  // Allow mousedown anywhere inside the editor — including inside block text.
  // BlockNote shadcn has no margin/gutter, so promotion to marquee is gated by
  // gesture direction (vertical drag) and not by click target. This preserves
  // horizontal text selection inside a paragraph.
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
  containerRef,
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
    const container = containerRef.current
    if (container) container.removeAttribute(ACTIVE_ATTR)
  }, [containerRef])

  const onContainerMouseDownCapture = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>): void => {
      if (!enabled) return
      if (event.button !== 0) return
      if (!shouldStartMarquee(event.target)) return

      const container = containerRef.current
      if (!container) return

      // Mid-drag re-entry guard: if a previous gesture is still wired up, drop it.
      teardownDragRef.current?.()
      teardownDragRef.current = null

      // Clear any prior visual selection on a fresh mousedown.
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
        container.setAttribute(ACTIVE_ATTR, 'true')
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
        const containerBounds = container.getBoundingClientRect()
        const clampedX = Math.max(
          containerBounds.left,
          Math.min(lastMove.clientX, containerBounds.right)
        )
        const clampedY = Math.max(
          containerBounds.top,
          Math.min(lastMove.clientY, containerBounds.bottom)
        )

        const left = Math.min(origin.clientX, clampedX)
        const right = Math.max(origin.clientX, clampedX)
        const top = Math.min(origin.clientY, clampedY)
        const bottom = Math.max(origin.clientY, clampedY)

        const blockEls = container.querySelectorAll<HTMLElement>('.bn-block[data-id]')
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
              left: blockRect.left - containerBounds.left,
              top: blockRect.top - containerBounds.top,
              width: blockRect.width,
              height: blockRect.height
            })
          }
        })
        selectedRef.current = next
        setHighlightRects(nextRects)

        setMarqueeRect({
          left: left - containerBounds.left,
          top: top - containerBounds.top,
          width: right - left,
          height: bottom - top
        })
      }

      const onMove = (moveEvent: globalThis.MouseEvent): void => {
        lastMove = { clientX: moveEvent.clientX, clientY: moveEvent.clientY }

        if (!isMarquee) {
          const dx = Math.abs(moveEvent.clientX - origin.clientX)
          const dy = Math.abs(moveEvent.clientY - origin.clientY)
          // Only promote on a clearly vertical drag — preserves horizontal
          // text selection inside a paragraph (drag right to highlight a word).
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
        container.removeAttribute(ACTIVE_ATTR)
        setSelectedBlockIds(finalIds)
        hasSelectionRef.current = finalIds.size > 0
        if (finalIds.size === 0) setHighlightRects([])

        if (finalIds.size >= 2) {
          const ordered = getOrderedBlockIds(container, finalIds)
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
    },
    [containerRef, editor, enabled]
  )

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
      const container = containerRef.current
      if (!container) return
      if (event.target instanceof Node && container.contains(event.target)) return
      clearSelection()
    }
    document.addEventListener('mousedown', onMouseDown, true)
    return () => document.removeEventListener('mousedown', onMouseDown, true)
  }, [clearSelection, containerRef])

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

  useEffect(() => {
    const container = containerRef.current
    return () => {
      teardownDragRef.current?.()
      teardownDragRef.current = null
      if (container) container.removeAttribute(ACTIVE_ATTR)
    }
  }, [containerRef])

  return {
    marqueeRect,
    highlightRects,
    isActive,
    selectedBlockIds,
    clearSelection,
    onContainerMouseDownCapture
  }
}
