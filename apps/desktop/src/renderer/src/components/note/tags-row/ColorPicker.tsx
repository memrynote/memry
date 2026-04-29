import { cn } from '@/lib/utils'
import { TAG_COLORS, COLOR_ROWS, getTagColors, withAlpha } from './tag-colors'
import { Check } from '@/lib/icons'
import { useT } from '@memry/i18n/renderer'

interface ColorPickerProps {
  selectedColor: string
  onSelectColor: (color: string) => void
  tagName: string
  onCancel: () => void
  onConfirm: () => void
}

export function ColorPicker({
  selectedColor,
  onSelectColor,
  tagName,
  onCancel,
  onConfirm
}: ColorPickerProps) {
  const { t } = useT('notes')
  const { t: tCommon } = useT('common')
  const previewColors = getTagColors(selectedColor)

  return (
    <div className="p-3">
      {/* Header */}
      <div className="mb-3 text-sm font-medium text-foreground">
        {t('tagsRow.createTag', { tag: tagName })}
      </div>

      {/* Divider */}
      <div className="mb-3 border-t border-border" />

      {/* Color label */}
      <div className="mb-2 text-xs font-medium text-muted-foreground">
        {t('tagsRow.chooseColor')}
      </div>

      {/* Color grid */}
      <div className="mb-4 space-y-2">
        {COLOR_ROWS.map((row, rowIndex) => (
          <div key={rowIndex} className="flex gap-2">
            {row.map((colorName) => {
              const colors = TAG_COLORS[colorName]
              const isSelected = selectedColor === colorName

              return (
                <button
                  key={colorName}
                  type="button"
                  onClick={() => onSelectColor(colorName)}
                  aria-label={t('tagsRow.colorAria', { color: colorName })}
                  aria-pressed={isSelected}
                  className={cn(
                    'flex h-6 w-6 items-center justify-center rounded-full',
                    'transition-all duration-150',
                    'hover:scale-110',
                    'focus:outline-none',
                    isSelected && 'ring-2 ring-white/30 ring-offset-1 ring-offset-background'
                  )}
                  style={{ backgroundColor: colors.background }}
                >
                  {isSelected && <Check className="h-3 w-3 text-background" />}
                </button>
              )
            })}
          </div>
        ))}
      </div>

      {/* Preview */}
      <div className="mb-4">
        <div className="mb-1 text-xs font-medium text-muted-foreground">{t('tagsRow.preview')}</div>
        <span
          className="inline-flex items-center rounded-[10px] px-2 py-0.5 text-[11px]/3.5 font-medium [font-synthesis:none]"
          style={{
            backgroundColor: withAlpha(previewColors.text, 0.12),
            color: previewColors.text
          }}
        >
          {tagName}
        </span>
      </div>

      {/* Actions */}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className={cn(
            'rounded-md px-3 py-1.5',
            'text-sm text-muted-foreground',
            'transition-colors duration-150',
            'hover:bg-muted'
          )}
        >
          {tCommon('button.cancel')}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className={cn(
            'rounded-md px-3 py-1.5',
            'text-sm font-medium text-background',
            'bg-foreground',
            'transition-colors duration-150',
            'hover:bg-foreground/90'
          )}
        >
          {tCommon('button.create')}
        </button>
      </div>
    </div>
  )
}
