import { useState, useMemo } from "react"
import { Search, FileText, File, Users } from "lucide-react"

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { searchNotes, type Note } from "@/data/sample-notes"

// ============================================================================
// TYPES
// ============================================================================

interface NoteSearchDropdownProps {
  onSelectNote: (noteId: string) => void
  excludeNoteIds?: string[]
  children: React.ReactNode
  className?: string
}

// ============================================================================
// NOTE ICON COMPONENT
// ============================================================================

const NoteIcon = ({ type }: { type: Note["type"] }): React.JSX.Element => {
  switch (type) {
    case "document":
      return <File className="size-4 text-blue-500" aria-hidden="true" />
    case "meeting":
      return <Users className="size-4 text-purple-500" aria-hidden="true" />
    default:
      return <FileText className="size-4 text-muted-foreground" aria-hidden="true" />
  }
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

  // Search and filter notes
  const filteredNotes = useMemo(() => {
    const results = searchNotes(searchQuery)
    // Exclude already linked notes
    return results.filter((note) => !excludeNoteIds.includes(note.id))
  }, [searchQuery, excludeNoteIds])

  const handleSelectNote = (noteId: string): void => {
    onSelectNote(noteId)
    setIsOpen(false)
    setSearchQuery("")
  }

  const handleOpenChange = (open: boolean): void => {
    setIsOpen(open)
    if (!open) {
      setSearchQuery("")
    }
  }

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
          {filteredNotes.length === 0 ? (
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
                <NoteIcon type={note.type} />
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

