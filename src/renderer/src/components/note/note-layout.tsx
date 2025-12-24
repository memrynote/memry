import { ReactNode, useState, useEffect } from 'react'
import { cn } from '@/lib/utils'
import { OutlineEdge } from './outline-edge'
import { RightSidebar } from './right-sidebar'
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
  sidebarOpen?: boolean
  onSidebarToggle?: (isOpen: boolean) => void
}

export function NoteLayout({
  children,
  headings = [],
  onHeadingClick,
  className,
  sidebarOpen: controlledSidebarOpen,
  onSidebarToggle
}: NoteLayoutProps) {
  // Controlled vs uncontrolled sidebar state
  const [internalSidebarOpen, setInternalSidebarOpen] = useState(false)
  const isSidebarControlled = controlledSidebarOpen !== undefined
  const sidebarOpen = isSidebarControlled ? controlledSidebarOpen : internalSidebarOpen

  // Load sidebar preference from localStorage on mount
  useEffect(() => {
    if (!isSidebarControlled) {
      const savedState = localStorage.getItem('memry_note_sidebar_open')
      if (savedState !== null) {
        setInternalSidebarOpen(savedState === 'true')
      }
    }
  }, [isSidebarControlled])

  const handleSidebarToggle = () => {
    const newState = !sidebarOpen
    if (isSidebarControlled) {
      onSidebarToggle?.(newState)
    } else {
      setInternalSidebarOpen(newState)
      localStorage.setItem('memry_note_sidebar_open', String(newState))
    }
  }

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
        <div
          className="h-full overflow-y-auto overflow-x-hidden"
        >
          {/* Centered content wrapper */}
          <div className="mx-auto w-full max-w-5xl px-6 md:px-12 lg:px-16 py-8">
            {children}
          </div>
        </div>

        {/* Floating outline edge - positioned at right of viewport */}
        <OutlineEdge
          headings={headings}
          onHeadingClick={onHeadingClick}
          activeHeadingId={activeHeadingId ?? undefined}
        />
      </div>

      {/* Right sidebar zone */}
      <RightSidebar isOpen={sidebarOpen} onToggle={handleSidebarToggle} />
    </div>
  )
}

export type { HeadingItem }
