import { useState } from 'react'
import { X, Check } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { NoteIconDisplay } from '@/lib/render-note-icon'
import { getTagColors, withAlpha } from './tag-colors'
import { useT } from '@memry/i18n/renderer'

export interface Tag {
  id: string
  name: string
  color: string
  /** Optional per-tag icon (raw emoji "📚" or "icon:Name") from its definition. */
  icon?: string | null
}

interface TagChipProps {
  tag: Tag
  onRemove?: (tagId: string) => void
  onClick?: () => void
  isSelected?: boolean
  isFocused?: boolean
  disabled?: boolean
}

export function TagChip({ tag, onRemove, onClick, isSelected, isFocused, disabled }: TagChipProps) {
  const { t } = useT('notes')
  const [isHovered, setIsHovered] = useState(false)
  const colors = getTagColors(tag.color, tag.name)
  const isClickable = !!onClick && !isSelected

  const pillClasses = cn(
    '[font-synthesis:none] relative inline-flex items-center gap-1',
    'rounded-full px-2.5 py-1',
    'text-[12px]/4 font-medium',
    'shrink-0 select-none',
    'transition-colors transition-opacity duration-150',
    isClickable ? 'cursor-pointer hover:opacity-80' : 'cursor-default',
    (disabled || isSelected) && 'opacity-50',
    isFocused && !isSelected && 'ring-2 ring-offset-1 ring-offset-popover'
  )

  const pillStyle = {
    backgroundColor: withAlpha(colors.text, 0.12),
    color: colors.text,
    ...(isFocused && !isSelected ? ({ '--tw-ring-color': colors.text } as React.CSSProperties) : {})
  }

  const handleRemove = (e: React.MouseEvent) => {
    e.stopPropagation()
    onRemove?.(tag.id)
  }

  const content = (
    <>
      {tag.icon && (
        <NoteIconDisplay value={tag.icon} className="size-3.5 shrink-0 text-[14px] leading-none" />
      )}
      <span>{tag.name}</span>
      {isSelected && <Check className="h-3 w-3" />}
      {onRemove && !disabled && isHovered && (
        <span
          role="button"
          tabIndex={0}
          onClick={handleRemove}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              handleRemove(e as unknown as React.MouseEvent)
            }
          }}
          aria-label={t('tagsRow.removeAria', { tag: tag.name })}
          className={cn(
            'absolute -end-1 -top-1',
            'flex h-3.5 w-3.5 items-center justify-center',
            'rounded-full bg-stone-500 text-white',
            'shadow-sm',
            'transition-all duration-100',
            'hover:bg-stone-600 hover:scale-110'
          )}
        >
          <X className="h-2 w-2" strokeWidth={3} />
        </span>
      )}
    </>
  )

  if (onClick) {
    return (
      <button
        type="button"
        role="option"
        aria-selected={isSelected}
        onClick={onClick}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        disabled={isSelected || disabled}
        className={pillClasses}
        style={pillStyle}
      >
        {content}
      </button>
    )
  }

  return (
    <li
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className={pillClasses}
      style={pillStyle}
    >
      {content}
    </li>
  )
}
