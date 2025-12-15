/**
 * Tag Input Component
 *
 * A tag management input with:
 * - Tag pills with colors and remove buttons
 * - Autocomplete dropdown for existing tags
 * - Create new tags inline
 * - Keyboard navigation
 */

import { useState, useRef, useCallback, useMemo, useEffect } from 'react'
import { X, Plus, Tag as TagIcon, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import type { Tag } from '@/data/filing-types'
import { TAG_COLORS, DEFAULT_TAG_COLOR, type TagColor } from '@/data/filing-types'

// ============================================================================
// TYPES
// ============================================================================

export interface TagInputProps {
  /** All available tags */
  allTags: Tag[]
  /** Currently selected tag IDs */
  selectedTagIds: string[]
  /** Callback when tags change */
  onTagsChange: (tagIds: string[]) => void
  /** Callback to create a new tag */
  onCreateTag?: (name: string, color: TagColor) => Tag
  /** Placeholder text */
  placeholder?: string
  /** Maximum number of tags */
  maxTags?: number
  /** Additional class names */
  className?: string
}

// ============================================================================
// TAG PILL
// ============================================================================

interface TagPillProps {
  tag: Tag
  onRemove: () => void
}

function TagPill({ tag, onRemove }: TagPillProps): React.JSX.Element {
  const colors = TAG_COLORS[tag.color]

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2.5 py-1',
        'text-xs font-medium',
        'transition-all duration-150',
        colors.bg,
        colors.text,
        colors.border,
        'border'
      )}
    >
      <span className={cn('size-1.5 rounded-full', colors.dot)} />
      <span>{tag.name}</span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onRemove()
        }}
        className={cn(
          'ml-0.5 rounded-full p-0.5',
          'hover:bg-black/10 dark:hover:bg-white/10',
          'transition-colors'
        )}
        aria-label={`Remove ${tag.name} tag`}
      >
        <X className="size-3" />
      </button>
    </span>
  )
}

// ============================================================================
// AUTOCOMPLETE ITEM
// ============================================================================

interface AutocompleteItemProps {
  tag: Tag
  isSelected: boolean
  isFocused: boolean
  onSelect: () => void
  onFocus: () => void
}

function AutocompleteItem({
  tag,
  isSelected,
  isFocused,
  onSelect,
  onFocus,
}: AutocompleteItemProps): React.JSX.Element {
  const colors = TAG_COLORS[tag.color]

  return (
    <button
      type="button"
      onClick={onSelect}
      onMouseEnter={onFocus}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5',
        'text-left text-sm',
        'transition-colors duration-100',
        isFocused && 'bg-accent',
        isSelected && 'opacity-50'
      )}
    >
      <span className={cn('size-2 rounded-full', colors.dot)} />
      <span className="flex-1">{tag.name}</span>
      {isSelected && <Check className="size-3.5 text-muted-foreground" />}
      <span className="text-xs text-muted-foreground tabular-nums">
        {tag.usageCount}
      </span>
    </button>
  )
}

// ============================================================================
// CREATE TAG ITEM
// ============================================================================

interface CreateTagItemProps {
  name: string
  isFocused: boolean
  onSelect: () => void
  onFocus: () => void
}

function CreateTagItem({
  name,
  isFocused,
  onSelect,
  onFocus,
}: CreateTagItemProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onSelect}
      onMouseEnter={onFocus}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5',
        'text-left text-sm',
        'transition-colors duration-100',
        isFocused && 'bg-accent'
      )}
    >
      <Plus className="size-4 text-primary" />
      <span>
        Create "<span className="font-medium">{name}</span>"
      </span>
    </button>
  )
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export function TagInput({
  allTags,
  selectedTagIds,
  onTagsChange,
  onCreateTag,
  placeholder = 'Add tag...',
  maxTags = 10,
  className,
}: TagInputProps): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false)
  const [inputValue, setInputValue] = useState('')
  const [focusedIndex, setFocusedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Get selected tags as objects
  const selectedTags = useMemo(() => {
    return selectedTagIds
      .map((id) => allTags.find((t) => t.id === id))
      .filter(Boolean) as Tag[]
  }, [selectedTagIds, allTags])

  // Filter available tags
  const filteredTags = useMemo(() => {
    const query = inputValue.toLowerCase().trim()
    return allTags.filter((tag) => {
      const matchesQuery = !query || tag.name.toLowerCase().includes(query)
      return matchesQuery
    })
  }, [allTags, inputValue])

  // Check if we can create a new tag
  const canCreateNew = useMemo(() => {
    if (!inputValue.trim()) return false
    if (!onCreateTag) return false
    const normalized = inputValue.toLowerCase().trim()
    return !allTags.some((t) => t.name.toLowerCase() === normalized)
  }, [inputValue, allTags, onCreateTag])

  // Total items in dropdown
  const dropdownItems = filteredTags.length + (canCreateNew ? 1 : 0)

  // Add tag
  const addTag = useCallback(
    (tagId: string) => {
      if (selectedTagIds.includes(tagId)) {
        // Already selected - remove it
        onTagsChange(selectedTagIds.filter((id) => id !== tagId))
      } else if (selectedTagIds.length < maxTags) {
        onTagsChange([...selectedTagIds, tagId])
      }
      setInputValue('')
      setFocusedIndex(0)
    },
    [selectedTagIds, onTagsChange, maxTags]
  )

  // Remove tag
  const removeTag = useCallback(
    (tagId: string) => {
      onTagsChange(selectedTagIds.filter((id) => id !== tagId))
    },
    [selectedTagIds, onTagsChange]
  )

  // Create and add new tag
  const createAndAddTag = useCallback(() => {
    if (!onCreateTag || !inputValue.trim()) return

    const newTag = onCreateTag(inputValue.trim(), DEFAULT_TAG_COLOR)
    addTag(newTag.id)
    setIsOpen(false)
  }, [inputValue, onCreateTag, addTag])

  // Handle selection from dropdown
  const handleSelect = useCallback(
    (index: number) => {
      if (index < filteredTags.length) {
        addTag(filteredTags[index].id)
      } else if (canCreateNew) {
        createAndAddTag()
      }
    },
    [filteredTags, addTag, canCreateNew, createAndAddTag]
  )

  // Handle keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setFocusedIndex((prev) => Math.min(prev + 1, dropdownItems - 1))
          break
        case 'ArrowUp':
          e.preventDefault()
          setFocusedIndex((prev) => Math.max(prev - 1, 0))
          break
        case 'Enter':
          e.preventDefault()
          if (isOpen && dropdownItems > 0) {
            handleSelect(focusedIndex)
          } else {
            setIsOpen(true)
          }
          break
        case 'Escape':
          e.preventDefault()
          setIsOpen(false)
          setInputValue('')
          break
        case 'Backspace':
          if (!inputValue && selectedTagIds.length > 0) {
            removeTag(selectedTagIds[selectedTagIds.length - 1])
          }
          break
      }
    },
    [isOpen, dropdownItems, focusedIndex, handleSelect, inputValue, selectedTagIds, removeTag]
  )

  // Reset focused index when filtered results change
  useEffect(() => {
    setFocusedIndex(0)
  }, [filteredTags.length, canCreateNew])

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const atMaxTags = selectedTagIds.length >= maxTags

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      {/* Selected tags and input */}
      <div
        className={cn(
          'flex flex-wrap items-center gap-1.5 rounded-lg p-2',
          'border bg-background/50',
          'focus-within:ring-2 focus-within:ring-ring/50',
          'transition-all duration-150'
        )}
        onClick={() => inputRef.current?.focus()}
      >
        {/* Tag pills */}
        {selectedTags.map((tag) => (
          <TagPill key={tag.id} tag={tag} onRemove={() => removeTag(tag.id)} />
        ))}

        {/* Input field */}
        {!atMaxTags && (
          <div className="relative flex-1 min-w-[120px]">
            <Input
              ref={inputRef}
              type="text"
              value={inputValue}
              onChange={(e) => {
                setInputValue(e.target.value)
                setIsOpen(true)
              }}
              onFocus={() => setIsOpen(true)}
              onKeyDown={handleKeyDown}
              placeholder={selectedTags.length === 0 ? placeholder : ''}
              className={cn(
                'h-7 border-0 bg-transparent px-1 py-0',
                'focus-visible:ring-0 focus-visible:ring-offset-0',
                'placeholder:text-muted-foreground/60'
              )}
            />
          </div>
        )}

        {/* Add button when no input */}
        {selectedTags.length === 0 && !inputValue && (
          <button
            type="button"
            onClick={() => {
              setIsOpen(true)
              inputRef.current?.focus()
            }}
            className={cn(
              'inline-flex items-center gap-1 rounded-full px-2 py-0.5',
              'text-xs text-muted-foreground',
              'hover:bg-accent hover:text-foreground',
              'transition-colors'
            )}
          >
            <TagIcon className="size-3" />
            <span>Add tag</span>
          </button>
        )}
      </div>

      {/* Autocomplete dropdown */}
      {isOpen && (inputValue || dropdownItems > 0) && (
        <div
          className={cn(
            'absolute left-0 right-0 top-full z-50 mt-1',
            'rounded-lg border bg-popover p-1',
            'shadow-lg',
            'animate-in fade-in-0 slide-in-from-top-1 duration-150'
          )}
        >
          {filteredTags.length === 0 && !canCreateNew ? (
            <p className="px-2 py-3 text-center text-sm text-muted-foreground">
              No tags found
            </p>
          ) : (
            <div className="max-h-[200px] overflow-y-auto">
              {/* Existing tags */}
              {filteredTags.map((tag, index) => (
                <AutocompleteItem
                  key={tag.id}
                  tag={tag}
                  isSelected={selectedTagIds.includes(tag.id)}
                  isFocused={focusedIndex === index}
                  onSelect={() => handleSelect(index)}
                  onFocus={() => setFocusedIndex(index)}
                />
              ))}

              {/* Create new tag option */}
              {canCreateNew && (
                <>
                  {filteredTags.length > 0 && (
                    <div className="my-1 border-t border-border" />
                  )}
                  <CreateTagItem
                    name={inputValue.trim()}
                    isFocused={focusedIndex === filteredTags.length}
                    onSelect={createAndAddTag}
                    onFocus={() => setFocusedIndex(filteredTags.length)}
                  />
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* Max tags hint */}
      {atMaxTags && (
        <p className="mt-1 text-xs text-muted-foreground">
          Maximum {maxTags} tags reached
        </p>
      )}
    </div>
  )
}
