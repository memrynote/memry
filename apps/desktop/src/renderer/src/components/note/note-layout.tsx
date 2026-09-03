import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type UIEvent
} from 'react'
import { cn } from '@/lib/utils'
import { useActiveHeading } from '@/hooks/use-active-heading'
import { useTabScrollRestore } from '@/hooks/use-tab-scroll-restore'
import { useReviewRailShift } from '@/hooks/use-review-rail-shift'
import { OutlineInfoPanel, type OutlineInfoPanelProps } from '../shared/outline-info-panel'

interface HeadingItem {
  id: string
  level: number
  text: string
  position: number
}

interface NoteLayoutProps {
  children: ReactNode
  headings?: HeadingItem[]
  onHeadingClick?: (headingId: string) => void
  className?: string
  actions?: ReactNode
  breadcrumb?: ReactNode
  topBar?: ReactNode
  stats?: OutlineInfoPanelProps['stats']
  fullWidth?: boolean
  sideRail?: ReactNode
  /**
   * Covers the scrolling content, leaving the chrome and the outline panel
   * reachable. The children stay mounted underneath — the note mind map relies
   * on that, because unmounting the editor would destroy its undo history.
   */
  overlay?: ReactNode
  contentWidth?: string
  marqueeZoneRef?: (el: HTMLDivElement | null) => void
  onRailHiddenChange?: (hidden: boolean) => void
  /**
   * The heading the reader is currently on, as scroll tracking sees it.
   *
   * Reported rather than lifted because the outline panel is this layout's own
   * furniture and nothing above it needs to re-render when the reader scrolls
   * past a heading. The note page keeps the value in a ref and reads it once,
   * when the mind map opens, to decide where the map's camera should land.
   */
  onActiveHeadingChange?: (headingId: string | null) => void
  /**
   * Set while the page has a heading to jump to (`[[Note#Heading]]`). Scroll
   * restore keeps saving, but does not re-apply the saved offset on this mount:
   * the user named a destination, which is the fresher intent.
   */
  suppressScrollRestore?: boolean
}

const EMPTY_HEADINGS: HeadingItem[] = []

export function NoteLayout({
  children,
  headings = EMPTY_HEADINGS,
  onHeadingClick,
  className,
  actions,
  breadcrumb,
  topBar,
  stats,
  fullWidth = false,
  sideRail,
  overlay,
  contentWidth,
  marqueeZoneRef,
  onRailHiddenChange,
  onActiveHeadingChange,
  suppressScrollRestore = false
}: NoteLayoutProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null)
  const setScrollRef = useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el
    setScrollEl(el)
  }, [])
  // This div — not the tab wrapper — is what the note and template-editor pages
  // actually scroll, so tab scroll restore has to attach here.
  const getScrollElement = useCallback(() => scrollRef.current, [])
  useTabScrollRestore({ getScrollElement, restore: !suppressScrollRestore })
  const { activeHeadingId, setActiveHeading } = useActiveHeading({
    headings,
    offset: 120,
    scrollContainerRef: scrollRef
  })

  // Lifting this, as the rule suggests, would re-render the whole note page on
  // every scroll tick to serve one read that happens when the mind map opens.
  // The plugin also traces `activeHeadingId` back to `scrollRef` and calls it a
  // ref handed to a parent; it is not — what leaves here is a heading id.
  useEffect(() => {
    // eslint-disable-next-line react-you-might-not-need-an-effect/no-pass-data-to-parent, react-you-might-not-need-an-effect/no-pass-ref-to-parent
    onActiveHeadingChange?.(activeHeadingId)
  }, [activeHeadingId, onActiveHeadingChange])

  const handleHeadingClick = useCallback(
    (headingId: string) => {
      setActiveHeading(headingId)
      onHeadingClick?.(headingId)
    },
    [onHeadingClick, setActiveHeading]
  )

  const hasSideRail = sideRail !== undefined && sideRail !== null
  const hasChrome = Boolean(breadcrumb || actions)
  // Scroll-edge effect: the chrome's hairline/shadow materializes only once
  // content is actually beneath it (state only flips at the 0 boundary).
  const [isScrolled, setIsScrolled] = useState(false)
  const handleScroll = useCallback((e: UIEvent<HTMLDivElement>) => {
    setIsScrolled(e.currentTarget.scrollTop > 0)
  }, [])
  const resolvedContentWidth = contentWidth ?? '64rem'
  const { shiftStyle, railHidden, setContentEl } = useReviewRailShift(scrollEl, {
    railEnabled: hasSideRail,
    fullWidth,
    onRailHiddenChange
  })

  // Full width keeps the reserved grid column; otherwise the rail hangs off the
  // centered content column and the group is shifted as a unit.
  const showGridRail = hasSideRail && fullWidth
  const showCanvasRail = hasSideRail && !fullWidth && !railHidden
  const canvasStyle = showGridRail
    ? ({
        maxWidth: '100%',
        '--note-layout-content-track': '1fr',
        '--note-layout-content-max': resolvedContentWidth
      } as CSSProperties)
    : {
        // 12rem compensates px-24 so the inner content width stays exactly
        // resolvedContentWidth with or without the rail.
        maxWidth: fullWidth ? '100%' : contentWidth ? `calc(${contentWidth} + 12rem)` : '64rem'
      }

  return (
    <div
      className={cn('h-full w-full overflow-hidden flex flex-col relative', className)}
      style={{ '--note-chrome-height': hasChrome ? '2.25rem' : '0px' } as CSSProperties}
    >
      {hasChrome && (
        <div
          data-scrolled={isScrolled || undefined}
          className="note-chrome absolute top-0 inset-x-0 z-30 flex items-center justify-between h-9 py-2 px-6 text-xs/4 [font-synthesis:none]"
        >
          <div className="flex items-center">{breadcrumb}</div>
          <div className="flex items-center">{actions}</div>
        </div>
      )}
      <div
        ref={setScrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto overflow-x-visible"
      >
        <div ref={marqueeZoneRef} className="marquee-zone relative min-h-full w-full flex flex-col">
          <div
            data-note-layout-canvas
            className={cn(
              'mx-auto w-full pb-10 min-h-full transition-[max-width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]',
              hasChrome ? 'pt-15' : 'pt-6',
              showGridRail
                ? 'grid items-start gap-x-12 px-24 [grid-template-columns:minmax(0,var(--note-layout-content-track))_20rem] max-[920px]:max-w-[var(--note-layout-content-max)] max-[920px]:grid-cols-1 max-[920px]:px-8'
                : 'px-24 flex flex-col'
            )}
            style={canvasStyle}
          >
            {showGridRail ? (
              <>
                <div data-note-layout-main className="min-w-0 flex flex-col">
                  {children}
                </div>
                <div
                  data-note-layout-rail
                  data-marquee-ignore
                  className="max-[920px]:hidden min-w-0 self-start"
                >
                  {sideRail}
                </div>
              </>
            ) : (
              <div
                ref={setContentEl}
                data-note-layout-main
                className={cn('min-w-0 flex flex-col flex-1', showCanvasRail && 'review-canvas')}
                style={showCanvasRail ? shiftStyle : undefined}
              >
                {children}
                {showCanvasRail && (
                  <div data-note-layout-rail data-marquee-ignore className="review-canvas-rail">
                    {sideRail}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {overlay && (
        <div
          data-note-layout-overlay
          className="absolute inset-x-0 bottom-0 top-[var(--note-chrome-height)] z-20"
        >
          {overlay}
        </div>
      )}

      <OutlineInfoPanel
        headings={headings}
        activeHeadingId={activeHeadingId ?? undefined}
        onHeadingClick={handleHeadingClick}
        stats={stats}
      />

      {topBar}
    </div>
  )
}

export type { HeadingItem }
