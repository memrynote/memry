import { useState, useRef } from 'react'
import { X } from 'lucide-react'

import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

interface TagPillProps {
  tag: string
  onRemove: (tag: string) => void
  variant?: 'selected' | 'suggested'
}

const TagPill = ({ tag, onRemove, variant = 'selected' }: TagPillProps): React.JSX.Element => {
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
        'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium',
        'tag-pill-enter motion-reduce:animate-none',
        variant === 'selected'
          ? 'bg-primary text-primary-foreground'
          : 'bg-muted text-muted-foreground hover:bg-muted/80 cursor-pointer'
      )}
    >
      {tag}
      {variant === 'selected' && (
        <button
          type="button"
          onClick={handleRemove}
          onKeyDown={handleKeyDown}
          className={cn(
            'hover:bg-primary-foreground/20 rounded-full p-0.5',
            'transition-colors duration-[var(--duration-instant)]'
          )}
          aria-label={`Remove tag ${tag}`}
        >
          <X className="size-3" aria-hidden="true" />
        </button>
      )}
    </span>
  )
}

interface SuggestedTagProps {
  tag: string
  onAdd: (tag: string) => void
  disabled?: boolean
}

const SuggestedTag = ({ tag, onAdd, disabled }: SuggestedTagProps): React.JSX.Element => {
  const handleClick = (): void => {
    if (!disabled) {
      onAdd(tag)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if ((e.key === 'Enter' || e.key === ' ') && !disabled) {
      e.preventDefault()
      onAdd(tag)
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      disabled={disabled}
      className={cn(
        'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium',
        'transition-colors duration-[var(--duration-instant)]',
        disabled
          ? 'bg-muted/50 text-muted-foreground/50 cursor-not-allowed'
          : 'bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground cursor-pointer'
      )}
    >
      {tag}
    </button>
  )
}

interface TagInputProps {
  tags: string[]
  suggestedTags: string[]
  onTagsChange: (tags: string[]) => void
}

const TagInput = ({ tags, suggestedTags, onTagsChange }: TagInputProps): React.JSX.Element => {
  const [inputValue, setInputValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const addTag = (tag: string): void => {
    const normalizedTag = tag.trim().toLowerCase()
    if (normalizedTag && !tags.includes(normalizedTag)) {
      onTagsChange([...tags, normalizedTag])
    }
    setInputValue('')
  }

  const removeTag = (tag: string): void => {
    onTagsChange(tags.filter((t) => t !== tag))
  }

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
    if (e.key === 'Enter' && inputValue.trim()) {
      e.preventDefault()
      addTag(inputValue)
    } else if (e.key === 'Backspace' && !inputValue && tags.length > 0) {
      // Remove last tag when backspace is pressed on empty input
      removeTag(tags[tags.length - 1])
    }
  }

  const handleSuggestedTagClick = (tag: string): void => {
    addTag(tag)
    inputRef.current?.focus()
  }

  // Filter suggested tags to exclude already added ones
  const availableSuggestedTags = suggestedTags.filter((tag) => !tags.includes(tag))

  return (
    <div className="space-y-3">
      {/* Section Label */}
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium text-foreground">Tags</h3>
        <span className="text-xs text-muted-foreground">(optional)</span>
      </div>

      {/* Input with tags */}
      <div className="space-y-2">
        <Input
          ref={inputRef}
          type="text"
          placeholder="Add tags..."
          value={inputValue}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          aria-label="Add tags"
        />

        {/* Current Tags */}
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5" role="list" aria-label="Selected tags">
            {tags.map((tag) => (
              <TagPill key={tag} tag={tag} onRemove={removeTag} variant="selected" />
            ))}
          </div>
        )}
      </div>

      {/* Suggested Tags */}
      {availableSuggestedTags.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground/70">Suggested</p>
          <div className="flex flex-wrap gap-1.5">
            {availableSuggestedTags.map((tag) => (
              <SuggestedTag key={tag} tag={tag} onAdd={handleSuggestedTagClick} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export { TagInput }
