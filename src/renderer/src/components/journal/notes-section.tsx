/**
 * Notes Section Component
 * Displays list of notes for a day card, opens drawer on click
 */

import { memo } from 'react'
import { FileText, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

// =============================================================================
// TYPES
// =============================================================================

export interface Note {
    id: string
    title: string
    content?: string
    createdAt: string      // ISO timestamp
    preview?: string       // First ~60 chars for preview
}

export interface NotesSectionProps {
    /** Notes for this day */
    notes: Note[]
    /** Currently open note id in drawer */
    activeNoteId?: string | null
    /** Callback when a note is clicked */
    onNoteClick?: (noteId: string) => void
    /** Additional CSS classes */
    className?: string
}

// =============================================================================
// NOTES SECTION COMPONENT
// =============================================================================

/**
 * Notes section - always visible in day card
 * Shows list of notes or empty state
 */
export const NotesSection = memo(function NotesSection({
    notes,
    activeNoteId,
    onNoteClick,
    className,
}: NotesSectionProps): React.JSX.Element {
    return (
        <div className={cn("rounded-lg border border-border/40 bg-muted/20", className)}>
            {/* Header */}
            <div className="px-4 py-3 border-b border-border/30">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <FileText className="size-4 text-muted-foreground" />
                        <span className="text-sm font-medium text-foreground">Notes</span>
                    </div>
                    {notes.length > 0 && (
                        <span className="text-xs text-muted-foreground">({notes.length})</span>
                    )}
                </div>
            </div>

            {/* Content */}
            <div className="p-3">
                {notes.length > 0 ? (
                    <div className="flex flex-col gap-2">
                        {notes.map(note => (
                            <NoteItem
                                key={note.id}
                                note={note}
                                isActive={note.id === activeNoteId}
                                onClick={() => onNoteClick?.(note.id)}
                            />
                        ))}
                    </div>
                ) : (
                    <EmptyState />
                )}
            </div>
        </div>
    )
})

// =============================================================================
// NOTE ITEM
// =============================================================================

interface NoteItemProps {
    note: Note
    isActive: boolean
    onClick?: () => void
}

function NoteItem({ note, isActive, onClick }: NoteItemProps): React.JSX.Element {
    // Format time from createdAt
    const time = new Date(note.createdAt).toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
    })

    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                "flex flex-col gap-1 p-3 rounded-md w-full text-left",
                "transition-colors duration-150",
                "hover:bg-background/80",
                // Active state (note is open in drawer)
                isActive && [
                    "bg-primary/10 border-l-2 border-l-primary",
                    "hover:bg-primary/15"
                ],
                !isActive && "bg-background/50"
            )}
            aria-selected={isActive}
            aria-expanded={isActive}
        >
            {/* Time */}
            <span className="text-xs text-muted-foreground">{time}</span>

            {/* Title row */}
            <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                    <FileText className="size-4 text-muted-foreground shrink-0" />
                    <span className="text-sm font-medium text-foreground truncate">
                        {note.title}
                    </span>
                </div>
                <ChevronRight className={cn(
                    "size-4 shrink-0 transition-colors",
                    isActive ? "text-primary" : "text-muted-foreground/50",
                    "group-hover:text-muted-foreground"
                )} />
            </div>

            {/* Preview */}
            {note.preview && (
                <p className="text-xs text-muted-foreground line-clamp-1 pl-6">
                    "{note.preview}"
                </p>
            )}
        </button>
    )
}

// =============================================================================
// EMPTY STATE
// =============================================================================

function EmptyState(): React.JSX.Element {
    return (
        <div className="py-6 text-center">
            <p className="text-sm text-muted-foreground">
                No notes from this day
            </p>
        </div>
    )
}

export default NotesSection
