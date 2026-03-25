import { useState, useCallback, useRef, memo } from 'react'
import { createPortal } from 'react-dom'
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
  existingPropertyNames: string[]
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
  existingPropertyNames,
  hasTags = false,
  disabled = false
}: GhostAffordanceRowProps) {
  const [isTagPopupOpen, setIsTagPopupOpen] = useState(false)
  const [isPropertyPopupOpen, setIsPropertyPopupOpen] = useState(false)
  const [propertyPopupPosition, setPropertyPopupPosition] = useState<{
    top: number
    left: number
  } | null>(null)

  const propertyButtonRef = useRef<HTMLButtonElement>(null)

  const isAnyPopupOpen = isTagPopupOpen || isPropertyPopupOpen

  const handleOpenTagPopup = useCallback(() => {
    if (!disabled) {
      setIsTagPopupOpen(true)
    }
  }, [disabled])

  const handleCloseTagPopup = useCallback(() => {
    setIsTagPopupOpen(false)
  }, [])

  const handleOpenPropertyPopup = useCallback(() => {
    if (disabled || !propertyButtonRef.current) return
    const rect = propertyButtonRef.current.getBoundingClientRect()
    setPropertyPopupPosition({ top: rect.bottom + 8, left: rect.left })
    setIsPropertyPopupOpen(true)
  }, [disabled])

  const handleClosePropertyPopup = useCallback(() => {
    setIsPropertyPopupOpen(false)
    setPropertyPopupPosition(null)
  }, [])

  return (
    <div
      className={cn(
        'flex items-center gap-3 py-1',
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
      {/* + Add property button */}
      <button
        ref={propertyButtonRef}
        type="button"
        onClick={handleOpenPropertyPopup}
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

      {/* + Add tag button — hidden when TagsRow already provides its own add button */}
      {!hasTags && (
        <div className="relative">
          <button
            type="button"
            onClick={handleOpenTagPopup}
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

          <TagInputPopup
            isOpen={isTagPopupOpen}
            onClose={handleCloseTagPopup}
            availableTags={availableTags}
            recentTags={recentTags}
            currentTagIds={currentTagIds}
            onAddTag={onAddTag}
            onCreateTag={onCreateTag}
          />
        </div>
      )}

      {/* Property popup — portal to body for z-index isolation */}
      {isPropertyPopupOpen &&
        propertyPopupPosition &&
        createPortal(
          <AddPropertyPopup
            isOpen={isPropertyPopupOpen}
            onClose={handleClosePropertyPopup}
            onAdd={onAddProperty}
            position={propertyPopupPosition}
            existingPropertyNames={existingPropertyNames}
          />,
          document.body
        )}
    </div>
  )
})
