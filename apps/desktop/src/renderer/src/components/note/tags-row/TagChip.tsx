import { useState } from 'react'
import { X } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { getTagColors } from './tag-colors'

export interface Tag {
  id: string
  name: string
  color: string
}

interface TagChipProps {
  tag: Tag
  onRemove?: (tagId: string) => void
  disabled?: boolean
}

export function TagChip({ tag, onRemove, disabled }: TagChipProps) {
  const [isHovered, setIsHovered] = useState(false)
  const colors = getTagColors(tag.color)

  const handleRemove = (e: React.MouseEvent) => {
    e.stopPropagation()
    onRemove?.(tag.id)
  }

  return (
    <span
      role="listitem"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className={cn(
        'relative inline-flex items-center',
        'rounded-full px-3 py-1',
        'text-[13px] font-medium leading-snug',
        'cursor-default select-none',
        'transition-all duration-150',
        disabled && 'opacity-50'
      )}
      style={{
        backgroundColor: colors.background,
        color: colors.text
      }}
    >
      <span>{tag.name}</span>

      {/* Remove button - positioned at top-right corner like a window close button */}
      {onRemove && !disabled && isHovered && (
        <button
          type="button"
          onClick={handleRemove}
          aria-label={`Remove tag: ${tag.name}`}
          className={cn(
            'absolute -right-1.5 -top-1.5',
            'flex h-4 w-4 items-center justify-center',
            'rounded-full bg-stone-500 text-white',
            'shadow-sm',
            'transition-all duration-100',
            'hover:bg-stone-600 hover:scale-110'
          )}
        >
          <X className="h-2.5 w-2.5" strokeWidth={2.5} />
        </button>
      )}
    </span>
  )
}
