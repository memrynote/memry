import { useCallback, useRef, type CSSProperties, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { useActiveHeading } from '@/hooks/use-active-heading'
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
  contentWidth?: string
  marqueeZoneRef?: (el: HTMLDivElement | null) => void
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
  contentWidth,
  marqueeZoneRef
}: NoteLayoutProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const { activeHeadingId, setActiveHeading } = useActiveHeading({
    headings,
    offset: 120,
    scrollContainerRef: scrollRef
  })

  const handleHeadingClick = useCallback(
    (headingId: string) => {
      setActiveHeading(headingId)
      onHeadingClick?.(headingId)
    },
    [onHeadingClick, setActiveHeading]
  )

  const hasSideRail = sideRail !== undefined && sideRail !== null
  const resolvedContentWidth = contentWidth ?? '64rem'
  const canvasStyle = hasSideRail
    ? ({
        maxWidth: fullWidth ? '100%' : `calc(${resolvedContentWidth} + 23rem)`,
        '--note-layout-content-track': fullWidth ? '1fr' : resolvedContentWidth,
        '--note-layout-content-max': resolvedContentWidth
      } as CSSProperties)
    : { maxWidth: fullWidth ? '100%' : '64rem' }

  return (
    <div className={cn('h-full w-full overflow-hidden flex flex-col relative', className)}>
      {(breadcrumb || actions) && (
        <div className="flex items-center justify-between h-9 py-2 px-6 shrink-0 text-xs/4 [font-synthesis:none]">
          <div className="flex items-center">{breadcrumb}</div>
          <div className="flex items-center">{actions}</div>
        </div>
      )}
      <div ref={scrollRef} className="flex-1 overflow-y-auto overflow-x-visible">
        <div ref={marqueeZoneRef} className="marquee-zone relative min-h-full w-full flex flex-col">
          <div
            data-note-layout-canvas
            className={cn(
              'mx-auto w-full pt-6 pb-10 min-h-full transition-[max-width] duration-300 ease-in-out',
              hasSideRail
                ? 'grid items-start gap-x-12 px-0 [grid-template-columns:minmax(0,var(--note-layout-content-track))_20rem] max-[920px]:max-w-[var(--note-layout-content-max)] max-[920px]:grid-cols-1 max-[920px]:px-8'
                : 'px-24 flex flex-col'
            )}
            style={canvasStyle}
          >
            {hasSideRail ? (
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
              children
            )}
          </div>
        </div>
      </div>

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
