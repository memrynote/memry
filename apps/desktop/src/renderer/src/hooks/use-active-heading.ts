/**
 * useActiveHeading Hook
 *
 * Tracks scroll position and determines which heading is currently active
 * based on which heading element is closest to the top of the viewport.
 *
 * T078: Simplified implementation - relies on BlockNote's data-id attributes
 * being enabled via setIdAttribute: true
 */

import { useState, useEffect, useCallback, useMemo, useRef, type RefObject } from 'react'

interface HeadingItem {
  id: string
  level: number
  text: string
  position: number
}

interface UseActiveHeadingOptions {
  /** The headings to track */
  headings: HeadingItem[]
  /** Offset from the top of the viewport (in pixels) to consider "active" */
  offset?: number
  /** Throttle interval in ms for scroll events */
  throttleMs?: number
  /** Ref to the scroll container element */
  scrollContainerRef?: RefObject<HTMLElement | null>
}

interface UseActiveHeadingResult {
  /** The ID of the currently active heading */
  activeHeadingId: string | null
  /** Immediately set active heading (e.g. on outline click) — scroll tracking takes over after */
  setActiveHeading: (id: string) => void
}

/**
 * The editor re-extracts headings 200 ms after every keystroke, so an untouched
 * outline still arrives as a brand-new array. Collapsing equal arrays onto one
 * identity keeps the scroll listeners subscribed instead of churning them.
 */
function headingsSignature(headings: HeadingItem[]): string {
  return headings
    .map((h) => `${h.id}\u0000${h.level}\u0000${h.position}\u0000${h.text}`)
    .join('\u0001')
}

/**
 * Determines the active heading based on scroll position.
 * Returns the heading that is at or just above the viewport top.
 */
export function useActiveHeading({
  headings,
  offset = 120,
  throttleMs = 50,
  scrollContainerRef
}: UseActiveHeadingOptions): UseActiveHeadingResult {
  const [activeHeadingId, setActiveHeadingId] = useState<string | null>(null)
  const lastScrollTimeRef = useRef(0)
  const rafIdRef = useRef<number | null>(null)
  const headingElementsRef = useRef(new Map<string, Element>())

  const signature = headingsSignature(headings)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableHeadings = useMemo(() => headings, [signature])

  const resolveHeadingElement = useCallback(
    (id: string): Element | null => {
      const cached = headingElementsRef.current.get(id)
      // A cached node survives scrolling but not a body rewrite: once the editor
      // replaces the block, the old node is detached and its rect reads as zero.
      if (cached && cached.isConnected) return cached

      // Scoped to this pane. In split view both panes render the same note's
      // block ids, and a document-wide lookup hands this pane the other one's
      // element — the outline would then highlight against the wrong scroller.
      const root: ParentNode = scrollContainerRef?.current ?? document
      const element = root.querySelector(`[data-id="${id}"]`)
      if (element) headingElementsRef.current.set(id, element)
      else headingElementsRef.current.delete(id)
      return element
    },
    [scrollContainerRef]
  )

  const findActiveHeading = useCallback(() => {
    if (stableHeadings.length === 0) {
      setActiveHeadingId(null)
      return
    }

    const container = scrollContainerRef?.current

    // When scrolled to bottom, pick the last visible heading
    if (container) {
      const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 2
      if (atBottom) {
        for (let i = stableHeadings.length - 1; i >= 0; i--) {
          const el = resolveHeadingElement(stableHeadings[i].id)
          if (el) {
            const rect = el.getBoundingClientRect()
            if (rect.top < window.innerHeight && rect.bottom > 0) {
              setActiveHeadingId(stableHeadings[i].id)
              return
            }
          }
        }
      }
    }

    let activeId: string | null = null

    for (const heading of stableHeadings) {
      const element = resolveHeadingElement(heading.id)
      if (element) {
        const rect = element.getBoundingClientRect()
        if (rect.top <= offset) {
          activeId = heading.id
        } else {
          break
        }
      }
    }

    // If no heading is above threshold, use the first visible heading
    if (!activeId && stableHeadings.length > 0) {
      const firstElement = resolveHeadingElement(stableHeadings[0].id)
      if (firstElement) {
        const rect = firstElement.getBoundingClientRect()
        if (rect.top < window.innerHeight && rect.bottom > 0) {
          activeId = stableHeadings[0].id
        }
      }
    }

    setActiveHeadingId(activeId)
  }, [stableHeadings, offset, scrollContainerRef, resolveHeadingElement])

  const handleScroll = useCallback(() => {
    const now = Date.now()

    // Throttle scroll events
    if (now - lastScrollTimeRef.current < throttleMs) {
      // Schedule an update if not already scheduled
      if (!rafIdRef.current) {
        rafIdRef.current = requestAnimationFrame(() => {
          rafIdRef.current = null
          findActiveHeading()
        })
      }
      return
    }

    lastScrollTimeRef.current = now
    findActiveHeading()
  }, [findActiveHeading, throttleMs])

  useEffect(() => {
    // Drop references to the previous outline's nodes so a long editing session
    // does not retain a detached element for every heading it ever rendered.
    headingElementsRef.current = new Map()

    if (stableHeadings.length === 0) return

    const initialCalculation = requestAnimationFrame(findActiveHeading)

    const target = scrollContainerRef?.current ?? window

    // Add scroll listener
    target.addEventListener('scroll', handleScroll, { passive: true })

    // Also listen to resize events as they may affect heading positions
    window.addEventListener('resize', handleScroll, { passive: true })

    return () => {
      cancelAnimationFrame(initialCalculation)
      target.removeEventListener('scroll', handleScroll)
      window.removeEventListener('resize', handleScroll)

      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current)
        rafIdRef.current = null
      }
    }
  }, [stableHeadings, handleScroll, findActiveHeading, scrollContainerRef])

  const setActiveHeading = useCallback((id: string) => {
    setActiveHeadingId(id)
  }, [])

  // Derive empty state during render so we don't have to reset in an effect.
  return {
    activeHeadingId: headings.length === 0 ? null : activeHeadingId,
    setActiveHeading
  }
}

export type { HeadingItem, UseActiveHeadingOptions, UseActiveHeadingResult }
