import { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { OutlineInfoPanel, type DocumentStats } from '@/components/shared'
import { useActiveHeading } from '@/hooks/use-active-heading'

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
  /** Document statistics for the Info tab */
  stats?: DocumentStats
}

const EMPTY_HEADINGS: HeadingItem[] = []

export function NoteLayout({
  children,
  headings = EMPTY_HEADINGS,
  onHeadingClick,
  className,
  stats
}: NoteLayoutProps) {
  // T078: Track active heading based on scroll position
  const { activeHeadingId } = useActiveHeading({
    headings,
    offset: 120 // Account for header/toolbar height
  })

  return (
    <div className={cn('h-full w-full overflow-hidden flex', className)}>
      {/* Main content area with floating outline edge */}
      <div className="flex-1 relative">
        {/* Main content zone */}
        <div className="h-full overflow-y-auto overflow-x-visible">
          {/* Centered content wrapper */}
          <div className="mx-auto w-full max-w-5xl px-6 md:px-12 lg:px-16 py-8">{children}</div>
        </div>

        {/* Floating outline panel with Info tab - positioned at right of viewport */}
        <OutlineInfoPanel
          headings={headings}
          onHeadingClick={onHeadingClick}
          activeHeadingId={activeHeadingId ?? undefined}
          stats={stats}
        />
      </div>
    </div>
  )
}

export type { HeadingItem }
