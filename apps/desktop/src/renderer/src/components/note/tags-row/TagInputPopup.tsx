import { useState, useRef, useCallback, useMemo } from 'react'
import { Search } from '@/lib/icons'
import { Picker } from '@/components/ui/picker'
import { ScrollArea } from '@/components/ui/scroll-area'
import { TagChip, Tag } from './TagChip'
import { getRandomColor } from './tag-colors'

interface TagInputPopupProps {
  availableTags: Tag[]
  recentTags: Tag[]
  currentTagIds: string[]
  onAddTag: (tagId: string) => void
  onCreateTag: (name: string, color: string) => void
  open?: boolean
  onOpenChange?: (open: boolean) => void
  disabled?: boolean
  children: React.ReactNode
}

export function TagInputPopup({
  availableTags,
  recentTags,
  currentTagIds,
  onAddTag,
  onCreateTag,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  disabled = false,
  children
}: TagInputPopupProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [newTagColor, setNewTagColor] = useState(getRandomColor())
  const [focusedIndex, setFocusedIndex] = useState(-1)
  const [internalOpen, setInternalOpen] = useState(false)
  const open = controlledOpen ?? internalOpen

  const handleOpenChange = useCallback((next: boolean) => {
    if (controlledOpen === undefined) setInternalOpen(next)
    controlledOnOpenChange?.(next)
    if (!next) {
      setSearchQuery('')
      setNewTagColor(getRandomColor())
      setFocusedIndex(-1)
    }
  }, [])

  const filteredTags = useMemo(() => {
    if (!searchQuery.trim()) return availableTags
    const query = searchQuery.toLowerCase()
    return availableTags.filter((tag) => tag.name.toLowerCase().includes(query))
  }, [availableTags, searchQuery])

  const exactMatchExists = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    return availableTags.some((tag) => tag.name.toLowerCase() === query)
  }, [availableTags, searchQuery])

  const filteredRecentTags = useMemo(
    () => recentTags.filter((tag) => !currentTagIds.includes(tag.id)),
    [recentTags, currentTagIds]
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setFocusedIndex((prev) => (prev < filteredTags.length - 1 ? prev + 1 : 0))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setFocusedIndex((prev) => (prev > 0 ? prev - 1 : filteredTags.length - 1))
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        if (focusedIndex >= 0 && focusedIndex < filteredTags.length) {
          const tag = filteredTags[focusedIndex]
          if (!currentTagIds.includes(tag.id)) {
            onAddTag(tag.id)
            handleOpenChange(false)
          }
          return
        }
        const trimmed = searchQuery.trim()
        if (trimmed) {
          if (!exactMatchExists) {
            onCreateTag(trimmed, newTagColor)
            handleOpenChange(false)
          } else if (filteredTags.length > 0) {
            const firstTag = filteredTags[0]
            if (!currentTagIds.includes(firstTag.id)) {
              onAddTag(firstTag.id)
              handleOpenChange(false)
            }
          }
        }
      }
    },
    [
      searchQuery,
      exactMatchExists,
      newTagColor,
      onCreateTag,
      filteredTags,
      currentTagIds,
      onAddTag,
      focusedIndex,
      handleOpenChange
    ]
  )

  const handleTagClick = useCallback(
    (tag: Tag) => {
      if (!currentTagIds.includes(tag.id)) {
        onAddTag(tag.id)
        handleOpenChange(false)
      }
    },
    [currentTagIds, onAddTag, handleOpenChange]
  )

  return (
    <Picker open={open} onOpenChange={handleOpenChange} closeOnSelect={false}>
      <Picker.Trigger asChild disabled={disabled}>
        {children}
      </Picker.Trigger>
      <Picker.Content width={280} align="start" sideOffset={8} onKeyDown={handleKeyDown}>
        <div className="border-b border-border p-2">
          <div className="flex items-center gap-2 rounded-md bg-muted px-3 py-2">
            <Search className="h-4 w-4 text-muted-foreground" />
            <input
              ref={inputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value)
                setFocusedIndex(-1)
              }}
              onClick={(e) => e.stopPropagation()}
              placeholder="Type tag name..."
              aria-label="Search or create tag"
              className="flex-1 bg-transparent text-sm text-popover-foreground placeholder:text-muted-foreground outline-none"
            />
          </div>
        </div>

        <ScrollArea className="max-h-[260px]">
          <div className="p-2">
            {filteredRecentTags.length > 0 && !searchQuery && (
              <div className="mb-3">
                <div className="mb-1.5 px-1 text-xs font-medium uppercase text-muted-foreground">
                  Recent
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {filteredRecentTags.slice(0, 8).map((tag) => (
                    <TagChip
                      key={tag.id}
                      tag={tag}
                      isSelected={currentTagIds.includes(tag.id)}
                      onClick={() => handleTagClick(tag)}
                    />
                  ))}
                </div>
              </div>
            )}

            {filteredTags.length > 0 && (
              <div className="mb-2">
                <div className="mb-1.5 px-1 text-xs font-medium uppercase text-muted-foreground">
                  {searchQuery ? 'Matching' : 'All Tags'}
                </div>
                <div className="flex flex-wrap gap-1.5" role="listbox" aria-label="Available tags">
                  {filteredTags.map((tag, index) => (
                    <TagChip
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

            {filteredTags.length === 0 && searchQuery && (
              <div className="py-4 text-center text-sm text-muted-foreground">No tags found</div>
            )}
          </div>
        </ScrollArea>
      </Picker.Content>
    </Picker>
  )
}
