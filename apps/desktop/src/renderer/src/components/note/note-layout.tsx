import { ReactNode } from 'react'
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
  stats
}: NoteLayoutProps) {
  const { activeHeadingId } = useActiveHeading({
    headings,
    offset: 120
  })

  return (
    <div className={cn('h-full w-full overflow-hidden flex flex-col relative', className)}>
      <div className="flex-1 overflow-y-auto overflow-x-visible">
        {(breadcrumb || actions) && (
          <div className="flex items-center justify-between px-4 pt-3 pb-0">
            <div className="flex items-center">{breadcrumb}</div>
            <div className="flex items-center">{actions}</div>
          </div>
        )}
        <div className="mx-auto w-full max-w-4xl px-20 pt-6 pb-[30vh]">{children}</div>
      </div>

      <OutlineInfoPanel
        headings={headings}
        activeHeadingId={activeHeadingId ?? undefined}
        onHeadingClick={onHeadingClick}
        stats={stats}
      />

      {topBar}
    </div>
  )
}

export type { HeadingItem }
