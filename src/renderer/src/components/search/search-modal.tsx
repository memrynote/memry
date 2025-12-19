import { useState, useEffect, useRef, useCallback } from 'react'
import { Search, Loader2 } from 'lucide-react'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useQuickSearch } from '@/hooks/use-search'
import { safeHighlight } from '@/services/search-service'
import { SearchResultItem } from './search-result-item'

export interface SearchModalProps {
  isOpen: boolean
  onClose: () => void
  onSelectNote: (noteId: string) => void
}

export function SearchModal({ isOpen, onClose, onSelectNote }: SearchModalProps) {
  const { query, notes, isLoading, setQuery, clear } = useQuickSearch(100)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      clear()
      setSelectedIndex(0)
      // Focus input after dialog animation
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [isOpen, clear])

  // Reset selection when results change
  useEffect(() => {
    setSelectedIndex(0)
  }, [notes])

  // Scroll selected item into view
  useEffect(() => {
    if (resultsRef.current && notes.length > 0) {
      const selectedElement = resultsRef.current.querySelector('[aria-selected="true"]')
      selectedElement?.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex, notes.length])

  // Handle keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setSelectedIndex((prev) => Math.min(prev + 1, notes.length - 1))
          break
        case 'ArrowUp':
          e.preventDefault()
          setSelectedIndex((prev) => Math.max(prev - 1, 0))
          break
        case 'Enter':
          e.preventDefault()
          if (notes[selectedIndex]) {
            onSelectNote(notes[selectedIndex].id)
            onClose()
          }
          break
        case 'Escape':
          e.preventDefault()
          onClose()
          break
      }
    },
    [notes, selectedIndex, onSelectNote, onClose]
  )

  const handleSelect = (noteId: string) => {
    onSelectNote(noteId)
    onClose()
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="max-w-xl p-0 gap-0 overflow-hidden"
        onKeyDown={handleKeyDown}
      >
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
          {isLoading && (
            <Loader2 className="size-4 text-muted-foreground animate-spin shrink-0" />
          )}
        </div>

        {/* Results */}
        <ScrollArea className="max-h-[400px]">
          <div ref={resultsRef} role="listbox" className="p-2">
            {notes.length > 0 ? (
              notes.map((note, index) => (
                <SearchResultItem
                  key={note.id}
                  id={note.id}
                  title={safeHighlight(note.title, query)}
                  path={note.path}
                  snippet={note.snippet}
                  tags={note.tags}
                  isSelected={index === selectedIndex}
                  onClick={() => handleSelect(note.id)}
                />
              ))
            ) : query.trim() ? (
              <div className="py-8 text-center text-muted-foreground">
                <p>No notes found</p>
                <p className="text-sm mt-1">Try a different search term</p>
              </div>
            ) : (
              <div className="py-8 text-center text-muted-foreground">
                <p>Type to search notes</p>
                <p className="text-sm mt-1">Search by title, content, or tags</p>
              </div>
            )}
          </div>
        </ScrollArea>

        {/* Footer with hints */}
        {notes.length > 0 && (
          <div className="flex items-center justify-between px-3 py-2 border-t text-xs text-muted-foreground bg-muted/30">
            <div className="flex items-center gap-3">
              <span><kbd className="px-1.5 py-0.5 rounded bg-muted">↑↓</kbd> navigate</span>
              <span><kbd className="px-1.5 py-0.5 rounded bg-muted">↵</kbd> open</span>
              <span><kbd className="px-1.5 py-0.5 rounded bg-muted">esc</kbd> close</span>
            </div>
            <span>{notes.length} result{notes.length !== 1 ? 's' : ''}</span>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
