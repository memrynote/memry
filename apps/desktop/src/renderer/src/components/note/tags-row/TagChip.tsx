import { useState } from 'react'
import { X, Check } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { getTagColors, withAlpha } from './tag-colors'

export interface Tag {
  id: string
  name: string
  color: string
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
  const [isHovered, setIsHovered] = useState(false)
  const colors = getTagColors(tag.color)
  const isClickable = !!onClick && !isSelected

  const pillClasses = cn(
    '[font-synthesis:none] relative inline-flex items-center gap-1',
    'rounded-[10px] px-2 py-0.5',
    'text-[11px]/3.5 font-medium',
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
          aria-label={`Remove tag: ${tag.name}`}
          className={cn(
            'absolute -right-1 -top-1',
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
    <span
      role="listitem"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className={pillClasses}
      style={pillStyle}
    >
      {content}
    </span>
  )
}
