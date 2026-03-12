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
  stats?: OutlineInfoPanelProps['stats']
}

const EMPTY_HEADINGS: HeadingItem[] = []

export function NoteLayout({
  children,
  headings = EMPTY_HEADINGS,
  onHeadingClick,
  className,
  actions,
  stats
}: NoteLayoutProps) {
  const { activeHeadingId } = useActiveHeading({
    headings,
    offset: 120
  })

  return (
    <div className={cn('h-full w-full overflow-hidden flex flex-col relative', className)}>
      <div className="flex-1 overflow-y-auto overflow-x-visible">
        {actions && <div className="flex justify-end px-4 pt-3 pb-0">{actions}</div>}
        <div className="mx-auto w-full max-w-4xl px-20 pt-6 pb-10">{children}</div>
      </div>

      <OutlineInfoPanel
        headings={headings}
        activeHeadingId={activeHeadingId ?? undefined}
        onHeadingClick={onHeadingClick}
        stats={stats}
      />
    </div>
  )
}

export type { HeadingItem }
