import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/skeleton'

export function LoadingSkeleton() {
  return (
    <div className="space-y-2.5 p-4">
      {[1, 2, 3].map((i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  )
}

function SkeletonCard() {
  return (
    <div
      className={cn(
        'bg-white border border-stone-200 rounded-[10px] p-3.5',
        'animate-pulse'
      )}
    >
      {/* Header */}
      <div className="flex items-start gap-2 mb-2.5">
        <Skeleton className="h-5 w-5 rounded bg-stone-200" />
        <Skeleton className="h-4 flex-1 rounded bg-stone-200" />
      </div>

      {/* Badge */}
      <Skeleton className="h-6 w-16 rounded-xl bg-stone-200 mb-2.5" />

      {/* Snippet lines */}
      <div className="space-y-1.5 mb-2.5">
        <Skeleton className="h-3.5 w-full rounded bg-stone-200" />
        <Skeleton className="h-3.5 w-3/4 rounded bg-stone-200" />
      </div>

      {/* Metadata */}
      <div className="flex items-center gap-2">
        <Skeleton className="h-3 w-20 rounded bg-stone-200" />
        <Skeleton className="h-3 w-24 rounded bg-stone-200" />
      </div>
    </div>
  )
}
