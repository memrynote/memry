/**
 * TagAutocomplete Component
 * Inline tag input with dropdown showing AI suggestions, matching tags, and create option.
 */

import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { Plus } from '@/lib/icons'

import { cn } from '@/lib/utils'
import { useAllTags } from '@/hooks/use-all-tags'
import { COLOR_NAMES, getTagColors } from '@/components/note/tags-row/tag-colors'

function getColorForTag(tagName: string): string {
  let hash = 0
  for (let i = 0; i < tagName.length; i++) {
    hash = tagName.charCodeAt(i) + ((hash << 5) - hash)
  }
  return COLOR_NAMES[Math.abs(hash) % COLOR_NAMES.length]
}

// =============================================================================
// TagPill — inline pill for selected tags
// =============================================================================

const TagPill = ({ tag }: { tag: string }): React.JSX.Element => {
  const colors = getTagColors(getColorForTag(tag))

  return (
    <span
      role="listitem"
      className="inline-flex items-center rounded-[10px] py-0.5 px-2 text-[11px] leading-3.5 tag-pill-enter motion-reduce:animate-none"
      style={{ backgroundColor: `${colors.text}15`, color: colors.text }}
    >
      {tag}
    </span>
  )
}

// =============================================================================
// TagAutocomplete Component
// =============================================================================

interface TagAutocompleteProps {
  tags: string[]
  onTagsChange: (tags: string[]) => void
  placeholder?: string
  showSections?: boolean
  maxSuggestions?: number
  autoFocus?: boolean
  aiSuggestedTags?: string[]
  className?: string
}

const LISTBOX_ID = 'tag-autocomplete-listbox'

export const TagAutocomplete = ({
  tags,
  onTagsChange,
  placeholder = 'Add tags...',
  showSections: _showSections = true,
  maxSuggestions = 8,
  autoFocus = false,
  aiSuggestedTags = [],
  className
}: TagAutocompleteProps): React.JSX.Element => {
  const [inputValue, setInputValue] = useState('')
  const [isDropdownOpen, setIsDropdownOpen] = useState(false)
  const [requestedHighlightedIndex, setRequestedHighlightedIndex] = useState(0)
  const [isFocused, setIsFocused] = useState(false)

  const inputRef = useRef<HTMLInputElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const { searchTags, getPopularTags, getChildTags } = useAllTags()

  const trimmedInput = inputValue.trim()

  const hierarchyContext = useMemo(() => {
    const lastSlash = trimmedInput.lastIndexOf('/')
    if (lastSlash === -1) return null
    return {
      prefix: trimmedInput.slice(0, lastSlash),
      leafQuery: trimmedInput.slice(lastSlash + 1)
    }
  }, [trimmedInput])

  const availableAiTags = useMemo(
    () => aiSuggestedTags.filter((t) => !tags.includes(t)),
    [aiSuggestedTags, tags]
  )

  const matchingTags = useMemo(() => {
    if (!trimmedInput) return []
    if (hierarchyContext) {
      return getChildTags(hierarchyContext.prefix, hierarchyContext.leafQuery || undefined).filter(
        (t) => !tags.includes(t.name)
      )
    }
    return searchTags(trimmedInput).filter((t) => !tags.includes(t.name))
  }, [trimmedInput, hierarchyContext, searchTags, getChildTags, tags])

  const popularTags = useMemo(
    () => getPopularTags(maxSuggestions).filter((t) => !tags.includes(t.name)),
    [getPopularTags, maxSuggestions, tags]
  )

  const exactMatchExists = useMemo(
    () =>
      trimmedInput
        ? tags.includes(trimmedInput.toLowerCase()) ||
          matchingTags.some((t) => t.name.toLowerCase() === trimmedInput.toLowerCase())
        : true,
    [trimmedInput, tags, matchingTags]
  )

  // Build flat list for keyboard navigation
  const flatItems = useMemo(() => {
    const items: Array<{
      type: 'ai' | 'match' | 'popular' | 'create'
      value: string
      count?: number
    }> = []

    if (!trimmedInput && availableAiTags.length > 0) {
      availableAiTags.slice(0, 2).forEach((t) => items.push({ type: 'ai', value: t }))
    }

    if (trimmedInput) {
      matchingTags
        .slice(0, maxSuggestions)
        .forEach((t) => items.push({ type: 'match', value: t.name, count: t.count }))
    } else {
      popularTags
        .slice(0, 5)
        .forEach((t) => items.push({ type: 'popular', value: t.name, count: t.count }))
    }

    if (trimmedInput && !exactMatchExists) {
      items.push({ type: 'create', value: trimmedInput.toLowerCase() })
    }

    return items
  }, [trimmedInput, availableAiTags, matchingTags, popularTags, maxSuggestions, exactMatchExists])

  const highlightedIndex =
    flatItems.length === 0
      ? -1
      : Math.min(Math.max(requestedHighlightedIndex, 0), flatItems.length - 1)

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent): void => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  useEffect(() => {
    if (autoFocus) setTimeout(() => inputRef.current?.focus(), 100)
  }, [autoFocus])

  const addTag = useCallback(
    (tag: string): void => {
      const normalized = tag.trim().toLowerCase()
      if (normalized && !tags.includes(normalized)) {
        onTagsChange([...tags, normalized])
      }
      setInputValue('')
      setRequestedHighlightedIndex(0)
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

    // Space or comma creates tag
    if (value.endsWith(' ') || value.includes(',')) {
      const tagToAdd = value.replace(',', '').trim()
      if (tagToAdd) {
        addTag(tagToAdd)
      }
      return
    }

    setInputValue(value)
    setRequestedHighlightedIndex(0)
    if (!isDropdownOpen) setIsDropdownOpen(true)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    // Escape closes dropdown first, then lets panel handle it
    if (e.key === 'Escape') {
      if (isDropdownOpen) {
        e.preventDefault()
        e.stopPropagation()
        setIsDropdownOpen(false)
        return
      }
      return
    }

    if (isDropdownOpen && flatItems.length > 0) {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setRequestedHighlightedIndex((prev) => (prev < flatItems.length - 1 ? prev + 1 : 0))
          return
        case 'ArrowUp':
          e.preventDefault()
          setRequestedHighlightedIndex((prev) => (prev > 0 ? prev - 1 : flatItems.length - 1))
          return
        case 'Enter':
          e.preventDefault()
          if (highlightedIndex >= 0 && highlightedIndex < flatItems.length) {
            addTag(flatItems[highlightedIndex].value)
          } else if (trimmedInput) {
            addTag(trimmedInput)
          }
          return
        case 'Tab':
          if (highlightedIndex >= 0 && highlightedIndex < flatItems.length) {
            e.preventDefault()
            addTag(flatItems[highlightedIndex].value)
          }
          return
      }
    }

    if (e.key === 'Enter' && trimmedInput) {
      e.preventDefault()
      addTag(trimmedInput)
    } else if (e.key === 'Backspace' && !inputValue && tags.length > 0) {
      removeTag(tags[tags.length - 1])
    }
  }

  // Render helpers for dropdown sections
  const renderAiSection = (): React.JSX.Element | null => {
    if (trimmedInput || availableAiTags.length === 0) return null
    const aiItems = availableAiTags.slice(0, 2)
    const startIdx = 0

    return (
      <div className="flex flex-col py-1">
        <div className="flex items-center py-0.5 px-2">
          <span className="text-[11px] [letter-spacing:0.05em] uppercase text-text-tertiary font-medium leading-3.5">
            Suggested
          </span>
        </div>
        {aiItems.map((tag, i) => {
          const idx = startIdx + i
          return (
            <button
              key={tag}
              type="button"
              onClick={() => addTag(tag)}
              onMouseEnter={() => setRequestedHighlightedIndex(idx)}
              className={cn(
                'flex items-center gap-2 rounded-sm py-2 px-3 mx-1 my-0.5 text-left transition-colors',
                highlightedIndex === idx ? 'bg-[var(--tint)]/[0.03]' : 'hover:bg-foreground/[0.03]'
              )}
            >
              <span className="inline-flex items-center rounded-[10px] py-0.5 px-2 bg-[var(--tint)]/[0.08] text-[var(--tint)] text-[11px] leading-3.5">
                {tag}
              </span>
              <span className="text-[10px] leading-3 text-[var(--tint)]/40">AI</span>
            </button>
          )
        })}
      </div>
    )
  }

  const renderMatchingSection = (): React.JSX.Element | null => {
    const aiCount = !trimmedInput ? availableAiTags.slice(0, 2).length : 0
    const itemsToShow = trimmedInput
      ? matchingTags.slice(0, maxSuggestions)
      : popularTags.slice(0, 5)
    if (itemsToShow.length === 0) return null

    const sectionLabel = hierarchyContext
      ? `Sub-tags of ${hierarchyContext.prefix}`
      : trimmedInput
        ? 'Matching'
        : 'Popular'

    return (
      <div className={cn('flex flex-col py-1', aiCount > 0 && 'border-t border-border/40')}>
        <div className="flex items-center py-0.5 px-2">
          <span className="text-[11px] [letter-spacing:0.05em] uppercase text-text-tertiary font-medium leading-3.5">
            {sectionLabel}
          </span>
        </div>
        {itemsToShow.map((tag, i) => {
          const idx = aiCount + i
          const colors = getTagColors(getColorForTag(tag.name))
          return (
            <button
              key={tag.name}
              type="button"
              onClick={() => addTag(tag.name)}
              onMouseEnter={() => setRequestedHighlightedIndex(idx)}
              className={cn(
                'flex items-center gap-2 rounded-sm py-2 px-3 mx-1 my-0.5 text-left transition-colors',
                highlightedIndex === idx ? 'bg-foreground/[0.03]' : 'hover:bg-foreground/[0.03]'
              )}
            >
              <span
                className="inline-flex items-center rounded-[10px] py-0.5 px-2 text-[11px] leading-3.5"
                style={{ backgroundColor: `${colors.text}15`, color: colors.text }}
              >
                {tag.name}
              </span>
            </button>
          )
        })}
      </div>
    )
  }

  const renderCreateFooter = (): React.JSX.Element | null => {
    if (!trimmedInput || exactMatchExists) return null
    const normalized = trimmedInput.toLowerCase()
    const colors = getTagColors(getColorForTag(normalized))
    const idx = flatItems.length - 1

    return (
      <button
        type="button"
        onClick={() => addTag(normalized)}
        onMouseEnter={() => setRequestedHighlightedIndex(idx)}
        className={cn(
          'flex items-center w-full py-2 px-3 gap-1.5 border-t border-border/40 text-left transition-colors',
          highlightedIndex === idx ? 'bg-foreground/[0.03]' : 'hover:bg-foreground/[0.03]'
        )}
      >
        <Plus className="size-3 text-muted-foreground/30" aria-hidden="true" />
        <span className="text-[11px] leading-3.5 text-muted-foreground/30">Create</span>
        <span
          className="inline-flex items-center rounded-md py-px px-1.5 text-[11px] leading-3.5"
          style={{ backgroundColor: `${colors.text}15`, color: colors.text }}
        >
          {normalized}
        </span>
      </button>
    )
  }

  const showDropdown = isDropdownOpen && flatItems.length > 0

  return (
    <div
      ref={containerRef}
      className={cn('flex flex-col gap-2 py-4 px-5 border-b border-border', className)}
    >
      <span className="text-[11px] [letter-spacing:0.05em] uppercase text-text-tertiary font-medium leading-3.5">
        Tags
      </span>

      <div className="relative">
        <div
          className={cn(
            'flex items-center flex-wrap rounded-md py-2 px-3 gap-1.5 bg-foreground/[0.02] border transition-colors cursor-text',
            isFocused ? 'border-[var(--accent-purple)]/30' : 'border-border'
          )}
          onClick={() => inputRef.current?.focus()}
          role="list"
          aria-label="Selected tags"
        >
          {tags.map((tag) => (
            <TagPill key={tag} tag={tag} />
          ))}
          <input
            ref={inputRef}
            type="text"
            placeholder={tags.length === 0 ? placeholder : ''}
            value={inputValue}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onFocus={() => {
              setIsDropdownOpen(true)
              setIsFocused(true)
            }}
            onBlur={() => {
              setIsFocused(false)
              setTimeout(() => setIsDropdownOpen(false), 150)
            }}
            role="combobox"
            aria-label="Add tags"
            aria-expanded={isDropdownOpen}
            aria-haspopup="listbox"
            aria-controls={LISTBOX_ID}
            aria-autocomplete="list"
            autoComplete="off"
            className="flex-1 min-w-[60px] bg-transparent border-0 p-0 text-xs text-foreground placeholder:text-muted-foreground/30 outline-none focus:outline-none"
          />
        </div>

        {showDropdown && (
          <div
            ref={dropdownRef}
            id={LISTBOX_ID}
            className="absolute z-50 w-full mt-1 p-0 rounded-md border border-border bg-popover shadow-[0_8px_24px_rgba(0,0,0,0.25)] overflow-hidden"
            role="listbox"
            aria-label="Tag suggestions"
          >
            {renderAiSection()}
            {renderMatchingSection()}
            {renderCreateFooter()}
          </div>
        )}
      </div>
    </div>
  )
}
