import { cn } from '@/lib/utils'
import { TAG_COLORS, COLOR_ROWS, getTagColors } from './tag-colors'
import { Check } from 'lucide-react'

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
  const previewColors = getTagColors(selectedColor)

  return (
    <div className="p-3">
      {/* Header */}
      <div className="mb-3 text-sm font-medium text-stone-700">
        Create tag: &ldquo;{tagName}&rdquo;
      </div>

      {/* Divider */}
      <div className="mb-3 border-t border-stone-200" />

      {/* Color label */}
      <div className="mb-2 text-xs font-medium text-stone-500">Choose color:</div>

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
                  aria-label={`Select ${colorName} color`}
                  aria-pressed={isSelected}
                  className={cn(
                    'flex h-6 w-6 items-center justify-center rounded-full',
                    'transition-all duration-150',
                    'hover:scale-110',
                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
                    isSelected && 'ring-2 ring-stone-400 ring-offset-1'
                  )}
                  style={{ backgroundColor: colors.background }}
                >
                  {isSelected && <Check className="h-3 w-3" style={{ color: colors.text }} />}
                </button>
              )
            })}
          </div>
        ))}
      </div>

      {/* Preview */}
      <div className="mb-4">
        <div className="mb-1 text-xs font-medium text-stone-500">Preview:</div>
        <span
          className="inline-flex items-center rounded-full px-3 py-1 text-[13px] font-medium"
          style={{
            backgroundColor: previewColors.background,
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
            'rounded-lg px-3 py-1.5',
            'text-sm text-stone-600',
            'transition-colors duration-150',
            'hover:bg-stone-100'
          )}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className={cn(
            'rounded-lg px-3 py-1.5',
            'text-sm font-medium text-white',
            'bg-stone-900',
            'transition-colors duration-150',
            'hover:bg-stone-800'
          )}
        >
          Create
        </button>
      </div>
    </div>
  )
}
