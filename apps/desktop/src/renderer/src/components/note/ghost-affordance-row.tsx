import { useState, memo } from 'react'
import { Image, List, Tag } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { TagInputPopup } from './tags-row/TagInputPopup'
import { AddPropertyPopup } from './info-section/AddPropertyPopup'
import type { Tag as TagEntity } from './tags-row/TagChip'
import type { NewProperty, PropertyType } from './info-section/types'
import { useT } from '@memry/i18n/renderer'

export interface GhostAffordanceRowProps {
  availableTags: TagEntity[]
  recentTags: TagEntity[]
  currentTagIds: string[]
  onAddTag: (tagId: string) => void
  onCreateTag: (name: string, color: string) => void
  onAddProperty: (property: NewProperty) => void
  onAddCover?: () => void
  /** Property types this surface cannot store; hidden from the picker rather than degraded on save. */
  excludeTypes?: PropertyType[]
  /** Property names already on the entity — a second `project` is shown but disabled. */
  existingNames?: string[]
  disabled?: boolean
  className?: string
}

const CHIP_CLASS = cn(
  'flex h-[26px] items-center gap-1.5',
  'rounded-md px-2',
  'bg-muted/60 text-muted-foreground',
  'text-[12.5px] font-medium',
  'transition-colors duration-150 motion-reduce:transition-none',
  'hover:bg-muted hover:text-foreground',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
  'disabled:pointer-events-none disabled:opacity-50'
)

const CHIP_ICON_CLASS = 'h-3.5 w-3.5 shrink-0'

export const GhostAffordanceRow = memo(function GhostAffordanceRow({
  availableTags,
  recentTags,
  currentTagIds,
  onAddTag,
  onCreateTag,
  onAddProperty,
  onAddCover,
  excludeTypes,
  existingNames,
  disabled = false,
  className
}: GhostAffordanceRowProps) {
  const { t } = useT('notes')
  const [isTagPopupOpen, setIsTagPopupOpen] = useState(false)
  const [isPropertyPopupOpen, setIsPropertyPopupOpen] = useState(false)

  const isAnyPopupOpen = isTagPopupOpen || isPropertyPopupOpen

  return (
    <div
      className={cn(
        'flex items-center gap-2',
        'transition-opacity duration-200',
        isAnyPopupOpen
          ? 'opacity-100 pointer-events-auto'
          : [
              'opacity-0 pointer-events-none',
              'group-hover/metadata:opacity-100 group-hover/metadata:pointer-events-auto',
              'group-focus-within/metadata:opacity-100 group-focus-within/metadata:pointer-events-auto'
            ],
        className
      )}
    >
      {onAddCover && (
        <button
          type="button"
          disabled={disabled}
          onClick={onAddCover}
          className={CHIP_CLASS}
          data-testid="ghost-add-cover"
        >
          <Image className={CHIP_ICON_CLASS} strokeWidth={2} />
          {t('cover.add')}
        </button>
      )}

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
        <button type="button" disabled={disabled} className={CHIP_CLASS}>
          <Tag className={CHIP_ICON_CLASS} strokeWidth={2} />
          {t('tagsRow.add')}
        </button>
      </TagInputPopup>

      <AddPropertyPopup
        onAdd={onAddProperty}
        open={isPropertyPopupOpen}
        onOpenChange={setIsPropertyPopupOpen}
        excludeTypes={excludeTypes}
        disabled={disabled}
        existingNames={existingNames}
      >
        <button type="button" disabled={disabled} className={CHIP_CLASS}>
          <List className={CHIP_ICON_CLASS} strokeWidth={2} />
          {t('properties.add')}
        </button>
      </AddPropertyPopup>
    </div>
  )
})
