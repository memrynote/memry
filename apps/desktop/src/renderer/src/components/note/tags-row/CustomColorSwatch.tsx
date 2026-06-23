import { cn } from '@/lib/utils'
import { isHexColor } from './tag-colors'
import { useT } from '@memry/i18n/renderer'

interface CustomColorSwatchProps {
  value: string
  onChange: (hex: string) => void
  size?: 'sm' | 'md'
  className?: string
}

// A "custom color" swatch backed by the native OS color picker. The current
// value drives the swatch fill when it's already a custom hex; otherwise the
// swatch shows a rainbow conic gradient as the affordance.
export function CustomColorSwatch({
  value,
  onChange,
  size = 'md',
  className
}: CustomColorSwatchProps) {
  const { t } = useT('notes')
  const isCustom = isHexColor(value)
  const sizeClass = size === 'sm' ? 'h-6 w-6' : 'h-7 w-7'

  return (
    <label
      aria-label={t('tagsRow.customColor')}
      title={t('tagsRow.customColor')}
      className={cn(
        'relative inline-flex cursor-pointer items-center justify-center rounded-full',
        'transition-transform duration-150 hover:scale-110 focus-within:scale-110',
        sizeClass,
        isCustom && 'ring-2 ring-foreground/50 ring-offset-2 ring-offset-background',
        className
      )}
      style={{
        background: isCustom
          ? value
          : 'conic-gradient(red, orange, yellow, lime, cyan, blue, magenta, red)'
      }}
    >
      <input
        type="color"
        value={isCustom ? value : '#888888'}
        onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 cursor-pointer opacity-0"
      />
    </label>
  )
}
