import { memo } from 'react'
import { cn } from '@/lib/utils'
import type { Tag } from './TagChip'
import { TagChip } from './TagChip'
import { AddTagButton } from './AddTagButton'
import { TagInputPopup, type TagFieldHints } from './TagInputPopup'
import { useT } from '@memry/i18n/renderer'

export interface TagsRowProps {
  tags: Tag[]
  availableTags: Tag[]
  recentTags: Tag[]
  onAddTag: (tagId: string) => void
  onCreateTag: (name: string, color: string) => void
  onRemoveTag: (tagId: string) => void
  onTagClick?: (tag: Tag) => void
  disabled?: boolean
  className?: string
  hideWhenEmpty?: boolean
  hideAddButton?: boolean
  fieldHints?: TagFieldHints
  noteId?: string
}

export const TagsRow = memo(function TagsRow({
  tags,
  availableTags,
  recentTags,
  onAddTag,
  onCreateTag,
  onRemoveTag,
  onTagClick,
  disabled = false,
  className,
  hideWhenEmpty = false,
  hideAddButton = false,
  fieldHints,
  noteId
}: TagsRowProps) {
  const { t } = useT('notes')
  const currentTagIds = tags.map((tag) => tag.id)

  if (hideWhenEmpty && tags.length === 0) return null

  return (
    <div
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- ARIA widget pattern; native tag would change styling or behavior
      role="list"
      aria-label={t('tagsRow.aria')}
      className={cn('flex min-h-8 flex-wrap items-center gap-2', className)}
    >
      {tags.map((tag) => (
        <TagChip
          key={tag.id}
          tag={tag}
          onRemove={disabled ? undefined : onRemoveTag}
          onClick={onTagClick ? () => onTagClick(tag) : undefined}
          disabled={disabled}
        />
      ))}

      {!hideAddButton && (
        <TagInputPopup
          availableTags={availableTags}
          recentTags={recentTags}
          currentTagIds={currentTagIds}
          onAddTag={onAddTag}
          onCreateTag={onCreateTag}
          disabled={disabled}
          fieldHints={fieldHints}
          noteId={noteId}
        >
          <AddTagButton disabled={disabled} />
        </TagInputPopup>
      )}

      {tags.length === 0 && !hideWhenEmpty && (
        <span className="text-[13px] text-stone-400">{t('tagsRow.empty')}</span>
      )}
    </div>
  )
})
