import { useState, useRef, useCallback, useMemo, useEffect } from 'react'
import { Search, Check } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { useClickOutside } from '../note-title/use-click-outside'
import { Tag } from './TagChip'
import { getTagColors, getRandomColor } from './tag-colors'
import { ScrollArea } from '@/components/ui/scroll-area'

interface TagInputPopupProps {
  isOpen: boolean
  onClose: () => void
  availableTags: Tag[]
  recentTags: Tag[]
  currentTagIds: string[]
  onAddTag: (tagId: string) => void
  onCreateTag: (name: string, color: string) => void
}

export function TagInputPopup({
  isOpen,
  onClose,
  availableTags,
  recentTags,
  currentTagIds,
  onAddTag,
  onCreateTag
}: TagInputPopupProps) {
  const popupRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [newTagColor, setNewTagColor] = useState(getRandomColor())
  const [focusedIndex, setFocusedIndex] = useState(-1)

  useClickOutside(popupRef, onClose, isOpen)

  // Focus input when popup opens
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus()
    }
  }, [isOpen])

  // Reset state when popup closes
  useEffect(() => {
    if (!isOpen) {
      setSearchQuery('')
      setNewTagColor(getRandomColor())
      setFocusedIndex(-1)
    }
  }, [isOpen])

  // Filter tags based on search
  const filteredTags = useMemo(() => {
    if (!searchQuery.trim()) return availableTags
    const query = searchQuery.toLowerCase()
    return availableTags.filter((tag) => tag.name.toLowerCase().includes(query))
  }, [availableTags, searchQuery])

  // Check if exact match exists
  const exactMatchExists = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    return availableTags.some((tag) => tag.name.toLowerCase() === query)
  }, [availableTags, searchQuery])

  // Filter recent tags (exclude already added)
  const filteredRecentTags = useMemo(() => {
    return recentTags.filter((tag) => !currentTagIds.includes(tag.id))
  }, [recentTags, currentTagIds])

  const visibleTags = filteredTags

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setFocusedIndex((prev) => (prev < visibleTags.length - 1 ? prev + 1 : 0))
        return
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setFocusedIndex((prev) => (prev > 0 ? prev - 1 : visibleTags.length - 1))
        return
      }

      if (e.key === 'Enter') {
        e.preventDefault()
        if (focusedIndex >= 0 && focusedIndex < visibleTags.length) {
          const tag = visibleTags[focusedIndex]
          if (!currentTagIds.includes(tag.id)) {
            onAddTag(tag.id)
            onClose()
          }
          return
        }
        const trimmedQuery = searchQuery.trim()
        if (trimmedQuery) {
          if (!exactMatchExists) {
            onCreateTag(trimmedQuery, newTagColor)
            onClose()
          } else if (filteredTags.length > 0) {
            const firstTag = filteredTags[0]
            if (!currentTagIds.includes(firstTag.id)) {
              onAddTag(firstTag.id)
              onClose()
            }
          }
        }
      }
    },
    [
      onClose,
      searchQuery,
      exactMatchExists,
      newTagColor,
      onCreateTag,
      filteredTags,
      currentTagIds,
      onAddTag,
      focusedIndex,
      visibleTags
    ]
  )

  const handleTagClick = useCallback(
    (tag: Tag) => {
      if (!currentTagIds.includes(tag.id)) {
        onAddTag(tag.id)
        onClose()
      }
    },
    [currentTagIds, onAddTag, onClose]
  )

  if (!isOpen) return null

  return (
    <div
      ref={popupRef}
      role="dialog"
      aria-modal="true"
      aria-label="Add tag"
      onKeyDown={handleKeyDown}
      className={cn(
        'absolute left-0 top-full z-50 mt-2',
        'w-[280px] overflow-hidden',
        'rounded-xl border border-stone-200 bg-white',
        'shadow-lg',
        'animate-in fade-in-0 zoom-in-95 duration-150'
      )}
    >
      {/* Search input */}
      <div className="border-b border-stone-200 p-2">
        <div className="flex items-center gap-2 rounded-md bg-stone-50 px-3 py-2">
          <Search className="h-4 w-4 text-stone-400" />
          <input
            ref={inputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value)
              setFocusedIndex(-1)
            }}
            placeholder="Type tag name..."
            role="combobox"
            aria-label="Search or create tag"
            aria-expanded={filteredTags.length > 0}
            aria-haspopup="listbox"
            aria-autocomplete="list"
            aria-controls="tag-input-popup-listbox"
            aria-activedescendant={
              focusedIndex >= 0 ? `tag-input-option-${focusedIndex}` : undefined
            }
            className={cn(
              'flex-1 bg-transparent text-sm',
              'placeholder:text-stone-400',
              'outline-none'
            )}
          />
        </div>
      </div>

      <ScrollArea className="max-h-[260px]">
        <div className="p-2">
          {/* Recent tags */}
          {filteredRecentTags.length > 0 && !searchQuery && (
            <div className="mb-3">
              <div className="mb-1.5 px-1 text-xs font-medium uppercase text-stone-400">Recent</div>
              <div className="flex flex-wrap gap-1.5">
                {filteredRecentTags.slice(0, 8).map((tag) => (
                  <TagOption
                    key={tag.id}
                    tag={tag}
                    isSelected={currentTagIds.includes(tag.id)}
                    onClick={() => handleTagClick(tag)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* All/Filtered tags */}
          {filteredTags.length > 0 && (
            <div className="mb-2">
              <div className="mb-1.5 px-1 text-xs font-medium uppercase text-stone-400">
                {searchQuery ? 'Matching' : 'All Tags'}
              </div>
              <div className="flex flex-wrap gap-1.5" role="listbox" aria-label="Available tags">
                {filteredTags.map((tag, index) => (
                  <TagOption
                    key={tag.id}
                    tag={tag}
                    isSelected={currentTagIds.includes(tag.id)}
                    isFocused={index === focusedIndex}
                    onClick={() => handleTagClick(tag)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Empty state */}
          {filteredTags.length === 0 && searchQuery && (
            <div className="py-4 text-center text-sm text-stone-400">No tags found</div>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

interface TagOptionProps {
  tag: Tag
  isSelected: boolean
  isFocused?: boolean
  onClick: () => void
}

function TagOption({ tag, isSelected, isFocused = false, onClick }: TagOptionProps) {
  const colors = getTagColors(tag.color)

  return (
    <button
      type="button"
      role="option"
      aria-selected={isSelected}
      onClick={onClick}
      disabled={isSelected}
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2.5 py-1',
        'text-xs font-medium',
        'transition-all duration-150',
        'focus-visible:outline-none',
        isSelected ? 'opacity-50 cursor-default' : 'hover:opacity-80 cursor-pointer',
        isFocused && !isSelected && 'ring-2 ring-offset-1 opacity-100'
      )}
      style={{
        backgroundColor: colors.background,
        color: colors.text,
        ...(isFocused && !isSelected ? { ringColor: colors.text } : {})
      }}
    >
      {tag.name}
      {isSelected && <Check className="h-3 w-3" />}
    </button>
  )
}
