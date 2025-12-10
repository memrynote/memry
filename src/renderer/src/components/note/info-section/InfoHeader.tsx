import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

interface InfoHeaderProps {
  isExpanded: boolean
  onToggle: () => void
}

export function InfoHeader({ isExpanded, onToggle }: InfoHeaderProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={isExpanded}
      className={cn(
        'flex items-center gap-2 py-2',
        'cursor-pointer select-none',
        'group'
      )}
    >
      <ChevronRight
        className={cn(
          'h-3 w-3 text-stone-400',
          'transition-transform duration-200',
          isExpanded && 'rotate-90'
        )}
      />
      <span
        className={cn(
          'text-[13px] font-medium text-stone-500',
          'transition-colors duration-150',
          'group-hover:text-stone-700'
        )}
      >
        Info
      </span>
    </button>
  )
}
