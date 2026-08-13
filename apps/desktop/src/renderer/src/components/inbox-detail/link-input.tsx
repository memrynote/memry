/**
 * LinkInput Component
 * Modern card-based link input with search functionality
 * Follows Option E design: icon in input, card-based linked notes below
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import { Link2, FileText, X, Loader2, Folder, Plus } from '@/lib/icons'
import { useQuery } from '@tanstack/react-query'
import { useT } from '@memry/i18n/renderer'

import { cn } from '@/lib/utils'
import { NoteIconDisplay } from '@/lib/render-note-icon'
import type { LinkedNote } from '@/types'

import { useDebouncedValue } from '@/hooks/use-task-filters'

// =============================================================================
// LinkedNoteCard Component
// =============================================================================

interface LinkedNoteCardProps {
  note: LinkedNote
  onRemove: (id: string) => void
}

const LinkedNoteCard = ({ note, onRemove }: LinkedNoteCardProps): React.JSX.Element => {
  const { t } = useT('inbox')
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
          <p className="text-[11px] leading-3.5 text-muted-foreground/60 truncate">
            {note.isPending ? t('detail.pendingNote') : t('type.note')}
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={() => onRemove(note.id)}
        className={cn(
          'p-1 rounded-md opacity-0 group-hover:opacity-100',
          'transition-opacity hover:bg-destructive/10 hover:text-destructive'
        )}
        aria-label={t('detail.removeLinkTo', { title: note.title })}
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
        'w-full flex items-center gap-2 px-3 py-2 mx-1 my-0.5 rounded-sm text-start',
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
  const { t } = useT('inbox')
  const { t: tCommon } = useT('common')
  const [searchQuery, setSearchQuery] = useState('')
  const [isDropdownDismissed, setIsDropdownDismissed] = useState(false)
  const [highlightedIndexState, setHighlightedIndex] = useState(0)

  const inputRef = useRef<HTMLInputElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Debounced search query
  const debouncedQuery = useDebouncedValue(searchQuery, 200)

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
  const trimmedQuery = searchQuery.trim()
  // Offer creation unless the typed title is already on the board — as a search
  // hit or as a note already staged — so Enter never silently makes a duplicate.
  const canCreateNote =
    trimmedQuery.length >= 2 &&
    !searchResults.some((note) => note.title.toLowerCase() === trimmedQuery.toLowerCase()) &&
    !linkedNotes.some((note) => note.title.toLowerCase() === trimmedQuery.toLowerCase())

  /**
   * The keyboard-navigable list. Create sits *last*, so Enter still links the
   * top match when the query found something — with an empty result list it is
   * index 0 anyway, which is the case where creating is what you meant.
   */
  const options: Array<{ kind: 'create' } | { kind: 'note'; note: LinkedNote }> = [
    ...availableResults.map((note) => ({ kind: 'note' as const, note })),
    ...(canCreateNote ? [{ kind: 'create' as const }] : [])
  ]
  const isDropdownOpen = trimmedQuery.length >= 2 && !isDropdownDismissed
  const highlightedIndex =
    options.length === 0 ? -1 : Math.min(highlightedIndexState, options.length - 1)

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

  /**
   * Stage a note that does not exist yet. Nothing is written here — a name the
   * user types and then removes must not leave an empty note in the vault, so
   * creation waits for the filing itself.
   */
  const handleCreateNote = useCallback((): void => {
    const title = searchQuery.trim()
    if (!title) return
    onLinkedNotesChange([
      ...linkedNotes,
      { id: `pending:${title}`, title, type: 'note', isPending: true }
    ])
    setSearchQuery('')
    setIsDropdownDismissed(false)
    setHighlightedIndex(0)
    inputRef.current?.focus()
  }, [searchQuery, linkedNotes, onLinkedNotesChange])

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

  const activateOption = (index: number): void => {
    const option = options[index]
    if (!option) return
    if (option.kind === 'create') {
      handleCreateNote()
      return
    }
    handleSelectNote(option.note)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (!isDropdownOpen || options.length === 0) {
      if (e.key === 'Escape') {
        setSearchQuery('')
        inputRef.current?.blur()
      }
      return
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setHighlightedIndex((prev) => (prev < options.length - 1 ? prev + 1 : 0))
        break
      case 'ArrowUp':
        e.preventDefault()
        setHighlightedIndex((prev) => (prev > 0 ? prev - 1 : options.length - 1))
        break
      case 'Enter':
        e.preventDefault()
        activateOption(highlightedIndex)
        break
      case 'Escape':
        e.preventDefault()
        setIsDropdownDismissed(true)
        setSearchQuery('')
        setHighlightedIndex(0)
        break
      case 'Tab':
        if (highlightedIndex >= 0 && highlightedIndex < options.length) {
          e.preventDefault()
          activateOption(highlightedIndex)
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
            role="combobox"
            placeholder={t('detail.linkOrCreateNotePlaceholder')}
            value={searchQuery}
            onChange={handleInputChange}
            onFocus={handleInputFocus}
            onKeyDown={handleKeyDown}
            aria-label={t('detail.searchNotesAria')}
            aria-controls="link-input-listbox"
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
            id="link-input-listbox"
            role="listbox"
          >
            {isSearching ? (
              <div className="flex items-center gap-2 px-3 py-2">
                <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
                <span className="text-xs text-muted-foreground">{tCommon('state.searching')}</span>
              </div>
            ) : options.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-3">
                {searchResults.length > 0 ? t('empty.allMatchesLinked') : t('empty.noNotes')}
              </p>
            ) : (
              options.map((option, index) =>
                option.kind === 'create' ? (
                  <button
                    key="create"
                    type="button"
                    role="option"
                    aria-selected={index === highlightedIndex}
                    data-testid="link-input-create-note"
                    onClick={handleCreateNote}
                    onMouseEnter={() => setHighlightedIndex(index)}
                    className={cn(
                      'w-full flex items-center gap-2.5 px-3 py-2 text-start transition-colors',
                      index === highlightedIndex ? 'bg-muted/60' : 'hover:bg-muted/40'
                    )}
                  >
                    <Plus className="size-3.5 text-muted-foreground shrink-0" aria-hidden="true" />
                    <span className="text-[13px] leading-4 truncate flex-1 text-foreground">
                      {t('detail.createNote', { title: trimmedQuery })}
                    </span>
                  </button>
                ) : (
                  <SearchResultItem
                    key={option.note.id}
                    note={option.note}
                    isHighlighted={index === highlightedIndex}
                    onSelect={handleSelectNote}
                    onMouseEnter={() => setHighlightedIndex(index)}
                  />
                )
              )
            )}
          </div>
        )}
      </div>

      {/* Linked Notes List */}
      {linkedNotes.length > 0 && (
        <div className="space-y-2" role="list" aria-label={t('detail.linkedNotesAria')}>
          {linkedNotes.map((note) => (
            <LinkedNoteCard key={note.id} note={note} onRemove={handleRemoveNote} />
          ))}
        </div>
      )}
    </div>
  )
}

export default LinkInput
