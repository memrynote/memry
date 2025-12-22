import { useState, useEffect, useCallback, useMemo } from "react"
import { Search, FileText, Loader2 } from "lucide-react"

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { notesService, type NoteListItem } from "@/services/notes-service"
import type { SearchResultNote } from '@/services/search-service'

// ============================================================================
// TYPES
// ============================================================================

interface NoteSearchDropdownProps {
  onSelectNote: (noteId: string) => void
  excludeNoteIds?: string[]
  children: React.ReactNode
  className?: string
}

// Combined type for both list items and search results
type NoteItem = {
  id: string
  title: string
}

// ============================================================================
// NOTE SEARCH DROPDOWN COMPONENT
// ============================================================================

export const NoteSearchDropdown = ({
  onSelectNote,
  excludeNoteIds = [],
  children,
  className,
}: NoteSearchDropdownProps): React.JSX.Element => {
  const [isOpen, setIsOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [notes, setNotes] = useState<NoteItem[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [debouncedQuery, setDebouncedQuery] = useState("")

  // Debounce search query
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(searchQuery)
    }, 300)
    return () => clearTimeout(timer)
  }, [searchQuery])

  // Load notes when dropdown opens or search query changes
  useEffect(() => {
    if (!isOpen) return

    const loadNotes = async (): Promise<void> => {
      setIsLoading(true)
      try {
        if (debouncedQuery.trim()) {
          // Use search API when there's a query
          const results = await window.api.search.searchNotes(debouncedQuery, { limit: 20 })
          setNotes(results.map((r: SearchResultNote) => ({ id: r.id, title: r.title })))
        } else {
          // Load recent notes when no query
          const response = await notesService.list({ limit: 20, sortBy: "modified", sortOrder: "desc" })
          setNotes(response.notes.map((n: NoteListItem) => ({ id: n.id, title: n.title })))
        }
      } catch (error) {
        console.error("Failed to load notes:", error)
        setNotes([])
      } finally {
        setIsLoading(false)
      }
    }

    loadNotes()
  }, [isOpen, debouncedQuery])

  // Filter out excluded notes
  const filteredNotes = useMemo(() => {
    return notes.filter((note) => !excludeNoteIds.includes(note.id))
  }, [notes, excludeNoteIds])

  const handleSelectNote = useCallback((noteId: string): void => {
    onSelectNote(noteId)
    setIsOpen(false)
    setSearchQuery("")
  }, [onSelectNote])

  const handleOpenChange = useCallback((open: boolean): void => {
    setIsOpen(open)
    if (!open) {
      setSearchQuery("")
      setDebouncedQuery("")
    }
  }, [])

  return (
    <Popover open={isOpen} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild className={className}>
        {children}
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        {/* Search input */}
        <div className="p-2 border-b border-border">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search notes..."
              className="pl-8 h-8"
              autoFocus
            />
          </div>
        </div>

        {/* Results */}
        <div className="max-h-60 overflow-y-auto p-1">
          {isLoading ? (
            <div className="flex items-center justify-center px-3 py-6">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : filteredNotes.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">
              {searchQuery ? "No notes found" : "No notes available"}
            </div>
          ) : (
            filteredNotes.map((note) => (
              <button
                key={note.id}
                type="button"
                onClick={() => handleSelectNote(note.id)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
                  "hover:bg-accent focus:bg-accent focus:outline-none"
                )}
              >
                <FileText className="size-4 text-muted-foreground" aria-hidden="true" />
                <span className="truncate">{note.title}</span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

export default NoteSearchDropdown
