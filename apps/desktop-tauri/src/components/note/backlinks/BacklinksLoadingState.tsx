import { Loader2 } from '@/lib/icons'

export function BacklinksLoadingState() {
  return (
    <div className="flex items-center gap-1.5 px-1.5 py-2">
      <Loader2 className="h-3 w-3 text-text-tertiary animate-spin" />
      <span className="text-[11px] text-text-tertiary">Loading&hellip;</span>
    </div>
  )
}
