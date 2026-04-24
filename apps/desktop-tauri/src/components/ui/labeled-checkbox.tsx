/**
 * LabeledCheckbox Component
 *
 * A styled checkbox with label, using the warm amber accent color.
 * Designed for dialog footers and form sections.
 */

import { Checkbox } from '@/components/ui/checkbox'
import { cn } from '@/lib/utils'

export interface LabeledCheckboxProps {
  /** Whether the checkbox is checked */
  checked: boolean
  /** Callback when checked state changes */
  onCheckedChange: (checked: boolean) => void
  /** Label text */
  label: string
  /** Optional description below label */
  description?: string
  /** Whether the checkbox is disabled */
  disabled?: boolean
  /** Additional class names for the container */
  className?: string
}

export function LabeledCheckbox({
  checked,
  onCheckedChange,
  label,
  description,
  disabled = false,
  className
}: LabeledCheckboxProps) {
  return (
    <label
      className={cn(
        'flex items-start gap-2.5 cursor-pointer group',
        disabled && 'cursor-not-allowed opacity-50',
        className
      )}
    >
      <Checkbox
        checked={checked}
        onCheckedChange={(value) => onCheckedChange(value === true)}
        disabled={disabled}
        className={cn(
          'mt-0.5',
          'border-muted-foreground/30',
          'data-[state=checked]:bg-amber-600 data-[state=checked]:border-amber-600',
          'dark:data-[state=checked]:bg-amber-500 dark:data-[state=checked]:border-amber-500',
          'transition-colors'
        )}
      />
      <div className="flex flex-col">
        <span
          className={cn(
            'text-sm text-muted-foreground',
            'group-hover:text-foreground/80',
            'transition-colors'
          )}
        >
          {label}
        </span>
        {description && (
          <span className="text-xs text-muted-foreground/60 mt-0.5">{description}</span>
        )}
      </div>
    </label>
  )
}

export default LabeledCheckbox
