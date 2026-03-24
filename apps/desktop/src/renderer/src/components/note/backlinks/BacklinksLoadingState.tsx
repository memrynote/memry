import { cn } from '@/lib/utils'
import { Loader2 } from '@/lib/icons'

export function BacklinksLoadingState() {
  return (
    <div
      className={cn(
        'bg-stone-50 border border-stone-200 rounded-md',
        'p-6 flex items-center justify-center gap-2'
      )}
    >
      <Loader2 className="h-4 w-4 text-stone-400 animate-spin" />
      <span className="text-[13px] text-stone-400">Loading backlinks...</span>
    </div>
  )
}
