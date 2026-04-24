import { ChevronDown, ChevronRight } from '@/lib/icons'
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
          'w-full flex items-center rounded-md py-1.5 px-2 gap-2',
          'cursor-pointer select-none',
          'transition-colors duration-150',
          'hover:bg-[var(--surface-active)]/50'
        )}
      >
        <div
          className={cn(
            'w-[3px] h-3.5 shrink-0 rounded-xs transition-colors duration-150',
            isExpanded ? 'bg-sidebar-terracotta' : 'bg-transparent'
          )}
        />
        <ChevronRight
          className={cn(
            'h-3 w-3 shrink-0 transition-transform duration-150',
            isExpanded ? 'text-sidebar-terracotta rotate-90' : 'text-text-tertiary'
          )}
        />
        <span
          className={cn(
            'text-[12px] font-sans leading-4 transition-colors duration-150',
            isExpanded ? 'text-sidebar-terracotta font-medium' : 'text-text-secondary'
          )}
        >
          Properties
        </span>
        {propertyCount > 0 && (
          <span
            className={cn(
              'text-[11px] font-sans leading-3.5 transition-colors duration-150',
              isExpanded ? 'text-sidebar-terracotta/60' : 'text-text-tertiary'
            )}
          >
            {propertyCount}
          </span>
        )}
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={isExpanded}
      className={cn(
        'w-full flex items-center rounded-md py-1.5 px-2 gap-2',
        'cursor-pointer select-none',
        'transition-colors duration-150',
        'hover:bg-[var(--surface-active)]/50'
      )}
    >
      <div
        className={cn(
          'w-[3px] h-3.5 shrink-0 rounded-xs transition-colors duration-150',
          isExpanded ? 'bg-sidebar-terracotta' : 'bg-transparent'
        )}
      />
      <ChevronRight
        className={cn(
          'h-3 w-3 shrink-0 transition-transform duration-150',
          isExpanded ? 'text-sidebar-terracotta rotate-90' : 'text-text-tertiary'
        )}
      />
      <span
        className={cn(
          'text-[12px] font-sans leading-4 transition-colors duration-150',
          isExpanded ? 'text-sidebar-terracotta font-medium' : 'text-text-secondary'
        )}
      >
        Properties
      </span>
      {propertyCount > 0 && (
        <span
          className={cn(
            'text-[11px] font-sans leading-3.5 transition-colors duration-150',
            isExpanded ? 'text-sidebar-terracotta/60' : 'text-text-tertiary'
          )}
        >
          {propertyCount}
        </span>
      )}
    </button>
  )
}
