import { cn } from '@/lib/utils'

// ============================================================================
// TYPES
// ============================================================================

type BulkActionVariant = 'default' | 'secondary' | 'danger'

interface BulkActionButtonProps {
  /** Icon to display */
  icon: React.ReactNode
  /** Button label */
  label: string
  /** Click handler */
  onClick: () => void
  /** Button variant */
  variant?: BulkActionVariant
  /** Whether the button is disabled */
  disabled?: boolean
  /** Additional class names */
  className?: string
}

// ============================================================================
// COMPONENT
// ============================================================================

const variantStyles: Record<BulkActionVariant, string> = {
  default: 'bg-background border-border hover:bg-accent text-foreground',
  secondary: 'bg-background border-border hover:bg-accent text-muted-foreground',
  danger: 'bg-background border-destructive/30 hover:bg-destructive/10 text-destructive'
}

/**
 * Button component for bulk actions toolbar
 */
export const BulkActionButton = ({
  icon,
  label,
  onClick,
  variant = 'default',
  disabled = false,
  className
}: BulkActionButtonProps): React.JSX.Element => {
  const handleClick = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    if (!disabled) {
      onClick()
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if ((e.key === 'Enter' || e.key === ' ') && !disabled) {
      e.preventDefault()
      e.stopPropagation()
      onClick()
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      disabled={disabled}
      className={cn(
        'flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium',
        'transition-colors duration-150',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'disabled:cursor-not-allowed disabled:opacity-50',
        variantStyles[variant],
        className
      )}
      aria-label={label}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </button>
  )
}

export default BulkActionButton
