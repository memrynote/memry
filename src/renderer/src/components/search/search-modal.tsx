import { useState, useEffect, useRef, useCallback } from 'react'
import { Search, Loader2, Clock } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useQuickSearch, useRecentSearches } from '@/hooks/use-search'
import { safeHighlight } from '@/services/search-service'
import { SearchResultItem } from './search-result-item'

export interface SearchModalProps {
  isOpen: boolean
  onClose: () => void
  onSelectNote: (noteId: string, path: string) => void
}

export function SearchModal({ isOpen, onClose, onSelectNote }: SearchModalProps) {
  const { query, notes, isLoading, setQuery, clear } = useQuickSearch(100)
  const { recent, addRecent, clearRecent } = useRecentSearches()
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)

  // Determine if we're showing recent searches or results
  const showRecent = !query.trim() && recent.length > 0
  const itemCount = showRecent ? recent.length : notes.length

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      clear()
      setSelectedIndex(0)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [isOpen, clear])

  // Reset selection when results change
  useEffect(() => {
    setSelectedIndex(0)
  }, [notes])

  // Scroll selected item into view
  useEffect(() => {
    if (resultsRef.current && itemCount > 0) {
      const selectedElement = resultsRef.current.querySelector('[aria-selected="true"]')
      selectedElement?.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex, itemCount])

  // Handle selecting a recent search
  const handleSelectRecent = useCallback(
    (recentQuery: string) => {
      setQuery(recentQuery)
      setSelectedIndex(0)
    },
    [setQuery]
  )

  // Handle selecting a note (adds to recent)
  const handleSelect = useCallback(
    (noteId: string, path: string) => {
      if (query.trim()) {
        addRecent(query.trim())
      }
      onSelectNote(noteId, path)
      onClose()
    },
    [query, addRecent, onSelectNote, onClose]
  )

  // Handle keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setSelectedIndex((prev) => Math.min(prev + 1, itemCount - 1))
          break
        case 'ArrowUp':
          e.preventDefault()
          setSelectedIndex((prev) => Math.max(prev - 1, 0))
          break
        case 'Enter':
          e.preventDefault()
          if (showRecent && recent[selectedIndex]) {
            handleSelectRecent(recent[selectedIndex])
          } else if (notes[selectedIndex]) {
            handleSelect(notes[selectedIndex].id, notes[selectedIndex].path)
          }
          break
        case 'Escape':
          e.preventDefault()
          onClose()
          break
      }
    },
    [showRecent, recent, notes, selectedIndex, itemCount, handleSelectRecent, handleSelect, onClose]
  )

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="max-w-xl p-0 gap-0 overflow-hidden"
        onKeyDown={handleKeyDown}
        aria-describedby={undefined}
      >
        {/* Visually hidden title for screen readers */}
        <DialogTitle className="sr-only">Search notes</DialogTitle>

        {/* Search Input */}
        <div className="flex items-center border-b px-3">
          <Search className="size-4 text-muted-foreground shrink-0" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search notes..."
            className="border-0 focus-visible:ring-0 focus-visible:ring-offset-0 h-12 text-base"
            aria-label="Search notes"
          />
          {isLoading && <Loader2 className="size-4 text-muted-foreground animate-spin shrink-0" />}
        </div>

        {/* Results */}
        <ScrollArea className="max-h-[400px]">
          <div ref={resultsRef} role="listbox" className="p-2">
            {/* Recent Searches */}
            {showRecent && (
              <div className="space-y-1">
                <div className="flex items-center justify-between px-2 py-1.5">
                  <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Recent
                  </span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      clearRecent()
                    }}
                    className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Clear
                  </button>
                </div>
                {recent.slice(0, 8).map((recentQuery, index) => (
                  <button
                    key={recentQuery}
                    type="button"
                    onClick={() => handleSelectRecent(recentQuery)}
                    className={`
                      w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-left text-sm
                      transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring
                      ${
                        index === selectedIndex
                          ? 'bg-accent text-accent-foreground'
                          : 'hover:bg-muted text-muted-foreground hover:text-foreground'
                      }
                    `}
                    role="option"
                    aria-selected={index === selectedIndex}
                  >
                    <Clock className="size-3.5 shrink-0 opacity-50" />
                    <span className="truncate">{recentQuery}</span>
                  </button>
                ))}
              </div>
            )}

            {/* Search Results */}
            {!showRecent &&
              notes.length > 0 &&
              notes.map((note, index) => (
                <SearchResultItem
                  key={note.id}
                  id={note.id}
                  title={safeHighlight(note.title, query)}
                  path={note.path}
                  snippet={note.snippet}
                  tags={note.tags}
                  isSelected={index === selectedIndex}
                  onClick={() => handleSelect(note.id, note.path)}
                />
              ))}

            {/* No Results */}
            {!showRecent && query.trim() && notes.length === 0 && !isLoading && (
              <div className="py-8 text-center text-muted-foreground">
                <p>No notes found</p>
                <p className="text-sm mt-1">Try a different search term</p>
              </div>
            )}

            {/* Empty State (no query, no recent) */}
            {!query.trim() && recent.length === 0 && (
              <div className="py-8 text-center text-muted-foreground">
                <Search className="size-8 mx-auto mb-3 opacity-30" />
                <p>Search your notes</p>
                <p className="text-sm mt-1">Find by title, content, or tags</p>
              </div>
            )}
          </div>
        </ScrollArea>

        {/* Footer with hints */}
        {(notes.length > 0 || showRecent) && (
          <div className="flex items-center justify-between px-3 py-2 border-t text-xs text-muted-foreground bg-muted/30">
            <div className="flex items-center gap-3">
              <span>
                <kbd className="px-1.5 py-0.5 rounded bg-muted">↑↓</kbd> navigate
              </span>
              <span>
                <kbd className="px-1.5 py-0.5 rounded bg-muted">↵</kbd>{' '}
                {showRecent ? 'search' : 'open'}
              </span>
              <span>
                <kbd className="px-1.5 py-0.5 rounded bg-muted">esc</kbd> close
              </span>
            </div>
            {!showRecent && notes.length > 0 && (
              <span>
                {notes.length} result{notes.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
