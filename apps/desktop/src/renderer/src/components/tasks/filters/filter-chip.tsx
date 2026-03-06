import { X } from 'lucide-react'

import { cn } from '@/lib/utils'

// ============================================================================
// TYPES
// ============================================================================

interface FilterChipProps {
  label: string
  icon?: React.ReactNode
  color?: string
  onRemove: () => void
  className?: string
}

// ============================================================================
// FILTER CHIP COMPONENT
// ============================================================================

export const FilterChip = ({
  label,
  icon,
  color,
  onRemove,
  className
}: FilterChipProps): React.JSX.Element => {
  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault()
      onRemove()
    }
  }

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 px-2 py-1 bg-muted rounded-full text-sm',
        'group transition-colors hover:bg-muted/80',
        className
      )}
    >
      {icon && <span className="shrink-0">{icon}</span>}
      {color && (
        <span
          className="size-2 shrink-0 rounded-full"
          style={{ backgroundColor: color }}
          aria-hidden="true"
        />
      )}
      <span className="truncate max-w-32">{label}</span>
      <button
        type="button"
        onClick={onRemove}
        onKeyDown={handleKeyDown}
        className={cn(
          'ml-0.5 p-0.5 rounded-full transition-colors',
          'text-muted-foreground hover:text-foreground hover:bg-muted-foreground/20',
          'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1'
        )}
        aria-label={`Remove ${label} filter`}
        tabIndex={0}
      >
        <X className="size-3" />
      </button>
    </span>
  )
}

export default FilterChip
