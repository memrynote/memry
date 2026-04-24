/**
 * LinkInput Component
 * Modern card-based link input with search functionality
 * Follows Option E design: icon in input, card-based linked notes below
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import { Link2, FileText, X, Loader2, Folder } from '@/lib/icons'
import { useQuery } from '@tanstack/react-query'

import { cn } from '@/lib/utils'
import { NoteIconDisplay } from '@/lib/render-note-icon'
import type { LinkedNote } from '@/types'

// =============================================================================
// Debounce Hook
// =============================================================================

function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value)

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value)
    }, delay)

    return () => clearTimeout(handler)
  }, [value, delay])

  return debouncedValue
}

// =============================================================================
// LinkedNoteCard Component
// =============================================================================

interface LinkedNoteCardProps {
  note: LinkedNote
  onRemove: (id: string) => void
}

const LinkedNoteCard = ({ note, onRemove }: LinkedNoteCardProps): React.JSX.Element => {
  const Icon = note.type === 'folder' ? Folder : FileText

  return (
    <div
      className={cn(
        'group flex items-center gap-3 px-3 py-2.5 rounded-md',
        'bg-muted/40 border border-border/50',
        'transition-colors hover:bg-muted/60'
      )}
    >
      <div className="flex items-center justify-center size-7 rounded-md bg-foreground/[0.03] border border-border/50 shrink-0">
        {note.emoji ? (
          <NoteIconDisplay value={note.emoji} className="size-3.5" />
        ) : (
          <Icon className="size-3.5 text-muted-foreground" aria-hidden="true" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[13px] leading-4 font-medium truncate text-foreground">{note.title}</p>
        {note.type === 'note' && (
          <p className="text-[11px] leading-3.5 text-muted-foreground/60 truncate">Note</p>
        )}
      </div>
      <button
        type="button"
        onClick={() => onRemove(note.id)}
        className={cn(
          'p-1 rounded-md opacity-0 group-hover:opacity-100',
          'transition-opacity hover:bg-destructive/10 hover:text-destructive'
        )}
        aria-label={`Remove link to ${note.title}`}
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </div>
  )
}

// =============================================================================
// SearchResultItem Component
// =============================================================================

interface SearchResultItemProps {
  note: LinkedNote
  isHighlighted: boolean
  onSelect: (note: LinkedNote) => void
  onMouseEnter: () => void
}

const SearchResultItem = ({
  note,
  isHighlighted,
  onSelect,
  onMouseEnter
}: SearchResultItemProps): React.JSX.Element => {
  const Icon = note.type === 'folder' ? Folder : FileText

  return (
    <button
      type="button"
      onClick={() => onSelect(note)}
      onMouseEnter={onMouseEnter}
      className={cn(
        'w-full flex items-center gap-2 px-3 py-2 mx-1 my-0.5 rounded-sm text-left',
        'transition-colors duration-75',
        isHighlighted ? 'bg-foreground/[0.03]' : 'hover:bg-foreground/[0.03]'
      )}
      role="option"
      aria-selected={isHighlighted}
    >
      {note.emoji ? (
        <NoteIconDisplay value={note.emoji} className="size-3.5 shrink-0" />
      ) : (
        <Icon className="size-3.5 text-muted-foreground shrink-0" aria-hidden="true" />
      )}
      <span className="text-[13px] leading-4 truncate flex-1 text-foreground">{note.title}</span>
    </button>
  )
}

// =============================================================================
// LinkInput Component
// =============================================================================

interface LinkInputProps {
  linkedNotes: LinkedNote[]
  onLinkedNotesChange: (notes: LinkedNote[]) => void
  className?: string
}

export const LinkInput = ({
  linkedNotes,
  onLinkedNotesChange,
  className
}: LinkInputProps): React.JSX.Element => {
  const [searchQuery, setSearchQuery] = useState('')
  const [isDropdownDismissed, setIsDropdownDismissed] = useState(false)
  const [highlightedIndexState, setHighlightedIndex] = useState(0)

  const inputRef = useRef<HTMLInputElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Debounced search query
  const debouncedQuery = useDebounce(searchQuery, 200)

  // Fetch notes for search (by title only)
  const { data: searchResults = [], isLoading: isSearching } = useQuery({
    queryKey: ['notes', 'search', 'title', debouncedQuery],
    queryFn: async () => {
      if (!debouncedQuery || debouncedQuery.length < 2) return []
      const response = await window.api.notes.list({
        limit: 50,
        sortBy: 'modified',
        sortOrder: 'desc'
      })
      const query = debouncedQuery.trim().toLowerCase()
      return response.notes
        .filter((n) => n.title.toLowerCase().includes(query))
        .slice(0, 10)
        .map((note) => ({
          id: note.id,
          title: note.title,
          type: 'note' as const,
          emoji: note.emoji
        }))
    },
    enabled: debouncedQuery.length >= 2
  })

  // Filter out already linked notes
  const availableResults = searchResults.filter(
    (note) => !linkedNotes.find((n) => n.id === note.id)
  )
  const isDropdownOpen = searchQuery.trim().length >= 2 && !isDropdownDismissed
  const highlightedIndex =
    availableResults.length === 0
      ? -1
      : Math.min(highlightedIndexState, availableResults.length - 1)

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent): void => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsDropdownDismissed(true)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const handleSelectNote = useCallback(
    (note: LinkedNote): void => {
      if (!linkedNotes.find((n) => n.id === note.id)) {
        onLinkedNotesChange([...linkedNotes, note])
      }
      setSearchQuery('')
      setIsDropdownDismissed(false)
      setHighlightedIndex(0)
      inputRef.current?.focus()
    },
    [linkedNotes, onLinkedNotesChange]
  )

  const handleRemoveNote = useCallback(
    (noteId: string): void => {
      onLinkedNotesChange(linkedNotes.filter((n) => n.id !== noteId))
    },
    [linkedNotes, onLinkedNotesChange]
  )

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    setSearchQuery(e.target.value)
    setHighlightedIndex(0)
    setIsDropdownDismissed(false)
  }

  const handleInputFocus = (): void => {
    if (searchQuery.trim().length >= 2) {
      setIsDropdownDismissed(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (!isDropdownOpen || availableResults.length === 0) {
      if (e.key === 'Escape') {
        setSearchQuery('')
        inputRef.current?.blur()
      }
      return
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setHighlightedIndex((prev) => (prev < availableResults.length - 1 ? prev + 1 : 0))
        break
      case 'ArrowUp':
        e.preventDefault()
        setHighlightedIndex((prev) => (prev > 0 ? prev - 1 : availableResults.length - 1))
        break
      case 'Enter':
        e.preventDefault()
        if (highlightedIndex >= 0 && highlightedIndex < availableResults.length) {
          handleSelectNote(availableResults[highlightedIndex])
        }
        break
      case 'Escape':
        e.preventDefault()
        setIsDropdownDismissed(true)
        setSearchQuery('')
        setHighlightedIndex(0)
        break
      case 'Tab':
        if (highlightedIndex >= 0 && highlightedIndex < availableResults.length) {
          e.preventDefault()
          handleSelectNote(availableResults[highlightedIndex])
        }
        break
    }
  }

  return (
    <div ref={containerRef} className={cn('space-y-3', className)}>
      {/* Search Input */}
      <div className="relative">
        <div className="flex items-center rounded-md py-2 px-3 gap-2 bg-foreground/[0.02] border border-border">
          <Link2 className="size-3.5 text-muted-foreground/30 shrink-0" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            placeholder="Link notes..."
            value={searchQuery}
            onChange={handleInputChange}
            onFocus={handleInputFocus}
            onKeyDown={handleKeyDown}
            aria-label="Search notes to link"
            aria-expanded={isDropdownOpen}
            aria-haspopup="listbox"
            aria-autocomplete="list"
            autoComplete="off"
            className="flex-1 min-w-0 bg-transparent border-0 p-0 text-[13px] leading-4 text-foreground placeholder:text-muted-foreground/30 outline-none focus:outline-none"
          />
        </div>

        {/* Dropdown Results */}
        {isDropdownOpen && (
          <div
            ref={dropdownRef}
            className="absolute z-50 w-full mt-1 p-0 rounded-md border border-border bg-popover shadow-[0_8px_24px_rgba(0,0,0,0.25)] max-h-48 overflow-y-auto"
            role="listbox"
          >
            {isSearching ? (
              <div className="flex items-center gap-2 px-3 py-2">
                <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
                <span className="text-xs text-muted-foreground">Searching...</span>
              </div>
            ) : availableResults.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-3">
                {searchResults.length > 0 ? 'All matches already linked' : 'No notes found'}
              </p>
            ) : (
              availableResults.map((note, index) => (
                <SearchResultItem
                  key={note.id}
                  note={note}
                  isHighlighted={index === highlightedIndex}
                  onSelect={handleSelectNote}
                  onMouseEnter={() => setHighlightedIndex(index)}
                />
              ))
            )}
          </div>
        )}
      </div>

      {/* Linked Notes List */}
      {linkedNotes.length > 0 && (
        <div className="space-y-2" role="list" aria-label="Linked notes">
          {linkedNotes.map((note) => (
            <LinkedNoteCard key={note.id} note={note} onRemove={handleRemoveNote} />
          ))}
        </div>
      )}
    </div>
  )
}

export default LinkInput
