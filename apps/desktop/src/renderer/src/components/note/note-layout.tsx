import { ReactNode, useCallback, useRef } from 'react'
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
  fullWidth = false
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

  return (
    <div className={cn('h-full w-full overflow-hidden flex flex-col relative', className)}>
      {(breadcrumb || actions) && (
        <div className="flex items-center justify-between h-9 py-2 px-6 shrink-0 text-xs/4 [font-synthesis:none]">
          <div className="flex items-center">{breadcrumb}</div>
          <div className="flex items-center">{actions}</div>
        </div>
      )}
      <div ref={scrollRef} className="flex-1 overflow-y-auto overflow-x-visible">
        <div
          className="mx-auto w-full px-24 pt-6 pb-10 min-h-full flex flex-col transition-[max-width] duration-300 ease-in-out"
          style={{ maxWidth: fullWidth ? '100%' : '64rem' }}
        >
          {children}
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
