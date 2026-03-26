import { useState, useCallback, useMemo } from 'react'
import { FilterSearchHeader } from '@/components/ui/filter-search-header'
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
    const base = searchQuery.trim()
      ? availableTags.filter((t) => t.name.toLowerCase().includes(searchQuery.toLowerCase()))
      : availableTags
    return base.filter((t) => !currentTagIds.includes(t.id))
  }, [availableTags, searchQuery, currentTagIds])

  const exactMatchExists = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    return availableTags.some((tag) => tag.name.toLowerCase() === query)
  }, [availableTags, searchQuery])

  const filteredRecentTags = useMemo(
    () => recentTags.filter((tag) => !currentTagIds.includes(tag.id)),
    [recentTags, currentTagIds]
  )

  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value)
    setFocusedIndex(-1)
  }, [])

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
          onAddTag(filteredTags[focusedIndex].id)
          handleOpenChange(false)
          return
        }
        const trimmed = searchQuery.trim()
        if (trimmed) {
          if (!exactMatchExists) {
            onCreateTag(trimmed, newTagColor)
            handleOpenChange(false)
          } else if (filteredTags.length > 0) {
            onAddTag(filteredTags[0].id)
            handleOpenChange(false)
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
      onAddTag,
      focusedIndex,
      handleOpenChange
    ]
  )

  const handleTagClick = useCallback(
    (tag: Tag) => {
      onAddTag(tag.id)
      handleOpenChange(false)
    },
    [onAddTag, handleOpenChange]
  )

  return (
    <Picker open={open} onOpenChange={handleOpenChange} closeOnSelect={false}>
      <Picker.Trigger asChild disabled={disabled}>
        {children}
      </Picker.Trigger>
      <Picker.Content width={280} align="start" sideOffset={8} onKeyDown={handleKeyDown}>
        <FilterSearchHeader
          value={searchQuery}
          onChange={handleSearchChange}
          placeholder="Type tag name..."
        />

        <ScrollArea className="max-h-[260px]">
          <Picker.List className="flex-wrap gap-1.5">
            {filteredRecentTags.length > 0 && !searchQuery && (
              <Picker.Section label="Recent">
                <div className="flex flex-wrap gap-1.5 px-2 pb-1">
                  {filteredRecentTags.slice(0, 8).map((tag) => (
                    <TagChip key={tag.id} tag={tag} onClick={() => handleTagClick(tag)} />
                  ))}
                </div>
              </Picker.Section>
            )}

            {filteredTags.length > 0 && (
              <Picker.Section label={searchQuery ? 'Matching' : 'All Tags'}>
                <div className="flex flex-wrap gap-1.5 px-2 pb-1">
                  {filteredTags.map((tag, index) => (
                    <TagChip
                      key={tag.id}
                      tag={tag}
                      isFocused={index === focusedIndex}
                      onClick={() => handleTagClick(tag)}
                    />
                  ))}
                </div>
              </Picker.Section>
            )}

            {filteredTags.length === 0 && searchQuery && <Picker.Empty message="No tags found" />}
          </Picker.List>
        </ScrollArea>
      </Picker.Content>
    </Picker>
  )
}
