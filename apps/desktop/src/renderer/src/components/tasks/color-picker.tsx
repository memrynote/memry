import { Check } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { projectColors } from '@/data/tasks-data'
import { useT } from '@memry/i18n/renderer'

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

/**
 * The built-in palette ships English `label`s, so its swatches get a localized
 * name instead. A caller that passes its own palette keeps its own labels —
 * matching on id *and* value keeps a custom entry that reuses one of our ids
 * (but a different hex) on the caller's label.
 */
const isProjectPaletteColor = (id: string, value: string): boolean =>
  projectColors.some((c) => c.id === id && c.value === value)

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
  const { t } = useT('tasks')

  const projectColorNames: Record<string, string> = {
    gray: t('colors.gray'),
    red: t('colors.red'),
    orange: t('colors.orange'),
    yellow: t('colors.yellow'),
    green: t('colors.green'),
    teal: t('colors.teal'),
    blue: t('colors.blue'),
    indigo: t('colors.indigo'),
    purple: t('colors.purple'),
    pink: t('colors.pink')
  }
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
      aria-label={t('phaseF.componentsTasksColorPicker.selectColor')}
    >
      {colors.map((color) => {
        const isSelected = value === color.value
        const localizedName = isProjectPaletteColor(color.id, color.value)
          ? projectColorNames[color.id]
          : undefined
        return (
          <button
            key={color.id}
            type="button"
            role="radio"
            aria-checked={isSelected}
            aria-label={localizedName || color.label || color.id}
            onClick={handleColorClick(color.value)}
            onKeyDown={handleKeyDown(color.value)}
            tabIndex={0}
            className={cn(
              'rounded-full transition-all duration-150',
              'focus-visible:outline-none',
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
