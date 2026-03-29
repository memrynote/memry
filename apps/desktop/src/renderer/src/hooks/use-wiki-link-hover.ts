import { useCallback, useEffect, useRef, useState } from 'react'
import type { WikiLinkPreview } from '@/services/notes-service'
import { notesService } from '@/services/notes-service'

interface HoverPosition {
  top: number
  left: number
  placement: 'above' | 'below'
}

interface WikiLinkHoverState {
  preview: WikiLinkPreview | null
  position: HoverPosition | null
  isVisible: boolean
}

const HOVER_DELAY = 300
const DISMISS_DELAY = 100
const CACHE_LIMIT = 50
const CARD_HEIGHT_ESTIMATE = 180

export function useWikiLinkHover(
  editorContainerRef: React.RefObject<HTMLDivElement | null>
): WikiLinkHoverState & {
  handleCardMouseEnter: () => void
  handleCardMouseLeave: () => void
} {
  const [state, setState] = useState<WikiLinkHoverState>({
    preview: null,
    position: null,
    isVisible: false
  })

  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cacheRef = useRef<Map<string, WikiLinkPreview | null>>(new Map())
  const isCardHoveredRef = useRef(false)
  const activeTargetRef = useRef<string | null>(null)

  const clearTimers = useCallback(() => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = null
    }
    if (dismissTimerRef.current) {
      clearTimeout(dismissTimerRef.current)
      dismissTimerRef.current = null
    }
  }, [])

  const dismiss = useCallback(() => {
    clearTimers()
    activeTargetRef.current = null
    setState({ preview: null, position: null, isVisible: false })
  }, [clearTimers])

  const computePosition = useCallback((linkEl: Element): HoverPosition | null => {
    const linkRect = linkEl.getBoundingClientRect()

    const top = linkRect.bottom + 4
    const left = linkRect.left

    const spaceBelow = window.innerHeight - linkRect.bottom
    if (spaceBelow < CARD_HEIGHT_ESTIMATE) {
      return {
        top: linkRect.top - CARD_HEIGHT_ESTIMATE - 4,
        left,
        placement: 'above'
      }
    }

    return { top, left, placement: 'below' }
  }, [])

  const showPreview = useCallback(
    async (target: string, linkEl: Element) => {
      const cacheKey = target.toLowerCase()
      const cache = cacheRef.current

      if (cache.has(cacheKey)) {
        const cached = cache.get(cacheKey) ?? null
        if (!cached) return
        const position = computePosition(linkEl)
        if (!position) return
        setState({ preview: cached, position, isVisible: true })
        return
      }

      try {
        const preview = await notesService.previewByTitle(target)
        if (cache.size >= CACHE_LIMIT) {
          const firstKey = cache.keys().next().value
          if (firstKey !== undefined) cache.delete(firstKey)
        }
        cache.set(cacheKey, preview)

        if (activeTargetRef.current !== target) return

        if (!preview) return
        const position = computePosition(linkEl)
        if (!position) return
        setState({ preview, position, isVisible: true })
      } catch {
        // IPC failed — silently skip preview
      }
    },
    [computePosition]
  )

  const handleCardMouseEnter = useCallback(() => {
    isCardHoveredRef.current = true
    if (dismissTimerRef.current) {
      clearTimeout(dismissTimerRef.current)
      dismissTimerRef.current = null
    }
  }, [])

  const handleCardMouseLeave = useCallback(() => {
    isCardHoveredRef.current = false
    dismissTimerRef.current = setTimeout(dismiss, DISMISS_DELAY)
  }, [dismiss])

  useEffect(() => {
    const container = editorContainerRef.current
    if (!container) return

    const handleMouseOver = (e: MouseEvent): void => {
      const target = e.target as HTMLElement
      const linkEl = target.closest('[data-wiki-link]')

      if (!linkEl) return

      const targetTitle = linkEl.getAttribute('data-target')?.trim()
      if (!targetTitle) return

      if (dismissTimerRef.current) {
        clearTimeout(dismissTimerRef.current)
        dismissTimerRef.current = null
      }

      if (activeTargetRef.current === targetTitle) return

      if (hoverTimerRef.current) {
        clearTimeout(hoverTimerRef.current)
      }

      activeTargetRef.current = targetTitle
      hoverTimerRef.current = setTimeout(() => {
        void showPreview(targetTitle, linkEl)
      }, HOVER_DELAY)
    }

    const handleMouseOut = (e: MouseEvent): void => {
      const target = e.target as HTMLElement
      const linkEl = target.closest('[data-wiki-link]')
      if (!linkEl) return

      const related = e.relatedTarget as HTMLElement | null
      if (related?.closest('[data-wiki-link-preview]')) return

      if (hoverTimerRef.current) {
        clearTimeout(hoverTimerRef.current)
        hoverTimerRef.current = null
      }

      dismissTimerRef.current = setTimeout(() => {
        if (!isCardHoveredRef.current) {
          dismiss()
        }
      }, DISMISS_DELAY)
    }

    const handleScroll = (): void => {
      dismiss()
    }

    container.addEventListener('mouseover', handleMouseOver)
    container.addEventListener('mouseout', handleMouseOut)
    container.addEventListener('scroll', handleScroll, true)

    return () => {
      container.removeEventListener('mouseover', handleMouseOver)
      container.removeEventListener('mouseout', handleMouseOut)
      container.removeEventListener('scroll', handleScroll, true)
      clearTimers()
    }
  }, [editorContainerRef, showPreview, dismiss, clearTimers])

  return {
    ...state,
    handleCardMouseEnter,
    handleCardMouseLeave
  }
}
