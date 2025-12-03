import { FileText, X, Link } from "lucide-react"

import { Button } from "@/components/ui/button"
import { NoteSearchDropdown } from "./note-search-dropdown"
import { cn } from "@/lib/utils"
import { getNoteById } from "@/data/sample-notes"

// ============================================================================
// TYPES
// ============================================================================

interface TaskLinksSectionProps {
  linkedNoteIds: string[]
  onAddLink: (noteId: string) => void
  onRemoveLink: (noteId: string) => void
  className?: string
}

// ============================================================================
// LINKED NOTE ITEM
// ============================================================================

interface LinkedNoteItemProps {
  noteId: string
  onRemove: () => void
}

const LinkedNoteItem = ({
  noteId,
  onRemove,
}: LinkedNoteItemProps): React.JSX.Element | null => {
  const note = getNoteById(noteId)

  if (!note) return null

  return (
    <div className="group flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
      <FileText className="size-4 text-muted-foreground" aria-hidden="true" />
      <span className="flex-1 truncate text-sm">{note.title}</span>
      <Button
        variant="ghost"
        size="icon"
        className="size-6 opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={onRemove}
        aria-label={`Remove link to ${note.title}`}
      >
        <X className="size-3.5" />
      </Button>
    </div>
  )
}

// ============================================================================
// TASK LINKS SECTION COMPONENT
// ============================================================================

export const TaskLinksSection = ({
  linkedNoteIds,
  onAddLink,
  onRemoveLink,
  className,
}: TaskLinksSectionProps): React.JSX.Element => {
  const handleRemoveLink = (noteId: string) => (): void => {
    onRemoveLink(noteId)
  }

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {/* Section label */}
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Linked Notes
      </h3>

      {/* Linked notes list */}
      {linkedNoteIds.length > 0 && (
        <div className="flex flex-col gap-2">
          {linkedNoteIds.map((noteId) => (
            <LinkedNoteItem
              key={noteId}
              noteId={noteId}
              onRemove={handleRemoveLink(noteId)}
            />
          ))}
        </div>
      )}

      {/* Add link button with dropdown */}
      <NoteSearchDropdown
        onSelectNote={onAddLink}
        excludeNoteIds={linkedNoteIds}
      >
        <button
          type="button"
          className={cn(
            "flex items-center gap-2 rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground transition-colors",
            "hover:border-primary hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          )}
        >
          <Link className="size-4" aria-hidden="true" />
          <span>Link to a note...</span>
        </button>
      </NoteSearchDropdown>
    </div>
  )
}

export default TaskLinksSection

