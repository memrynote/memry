import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchLinkPreview, type UrlPreviewData } from '@/lib/url-metadata'
import { extractYouTubeVideoId } from '@/lib/youtube-utils'

interface HoverPosition {
  top: number
  left: number
  placement: 'above' | 'below'
}

interface LinkMentionHoverState {
  url: string | null
  preview: UrlPreviewData | null
  position: HoverPosition | null
  isVisible: boolean
}

const HOVER_DELAY = 300
const DISMISS_DELAY = 100
const CARD_HEIGHT_ESTIMATE = 260
const VIDEO_CARD_HEIGHT_ESTIMATE = 240

export function useLinkMentionHover(
  editorContainerRef: React.RefObject<HTMLDivElement | null>
): LinkMentionHoverState & {
  handleCardMouseEnter: () => void
  handleCardMouseLeave: () => void
} {
  const [state, setState] = useState<LinkMentionHoverState>({
    url: null,
    preview: null,
    position: null,
    isVisible: false
  })

  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
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
    // Timers and the active target are cleared unconditionally: a scroll (or a
    // mouseout) that lands while a preview is merely *armed* must cancel it, or
    // the card pops up moments later over content the user has moved past.
    clearTimers()
    activeTargetRef.current = null
    // Nothing shown means nothing to hide. Handing back `prev` lets React bail
    // out instead of re-rendering the whole editor tree for an identical state.
    setState((prev) =>
      prev.isVisible ? { url: null, preview: null, position: null, isVisible: false } : prev
    )
  }, [clearTimers])

  const computePosition = useCallback((linkEl: Element, url: string): HoverPosition => {
    const linkRect = linkEl.getBoundingClientRect()
    const cardHeight = extractYouTubeVideoId(url)
      ? VIDEO_CARD_HEIGHT_ESTIMATE
      : CARD_HEIGHT_ESTIMATE

    const top = linkRect.bottom + 4
    const left = linkRect.left

    const spaceBelow = window.innerHeight - linkRect.bottom
    if (spaceBelow < cardHeight) {
      return { top: linkRect.top - cardHeight - 4, left, placement: 'above' }
    }

    return { top, left, placement: 'below' }
  }, [])

  const showPreview = useCallback(
    async (url: string, linkEl: Element) => {
      try {
        const preview = await fetchLinkPreview(url)
        if (activeTargetRef.current !== url) return
        const position = computePosition(linkEl, url)
        setState({ url, preview, position, isVisible: true })
      } catch {
        // metadata fetch failed — silently skip preview
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
      const linkEl = target.closest('[data-link-mention]')

      if (!linkEl) return

      const url = linkEl.getAttribute('data-url')?.trim()
      if (!url) return

      if (dismissTimerRef.current) {
        clearTimeout(dismissTimerRef.current)
        dismissTimerRef.current = null
      }

      if (activeTargetRef.current === url) return

      if (hoverTimerRef.current) {
        clearTimeout(hoverTimerRef.current)
      }

      activeTargetRef.current = url
      hoverTimerRef.current = setTimeout(() => {
        void showPreview(url, linkEl)
      }, HOVER_DELAY)
    }

    const handleMouseOut = (e: MouseEvent): void => {
      const target = e.target as HTMLElement
      const linkEl = target.closest('[data-link-mention]')
      if (!linkEl) return

      const related = e.relatedTarget as HTMLElement | null
      // Ignore boundary crossings between the mention's own children (favicon,
      // site, title). mouseout bubbles, so sweeping across them would otherwise
      // cancel the armed hover timer mid-flight while the re-entry mouseover
      // early-returns on the activeTarget guard — leaving the preview never shown.
      if (related && linkEl.contains(related)) return
      if (related?.closest('[data-link-mention-preview]')) return

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
