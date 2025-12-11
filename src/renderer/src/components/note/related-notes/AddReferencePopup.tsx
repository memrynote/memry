import { useState, useRef, useEffect } from 'react'
import { cn } from '@/lib/utils'
import { Search } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { getPercentageColors } from './types'

interface SearchResult {
  id: string
  noteId: string
  title: string
  icon?: string
  similarity?: number
}

interface AddReferencePopupProps {
  children: React.ReactNode
  recentNotes?: SearchResult[]
  suggestedNotes?: SearchResult[]
  onSelect: (noteId: string) => void
  onSearch?: (query: string) => SearchResult[]
  alreadyReferenced: string[] // noteIds already referenced
}

export function AddReferencePopup({
  children,
  recentNotes = [],
  suggestedNotes = [],
  onSelect,
  onSearch,
  alreadyReferenced
}: AddReferencePopupProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus()
    }
  }, [isOpen])

  useEffect(() => {
    if (searchQuery && onSearch) {
      const results = onSearch(searchQuery)
      setSearchResults(results.filter((r) => !alreadyReferenced.includes(r.noteId)))
    } else {
      setSearchResults([])
    }
  }, [searchQuery, onSearch, alreadyReferenced])

  const handleSelect = (noteId: string) => {
    onSelect(noteId)
    setIsOpen(false)
    setSearchQuery('')
  }

  const filteredRecent = recentNotes.filter((n) => !alreadyReferenced.includes(n.noteId))
  const filteredSuggested = suggestedNotes.filter((n) => !alreadyReferenced.includes(n.noteId))

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        align="start"
        className={cn(
          'w-[280px] p-0 bg-white border-stone-200 shadow-lg',
          'rounded-xl overflow-hidden'
        )}
      >
        {/* Search Input */}
        <div className="p-3 border-b border-stone-200">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-stone-400" />
            <input
              ref={inputRef}
              type="text"
              placeholder="Search notes..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className={cn(
                'w-full pl-9 pr-3 py-2',
                'text-sm text-stone-900 placeholder:text-stone-400',
                'bg-stone-50 border border-stone-200 rounded-lg',
                'focus:outline-none focus:ring-2 focus:ring-stone-400 focus:border-transparent'
              )}
              aria-label="Search notes to reference"
            />
          </div>
        </div>

        {/* Results List */}
        <div className="max-h-[260px] overflow-y-auto">
          {searchQuery ? (
            // Search Results
            searchResults.length > 0 ? (
              <div className="py-1">
                {searchResults.map((note) => (
                  <ResultItem
                    key={note.id}
                    note={note}
                    onClick={() => handleSelect(note.noteId)}
                  />
                ))}
              </div>
            ) : (
              <div className="p-4 text-center text-sm text-stone-500">
                No notes found
              </div>
            )
          ) : (
            <>
              {/* Recent Notes */}
              {filteredRecent.length > 0 && (
                <>
                  <div className="px-3 py-2 bg-stone-50 text-[11px] font-semibold uppercase tracking-wide text-stone-400">
                    Recent
                  </div>
                  {filteredRecent.map((note) => (
                    <ResultItem
                      key={note.id}
                      note={note}
                      onClick={() => handleSelect(note.noteId)}
                    />
                  ))}
                </>
              )}

              {/* Suggested Notes */}
              {filteredSuggested.length > 0 && (
                <>
                  <div className="px-3 py-2 bg-stone-50 text-[11px] font-semibold uppercase tracking-wide text-stone-400">
                    Suggested
                  </div>
                  {filteredSuggested.map((note) => (
                    <ResultItem
                      key={note.id}
                      note={note}
                      onClick={() => handleSelect(note.noteId)}
                      showSimilarity
                    />
                  ))}
                </>
              )}

              {filteredRecent.length === 0 && filteredSuggested.length === 0 && (
                <div className="p-4 text-center text-sm text-stone-500">
                  No notes available
                </div>
              )}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

interface ResultItemProps {
  note: SearchResult
  onClick: () => void
  showSimilarity?: boolean
}

function ResultItem({ note, onClick, showSimilarity }: ResultItemProps) {
  const colors = note.similarity ? getPercentageColors(note.similarity) : null

  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full px-3 py-2.5 flex items-center gap-2.5',
        'hover:bg-stone-100 transition-colors duration-150',
        'text-left'
      )}
    >
      <span className="text-base flex-shrink-0">{note.icon || '📄'}</span>
      <span className="flex-1 text-sm text-stone-700 truncate">{note.title}</span>
      {showSimilarity && note.similarity && (
        <span
          className="text-xs font-medium px-1.5 py-0.5 rounded"
          style={{
            backgroundColor: colors?.bg,
            color: colors?.text
          }}
        >
          {note.similarity}%
        </span>
      )}
    </button>
  )
}
