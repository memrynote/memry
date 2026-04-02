import { useState, memo } from 'react'
import { Plus } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { TagInputPopup } from './tags-row/TagInputPopup'
import { AddPropertyPopup } from './info-section/AddPropertyPopup'
import type { Tag } from './tags-row/TagChip'
import type { NewProperty } from './info-section/types'

export interface GhostAffordanceRowProps {
  availableTags: Tag[]
  recentTags: Tag[]
  currentTagIds: string[]
  onAddTag: (tagId: string) => void
  onCreateTag: (name: string, color: string) => void
  onAddProperty: (property: NewProperty) => void
  hasTags?: boolean
  disabled?: boolean
}

export const GhostAffordanceRow = memo(function GhostAffordanceRow({
  availableTags,
  recentTags,
  currentTagIds,
  onAddTag,
  onCreateTag,
  onAddProperty,
  hasTags = false,
  disabled = false
}: GhostAffordanceRowProps) {
  const [isTagPopupOpen, setIsTagPopupOpen] = useState(false)
  const [isPropertyPopupOpen, setIsPropertyPopupOpen] = useState(false)

  const isAnyPopupOpen = isTagPopupOpen || isPropertyPopupOpen

  return (
    <div
      className={cn(
        'flex items-center gap-3',
        'transition-opacity duration-200',
        isAnyPopupOpen
          ? 'opacity-100 pointer-events-auto'
          : [
              'opacity-0 pointer-events-none',
              'group-hover/metadata:opacity-100 group-hover/metadata:pointer-events-auto',
              'group-focus-within/metadata:opacity-100 group-focus-within/metadata:pointer-events-auto'
            ]
      )}
    >
      <AddPropertyPopup
        onAdd={onAddProperty}
        open={isPropertyPopupOpen}
        onOpenChange={setIsPropertyPopupOpen}
        disabled={disabled}
      >
        <button
          type="button"
          disabled={disabled}
          className={cn(
            'flex items-center gap-1.5',
            'rounded-md px-2 py-1',
            'border border-dashed border-border',
            'text-[12px] text-text-tertiary',
            'transition-colors duration-150',
            'hover:border-muted-foreground hover:text-muted-foreground',
            'disabled:pointer-events-none disabled:opacity-50'
          )}
        >
          <Plus className="h-3 w-3" strokeWidth={2} />
          Add property
        </button>
      </AddPropertyPopup>

      {!hasTags && (
        <TagInputPopup
          availableTags={availableTags}
          recentTags={recentTags}
          currentTagIds={currentTagIds}
          onAddTag={onAddTag}
          onCreateTag={onCreateTag}
          open={isTagPopupOpen}
          onOpenChange={setIsTagPopupOpen}
          disabled={disabled}
        >
          <button
            type="button"
            disabled={disabled}
            className={cn(
              'flex items-center gap-1.5',
              'rounded-md px-2 py-1',
              'border border-dashed border-border',
              'text-[12px] text-text-tertiary',
              'transition-colors duration-150',
              'hover:border-muted-foreground hover:text-muted-foreground',
              'disabled:pointer-events-none disabled:opacity-50'
            )}
          >
            <Plus className="h-3 w-3" strokeWidth={2} />
            Add tag
          </button>
        </TagInputPopup>
      )}
    </div>
  )
})
