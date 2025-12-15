import { cn } from '@/lib/utils'
import { Link2, RefreshCw } from 'lucide-react'

interface EmptyStateProps {
  onRefresh: () => void
}

export function EmptyState({ onRefresh }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center h-full px-6 py-12 text-center journal-animate-in">
      {/* Decorative element */}
      <div className="mb-4 p-4 rounded-full bg-sidebar-accent/30">
        <Link2 className="size-8 text-sidebar-foreground/30" />
      </div>

      <h4 className="font-display text-lg font-medium text-sidebar-primary/80 mb-2">
        No connections yet
      </h4>
      <p className="font-serif text-sm italic text-sidebar-foreground/50 mb-6 max-w-[200px]">
        Start writing to discover related notes in your knowledge base
      </p>

      <button
        onClick={onRefresh}
        className={cn(
          'inline-flex items-center gap-1.5',
          'px-4 py-2',
          'font-sans text-xs font-medium text-sidebar-foreground/70',
          'bg-transparent border border-sidebar-border/40 rounded-lg',
          'hover:bg-sidebar-accent/30 hover:border-amber-500/30 hover:text-sidebar-foreground',
          'transition-all duration-200'
        )}
      >
        <RefreshCw className="size-3.5" />
        <span>Refresh</span>
      </button>
    </div>
  )
}
