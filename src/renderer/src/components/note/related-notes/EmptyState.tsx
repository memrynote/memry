import { cn } from '@/lib/utils'
import { BarChart3, RefreshCw } from 'lucide-react'

interface EmptyStateProps {
  onRefresh: () => void
}

export function EmptyState({ onRefresh }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-10 px-6 text-center">
      <div className="mb-4">
        <BarChart3 className="h-12 w-12 text-stone-300" />
      </div>
      <h3 className="text-sm font-medium text-stone-600 mb-2">
        No related notes found
      </h3>
      <p className="text-[13px] text-stone-400 max-w-[200px] mb-4">
        AI couldn't find notes similar to this one. Add more content or create new
        notes to see connections.
      </p>
      <button
        onClick={onRefresh}
        className={cn(
          'inline-flex items-center gap-2',
          'px-4 py-2',
          'text-sm font-medium text-stone-600',
          'bg-transparent border border-stone-300 rounded-lg',
          'hover:bg-stone-100 hover:border-stone-400',
          'transition-colors duration-150'
        )}
      >
        <RefreshCw className="h-4 w-4" />
        <span>Refresh</span>
      </button>
    </div>
  )
}
