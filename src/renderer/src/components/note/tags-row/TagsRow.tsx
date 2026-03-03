import { useState, useCallback, memo } from 'react'
import { cn } from '@/lib/utils'
import { TagChip, Tag } from './TagChip'
import { AddTagButton } from './AddTagButton'
import { TagInputPopup } from './TagInputPopup'

export interface TagsRowProps {
  tags: Tag[]
  availableTags: Tag[]
  recentTags: Tag[]
  onAddTag: (tagId: string) => void
  onCreateTag: (name: string, color: string) => void
  onRemoveTag: (tagId: string) => void
  disabled?: boolean
  className?: string
}

export const TagsRow = memo(function TagsRow({
  tags,
  availableTags,
  recentTags,
  onAddTag,
  onCreateTag,
  onRemoveTag,
  disabled = false,
  className
}: TagsRowProps) {
  const [isPopupOpen, setIsPopupOpen] = useState(false)

  const handleOpenPopup = useCallback(() => {
    if (!disabled) {
      setIsPopupOpen(true)
    }
  }, [disabled])

  const handleClosePopup = useCallback(() => {
    setIsPopupOpen(false)
  }, [])

  const currentTagIds = tags.map((t) => t.id)

  return (
    <div
      role="list"
      aria-label="Tags"
      className={cn('relative flex min-h-8 flex-wrap items-center gap-2', className || 'mb-4')}
    >
      {/* Tag chips */}
      {tags.map((tag) => (
        <TagChip
          key={tag.id}
          tag={tag}
          onRemove={disabled ? undefined : onRemoveTag}
          disabled={disabled}
        />
      ))}

      {/* Add button with popup */}
      <div className="relative">
        <AddTagButton onClick={handleOpenPopup} disabled={disabled} />

        <TagInputPopup
          isOpen={isPopupOpen}
          onClose={handleClosePopup}
          availableTags={availableTags}
          recentTags={recentTags}
          currentTagIds={currentTagIds}
          onAddTag={onAddTag}
          onCreateTag={onCreateTag}
        />
      </div>

      {/* Empty state helper text */}
      {tags.length === 0 && <span className="text-[13px] text-stone-400">Add tags</span>}
    </div>
  )
})
