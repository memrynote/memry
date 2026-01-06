/**
 * TagAutocomplete Component
 * Enhanced tag input with autocomplete dropdown, recent tags, and popular tags.
 * Used across FilingPanel, BulkFilePanel, and BulkTagPopover.
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import { X, Plus, Clock, TrendingUp } from 'lucide-react'

import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { useAllTags, type TagWithMeta } from '@/hooks/use-all-tags'
import { COLOR_NAMES, getTagColors } from '@/components/note/tags-row/tag-colors'

// Hash function to get consistent color for a tag name
function getColorForTag(tagName: string): string {
  let hash = 0
  for (let i = 0; i < tagName.length; i++) {
    hash = tagName.charCodeAt(i) + ((hash << 5) - hash)
  }
  const index = Math.abs(hash) % COLOR_NAMES.length
  return COLOR_NAMES[index]
}

// =============================================================================
// TagPill Component
// =============================================================================

interface TagPillProps {
  tag: string
  onRemove: (tag: string) => void
}

const TagPill = ({ tag, onRemove }: TagPillProps): React.JSX.Element => {
  const colorName = getColorForTag(tag)
  const colors = getTagColors(colorName)

  const handleRemove = (e: React.MouseEvent): void => {
    e.stopPropagation()
    onRemove(tag)
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Backspace') {
      e.preventDefault()
      onRemove(tag)
    }
  }

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium',
        'tag-pill-enter motion-reduce:animate-none'
      )}
      style={{
        backgroundColor: colors.background,
        color: colors.text
      }}
    >
      {tag}
      <button
        type="button"
        onClick={handleRemove}
        onKeyDown={handleKeyDown}
        className="rounded-full p-0.5 transition-opacity hover:opacity-70"
        aria-label={`Remove tag ${tag}`}
      >
        <X className="size-3" aria-hidden="true" />
      </button>
    </span>
  )
}

// =============================================================================
// SuggestionItem Component
// =============================================================================

interface SuggestionItemProps {
  tag: TagWithMeta
  isHighlighted: boolean
  onSelect: (tag: string) => void
  onMouseEnter: () => void
}

const SuggestionItem = ({
  tag,
  isHighlighted,
  onSelect,
  onMouseEnter
}: SuggestionItemProps): React.JSX.Element => {
  return (
    <button
      type="button"
      onClick={() => onSelect(tag.name)}
      onMouseEnter={onMouseEnter}
      className={cn(
        'w-full flex items-center justify-between px-3 py-1.5 text-sm text-left',
        'transition-colors duration-75',
        isHighlighted ? 'bg-accent text-accent-foreground' : 'hover:bg-muted'
      )}
    >
      <span className="flex items-center gap-2">
        {tag.color && (
          <span
            className="size-2 rounded-full"
            style={{ backgroundColor: tag.color }}
            aria-hidden="true"
          />
        )}
        <span>{tag.name}</span>
      </span>
      <span className="text-xs text-muted-foreground">{tag.count}</span>
    </button>
  )
}

// =============================================================================
// QuickTagButton Component
// =============================================================================

interface QuickTagButtonProps {
  tag: string
  onAdd: (tag: string) => void
  disabled?: boolean
}

const QuickTagButton = ({ tag, onAdd, disabled }: QuickTagButtonProps): React.JSX.Element => {
  const colorName = getColorForTag(tag)
  const colors = getTagColors(colorName)

  return (
    <button
      type="button"
      onClick={() => onAdd(tag)}
      disabled={disabled}
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium',
        'transition-opacity duration-[var(--duration-instant)]',
        disabled ? 'opacity-40 cursor-not-allowed' : 'hover:opacity-80 cursor-pointer'
      )}
      style={{
        backgroundColor: disabled ? undefined : `${colors.background}80`, // 50% opacity
        color: disabled ? undefined : colors.text
      }}
    >
      <Plus className="size-3" aria-hidden="true" />
      {tag}
    </button>
  )
}

// =============================================================================
// TagAutocomplete Component
// =============================================================================

interface TagAutocompleteProps {
  /** Currently selected tags */
  tags: string[]
  /** Callback when tags change */
  onTagsChange: (tags: string[]) => void
  /** Placeholder text for input */
  placeholder?: string
  /** Show section labels (Recent, Popular) */
  showSections?: boolean
  /** Maximum suggestions to show in dropdown */
  maxSuggestions?: number
  /** Auto focus input on mount */
  autoFocus?: boolean
  /** Class name for container */
  className?: string
}

export const TagAutocomplete = ({
  tags,
  onTagsChange,
  placeholder = 'Add tags...',
  showSections = true,
  maxSuggestions = 8,
  autoFocus = false,
  className
}: TagAutocompleteProps): React.JSX.Element => {
  const [inputValue, setInputValue] = useState('')
  const [isDropdownOpen, setIsDropdownOpen] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(-1)

  const inputRef = useRef<HTMLInputElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const { searchTags, getPopularTags, getRecentTags, isLoading } = useAllTags()

  // Get filtered suggestions based on input
  const suggestions = inputValue.trim()
    ? searchTags(inputValue).filter((t) => !tags.includes(t.name))
    : []

  // Get quick suggestions (recent + popular) when no input
  const recentTags = getRecentTags(5).filter((t) => !tags.includes(t.name))
  const popularTags = getPopularTags(8).filter((t) => !tags.includes(t.name))

  // Show dropdown when typing and there are matches
  useEffect(() => {
    if (inputValue.trim() && suggestions.length > 0) {
      setIsDropdownOpen(true)
      setHighlightedIndex(0)
    } else if (!inputValue.trim()) {
      setIsDropdownOpen(false)
      setHighlightedIndex(-1)
    }
  }, [inputValue, suggestions.length])

  // Close dropdown on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent): void => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsDropdownOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // Auto focus
  useEffect(() => {
    if (autoFocus) {
      setTimeout(() => inputRef.current?.focus(), 100)
    }
  }, [autoFocus])

  const addTag = useCallback(
    (tag: string): void => {
      const normalizedTag = tag.trim().toLowerCase()
      if (normalizedTag && !tags.includes(normalizedTag)) {
        onTagsChange([...tags, normalizedTag])
      }
      setInputValue('')
      setIsDropdownOpen(false)
      setHighlightedIndex(-1)
      inputRef.current?.focus()
    },
    [tags, onTagsChange]
  )

  const removeTag = useCallback(
    (tag: string): void => {
      onTagsChange(tags.filter((t) => t !== tag))
    },
    [tags, onTagsChange]
  )

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const value = e.target.value
    // Check for comma to add tag
    if (value.includes(',')) {
      const parts = value.split(',')
      const tagToAdd = parts[0]
      if (tagToAdd.trim()) {
        addTag(tagToAdd)
      }
      setInputValue(parts.slice(1).join(','))
    } else {
      setInputValue(value)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (isDropdownOpen && suggestions.length > 0) {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setHighlightedIndex((prev) => (prev < suggestions.length - 1 ? prev + 1 : 0))
          break
        case 'ArrowUp':
          e.preventDefault()
          setHighlightedIndex((prev) => (prev > 0 ? prev - 1 : suggestions.length - 1))
          break
        case 'Enter':
          e.preventDefault()
          if (highlightedIndex >= 0 && highlightedIndex < suggestions.length) {
            addTag(suggestions[highlightedIndex].name)
          } else if (inputValue.trim()) {
            addTag(inputValue)
          }
          break
        case 'Escape':
          e.preventDefault()
          setIsDropdownOpen(false)
          setHighlightedIndex(-1)
          break
        case 'Tab':
          if (highlightedIndex >= 0 && highlightedIndex < suggestions.length) {
            e.preventDefault()
            addTag(suggestions[highlightedIndex].name)
          }
          break
      }
    } else {
      if (e.key === 'Enter' && inputValue.trim()) {
        e.preventDefault()
        addTag(inputValue)
      } else if (e.key === 'Backspace' && !inputValue && tags.length > 0) {
        removeTag(tags[tags.length - 1])
      }
    }
  }

  const handleInputFocus = (): void => {
    if (inputValue.trim() && suggestions.length > 0) {
      setIsDropdownOpen(true)
    }
  }

  return (
    <div ref={containerRef} className={cn('space-y-3', className)}>
      {/* Section Label */}
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium text-foreground">Tags</h3>
        <span className="text-xs text-muted-foreground">(optional)</span>
      </div>

      {/* Input with autocomplete dropdown */}
      <div className="relative">
        <Input
          ref={inputRef}
          type="text"
          placeholder={placeholder}
          value={inputValue}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onFocus={handleInputFocus}
          aria-label="Add tags"
          aria-expanded={isDropdownOpen}
          aria-haspopup="listbox"
          aria-autocomplete="list"
          autoComplete="off"
        />

        {/* Autocomplete Dropdown */}
        {isDropdownOpen && suggestions.length > 0 && (
          <div
            ref={dropdownRef}
            className={cn(
              'absolute z-50 w-full mt-1 py-1 rounded-md border border-border',
              'bg-popover shadow-md max-h-48 overflow-y-auto'
            )}
            role="listbox"
          >
            {suggestions.slice(0, maxSuggestions).map((tag, index) => (
              <SuggestionItem
                key={tag.name}
                tag={tag}
                isHighlighted={index === highlightedIndex}
                onSelect={addTag}
                onMouseEnter={() => setHighlightedIndex(index)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Current Tags */}
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5" role="list" aria-label="Selected tags">
          {tags.map((tag) => (
            <TagPill key={tag} tag={tag} onRemove={removeTag} />
          ))}
        </div>
      )}

      {/* Quick Suggestions (when not typing) */}
      {showSections && !inputValue.trim() && !isLoading && (
        <div className="space-y-3">
          {/* Recent Tags */}
          {recentTags.length > 0 && (
            <div className="space-y-1.5">
              <p className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground/70">
                <Clock className="size-3" aria-hidden="true" />
                Recent
              </p>
              <div className="flex flex-wrap gap-1.5">
                {recentTags.slice(0, 5).map((tag) => (
                  <QuickTagButton key={tag.name} tag={tag.name} onAdd={addTag} />
                ))}
              </div>
            </div>
          )}

          {/* Popular Tags */}
          {popularTags.length > 0 && (
            <div className="space-y-1.5">
              <p className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground/70">
                <TrendingUp className="size-3" aria-hidden="true" />
                Popular
              </p>
              <div className="flex flex-wrap gap-1.5">
                {popularTags.slice(0, 8).map((tag) => (
                  <QuickTagButton key={tag.name} tag={tag.name} onAdd={addTag} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
