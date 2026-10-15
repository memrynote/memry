import { useRef, useState, memo } from 'react'
import { Image, List, Plus, Tag, Type } from '@/lib/icons'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { TagInputPopup, type TagFieldHints } from './tags-row/TagInputPopup'
import { AddPropertyPopup } from './info-section/AddPropertyPopup'
import type { Tag as TagEntity } from './tags-row/TagChip'
import type { NewProperty, PropertyType } from './info-section/types'
import type { CoverPickerAnchor } from './cover-picker-dialog'
import { useT } from '@memry/i18n/renderer'

export interface GhostAffordanceRowProps {
  availableTags: TagEntity[]
  recentTags: TagEntity[]
  currentTagIds: string[]
  onAddTag: (tagId: string) => void
  onCreateTag: (name: string, color: string) => void
  onAddProperty: (property: NewProperty) => void
  onAddCover?: (anchor: CoverPickerAnchor) => void
  onAddName?: () => void
  /** Hide the tag entry, for surfaces whose tags row already carries its own add button. */
  hideAddTag?: boolean
  /** Property types this surface cannot store; hidden from the picker rather than degraded on save. */
  excludeTypes?: PropertyType[]
  /** Property names already on the entity — a second `project` is shown but disabled. */
  existingNames?: string[]
  disabled?: boolean
  className?: string
  tagFieldHints?: TagFieldHints
}

const ICON_CLASS = 'h-3.5 w-3.5 shrink-0'

/** The popups open from the menu, so they anchor to an invisible point under the trigger. */
const POPUP_ANCHOR = <span aria-hidden className="pointer-events-none absolute bottom-0 start-0" />

export const GhostAffordanceRow = memo(function GhostAffordanceRow({
  availableTags,
  recentTags,
  currentTagIds,
  onAddTag,
  onCreateTag,
  onAddProperty,
  onAddCover,
  onAddName,
  hideAddTag = false,
  excludeTypes,
  existingNames,
  disabled = false,
  className,
  tagFieldHints
}: GhostAffordanceRowProps) {
  const { t } = useT('notes')
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const [isTagPopupOpen, setIsTagPopupOpen] = useState(false)
  const [isPropertyPopupOpen, setIsPropertyPopupOpen] = useState(false)
  // A popup opened from the menu keeps focus; the menu must not pull it back on close.
  const popupPendingRef = useRef(false)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const isAnyOpen = isMenuOpen || isTagPopupOpen || isPropertyPopupOpen

  const openPopup = (open: (value: boolean) => void) => () => {
    popupPendingRef.current = true
    open(true)
  }

  return (
    <div
      className={cn(
        'relative flex items-center',
        'transition-opacity duration-200',
        isAnyOpen
          ? 'opacity-100 pointer-events-auto'
          : [
              'opacity-0 pointer-events-none',
              'group-hover/metadata:opacity-100 group-hover/metadata:pointer-events-auto',
              'group-focus-within/metadata:opacity-100 group-focus-within/metadata:pointer-events-auto'
            ],
        className
      )}
    >
      <DropdownMenu open={isMenuOpen} onOpenChange={setIsMenuOpen}>
        <DropdownMenuTrigger asChild disabled={disabled}>
          <button
            ref={triggerRef}
            type="button"
            disabled={disabled}
            className={cn(
              'flex h-[26px] items-center gap-1.5',
              'text-[12.5px] font-medium text-[#A29F9A]',
              'transition-colors duration-150 motion-reduce:transition-none',
              'hover:text-foreground',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md',
              'disabled:pointer-events-none disabled:opacity-50'
            )}
            data-testid="ghost-add-details"
          >
            <Plus className={ICON_CLASS} strokeWidth={2} />
            {t('details.add')}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          sideOffset={6}
          onCloseAutoFocus={(event) => {
            if (!popupPendingRef.current) return
            popupPendingRef.current = false
            event.preventDefault()
          }}
        >
          {!hideAddTag && (
            <DropdownMenuItem onSelect={openPopup(setIsTagPopupOpen)}>
              <Tag className={ICON_CLASS} strokeWidth={2} />
              {t('tagsRow.add')}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={openPopup(setIsPropertyPopupOpen)}>
            <List className={ICON_CLASS} strokeWidth={2} />
            {t('properties.add')}
          </DropdownMenuItem>
          {onAddName && (
            <DropdownMenuItem onSelect={onAddName} data-testid="ghost-add-name">
              <Type className={ICON_CLASS} strokeWidth={2} />
              {t('names.add')}
            </DropdownMenuItem>
          )}
          {onAddCover && (
            <DropdownMenuItem
              onSelect={() => {
                const rect = triggerRef.current?.getBoundingClientRect()
                if (rect) onAddCover({ x: rect.left + rect.width / 2, y: rect.bottom })
              }}
              data-testid="ghost-add-cover"
            >
              <Image className={ICON_CLASS} strokeWidth={2} />
              {t('cover.add')}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <TagInputPopup
        availableTags={availableTags}
        recentTags={recentTags}
        currentTagIds={currentTagIds}
        onAddTag={onAddTag}
        onCreateTag={onCreateTag}
        open={isTagPopupOpen}
        onOpenChange={setIsTagPopupOpen}
        disabled={disabled}
        fieldHints={tagFieldHints}
      >
        {POPUP_ANCHOR}
      </TagInputPopup>

      <AddPropertyPopup
        onAdd={onAddProperty}
        open={isPropertyPopupOpen}
        onOpenChange={setIsPropertyPopupOpen}
        excludeTypes={excludeTypes}
        disabled={disabled}
        existingNames={existingNames}
      >
        {POPUP_ANCHOR}
      </AddPropertyPopup>
    </div>
  )
})
