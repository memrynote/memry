import { Check } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { projectColors } from '@/data/tasks-data'

// ============================================================================
// TYPES
// ============================================================================

interface ColorPickerProps {
  value: string
  onChange: (color: string) => void
  colors?: readonly { id: string; value: string; label?: string }[]
  size?: 'sm' | 'md'
  className?: string
}

// ============================================================================
// COLOR PICKER COMPONENT
// ============================================================================

export const ColorPicker = ({
  value,
  onChange,
  colors = projectColors,
  size = 'md',
  className
}: ColorPickerProps): React.JSX.Element => {
  const handleColorClick = (color: string) => (): void => {
    onChange(color)
  }

  const handleKeyDown =
    (color: string) =>
    (e: React.KeyboardEvent): void => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onChange(color)
      }
    }

  const sizeClasses = size === 'sm' ? 'size-6' : 'size-8'
  const checkSize = size === 'sm' ? 'size-3' : 'size-4'

  return (
    <div
      className={cn('flex flex-wrap gap-2', className)}
      role="radiogroup"
      aria-label="Select color"
    >
      {colors.map((color) => {
        const isSelected = value === color.value
        return (
          <button
            key={color.id}
            type="button"
            role="radio"
            aria-checked={isSelected}
            aria-label={color.label || color.id}
            onClick={handleColorClick(color.value)}
            onKeyDown={handleKeyDown(color.value)}
            tabIndex={0}
            className={cn(
              'rounded-full transition-all duration-150',
              'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-2',
              'hover:scale-110',
              sizeClasses,
              isSelected && 'ring-2 ring-offset-2 ring-ring'
            )}
            style={{ backgroundColor: color.value }}
          >
            {isSelected && (
              <Check
                className={cn(checkSize, 'mx-auto text-white drop-shadow-sm')}
                strokeWidth={3}
                aria-hidden="true"
              />
            )}
          </button>
        )
      })}
    </div>
  )
}

export default ColorPicker
