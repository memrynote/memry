import { ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

interface InfoHeaderProps {
  isExpanded: boolean
  onToggle: () => void
  variant?: 'default' | 'embedded'
  propertyCount?: number
}

export function InfoHeader({
  isExpanded,
  onToggle,
  variant = 'default',
  propertyCount = 0
}: InfoHeaderProps) {
  if (variant === 'embedded') {
    return (
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isExpanded}
        className={cn(
          'flex items-center gap-2 py-1',
          'cursor-pointer select-none',
          'group transition-opacity hover:opacity-80'
        )}
      >
        <ChevronRight
          className={cn(
            'h-3 w-3 text-[#B5B0A6]',
            'transition-transform duration-200',
            isExpanded && 'rotate-90'
          )}
        />
        <span className="text-[12px] font-medium text-[#B5B0A6]">
          Properties {propertyCount > 0 && <span className="opacity-60 ml-1">{propertyCount}</span>}
        </span>
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={isExpanded}
      className={cn('flex items-center py-2.5 gap-2', 'cursor-pointer select-none', 'group')}
    >
      {isExpanded ? (
        <ChevronDown className="h-3 w-3 text-[#B5B0A6]" />
      ) : (
        <ChevronRight className="h-3 w-3 text-[#B5B0A6]" />
      )}
      <span className="text-[12px] font-semibold text-[#8A857A] font-sans leading-4">
        Properties
      </span>
      {propertyCount > 0 && (
        <span className="text-[11px] text-[#B5B0A6] font-sans leading-3.5">{propertyCount}</span>
      )}
    </button>
  )
}
