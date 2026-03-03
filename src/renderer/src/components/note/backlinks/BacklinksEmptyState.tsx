import { cn } from '@/lib/utils'
import { Link2 } from 'lucide-react'

export function BacklinksEmptyState() {
  return (
    <div className={cn('bg-stone-50 border border-stone-200 rounded-lg', 'p-8 text-center')}>
      <div className="flex justify-center mb-3">
        <Link2 className="h-6 w-6 text-stone-300" />
      </div>
      <h4 className="text-sm font-medium text-stone-500 mb-1">No backlinks yet</h4>
      <p className="text-[13px] text-stone-400">
        Other notes that link to this note will appear here.
      </p>
    </div>
  )
}
