import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ChevronRight, X } from 'lucide-react'
import { RelatedNotesTab } from './related-notes'

interface RightSidebarProps {
  isOpen: boolean
  onToggle: () => void
  className?: string
}

export function RightSidebar({
  isOpen,
  onToggle,
  className
}: RightSidebarProps) {
  return (
    <>
      {/* Mobile backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/20 z-40 lg:hidden"
          onClick={onToggle}
          aria-hidden="true"
        />
      )}

      {/* Sidebar */}
      <div
        className={cn(
          'fixed lg:relative right-0 top-0 h-full w-80 bg-sidebar',
          'border-l border-sidebar-border/50 shadow-sm',
          'transition-transform duration-200 ease-out z-50',
          'flex flex-col',
          isOpen ? 'translate-x-0' : 'translate-x-full lg:translate-x-0',
          !isOpen && 'lg:w-0 lg:border-0 lg:shadow-none',
          className
        )}
      >
        {/* Header with close button (mobile) */}
        <div className="flex items-center justify-between px-4 py-3 lg:hidden border-b border-sidebar-border/40">
          <h2 className="font-display text-sm font-medium text-sidebar-primary">Related</h2>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 hover:bg-sidebar-accent/50"
            onClick={onToggle}
            aria-label="Close sidebar"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Content - Related Notes */}
        <div className="flex-1 overflow-hidden">
          <RelatedNotesTab />
        </div>
      </div>

      {/* Collapse/expand toggle button (desktop only) */}
      {!isOpen && (
        <button
          onClick={onToggle}
          className={cn(
            'hidden lg:flex items-center justify-center',
            'fixed right-0 top-1/2 -translate-y-1/2',
            'w-6 h-16 bg-sidebar border border-r-0 border-sidebar-border/50',
            'rounded-l-md shadow-sm',
            'hover:bg-sidebar-accent/50 hover:border-amber-500/30 transition-all duration-200',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring'
          )}
          aria-label="Open sidebar"
        >
          <ChevronRight className="h-4 w-4 text-sidebar-foreground/60 hover:text-amber-600 -ml-0.5 transition-colors" />
        </button>
      )}
    </>
  )
}
