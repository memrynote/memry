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
  default: 'text-foreground hover:bg-muted',
  secondary: 'text-foreground hover:bg-muted',
  danger: 'text-destructive hover:bg-destructive/10'
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
        'flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] font-medium transition-colors',
        'focus-visible:outline-none',
        'disabled:cursor-not-allowed disabled:opacity-50',
        variantStyles[variant],
        className
      )}
      aria-label={label}
    >
      {icon}
      {label}
    </button>
  )
}

export default BulkActionButton
