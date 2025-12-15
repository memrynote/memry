import { cn } from '@/lib/utils'

export function LoadingSkeleton() {
  return (
    <div className="space-y-3 p-4">
      {[1, 2, 3].map((i) => (
        <SkeletonCard key={i} index={i} />
      ))}
    </div>
  )
}

function SkeletonCard({ index }: { index: number }) {
  return (
    <div
      className={cn(
        'p-3.5 rounded-lg',
        'bg-sidebar-accent/20 border border-sidebar-border/10',
        'animate-pulse'
      )}
      style={{ animationDelay: `${index * 100}ms` }}
    >
      {/* Header with icon and title */}
      <div className="flex items-center gap-2.5 mb-2">
        <div className="size-6 rounded-md bg-sidebar-accent/40" />
        <div className="h-4 bg-sidebar-accent/40 rounded flex-1 max-w-[60%]" />
        <div className="h-4 w-8 bg-sidebar-accent/30 rounded" />
      </div>

      {/* Snippet lines */}
      <div className="pl-8 space-y-1.5 mb-2.5">
        <div className="h-3 bg-sidebar-accent/30 rounded w-full" />
        <div className="h-3 bg-sidebar-accent/20 rounded w-3/4" />
      </div>

      {/* Metadata */}
      <div className="pl-8 flex items-center gap-2">
        <div className="h-2.5 w-16 bg-sidebar-accent/20 rounded" />
        <div className="h-2.5 w-20 bg-sidebar-accent/20 rounded" />
      </div>
    </div>
  )
}
