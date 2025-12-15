import { ScrollArea } from '@/components/ui/scroll-area'
import { RelatedNoteCard } from './RelatedNoteCard'
import { EmptyState } from './EmptyState'
import { LoadingSkeleton } from './LoadingSkeleton'
import type { RelatedNote } from './types'
import { cn } from '@/lib/utils'

// Demo data for development - showing only 4 notes
const DEMO_RELATED_NOTES: RelatedNote[] = [
  {
    id: 'rel-1',
    noteId: 'note-456',
    title: 'Film Analysis Methods',
    icon: '📄',
    similarity: 92,
    reason: 'discusses cinematography techniques similar to those analyzed in this note',
    folder: 'Projects',
    updatedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
  },
  {
    id: 'rel-2',
    noteId: 'note-789',
    title: '1970s Cinema Overview',
    icon: '🎬',
    similarity: 87,
    reason: 'covers the same era and directorial approaches mentioned here',
    folder: 'Research',
    updatedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000)
  },
  {
    id: 'rel-3',
    noteId: 'note-012',
    title: 'Crime Drama Genre Study',
    icon: '📝',
    similarity: 76,
    reason: 'explores genre conventions present in this film',
    folder: 'Analysis',
    updatedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  },
  {
    id: 'rel-4',
    noteId: 'note-345',
    title: 'Marlon Brando Biography',
    icon: '🎭',
    similarity: 64,
    reason: 'contains biographical details about the lead actor',
    folder: 'People',
    updatedAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)
  }
]

interface SimplifiedRelatedNotesTabProps {
  noteId?: string
  relatedNotes?: RelatedNote[]
  isLoading?: boolean
  onNoteClick?: (noteId: string) => void
  onHideSuggestion?: (noteId: string) => void
}

export function RelatedNotesTab({
  relatedNotes: propRelatedNotes,
  isLoading = false,
  onNoteClick,
  onHideSuggestion
}: SimplifiedRelatedNotesTabProps) {
  // Use provided notes or demo data, always limited to first 4
  const relatedNotes = (propRelatedNotes ?? DEMO_RELATED_NOTES).slice(0, 4)

  // Handlers
  const handleNoteClick = (id: string) => {
    if (onNoteClick) {
      onNoteClick(id)
    } else {
      console.log('Navigate to note:', id)
    }
  }

  const handleHideSuggestion = (id: string) => {
    if (onHideSuggestion) {
      onHideSuggestion(id)
    } else {
      console.log('Hide suggestion:', id)
    }
  }

  // Dummy handler for add reference (no longer used but card expects it)
  const handleAddReference = (id: string) => {
    console.log('Add reference (not implemented):', id)
  }

  return (
    <div className="flex flex-col h-full journal-animate-in">
      {/* Section Header - Scholarly label */}
      <div className="px-4 pt-4 pb-2 journal-stagger-1">
        <div className="flex items-baseline justify-between">
          <h3 className="font-sans text-xs font-medium uppercase tracking-wider text-sidebar-foreground/50">
            Suggested Connections
          </h3>
          <span className="font-serif text-xs italic text-sidebar-foreground/30">
            {relatedNotes.length} found
          </span>
        </div>
        {/* Decorative divider */}
        <div className="mt-2 h-px bg-gradient-to-r from-amber-500/20 via-sidebar-border/30 to-transparent" />
      </div>

      {/* Content Area */}
      <div className="flex-1 overflow-hidden">
        {isLoading ? (
          <div aria-live="polite" aria-busy="true" className="journal-stagger-2">
            <div className="px-4 py-3">
              <p className="font-serif text-sm italic text-muted-foreground/60">
                Analyzing note content...
              </p>
            </div>
            <LoadingSkeleton />
          </div>
        ) : relatedNotes.length === 0 ? (
          <EmptyState onRefresh={() => console.log('Refresh (not implemented)')} />
        ) : (
          <ScrollArea className="h-full">
            <div className="p-4 pt-2 space-y-3" role="list">
              {relatedNotes.map((note, index) => (
                <div
                  key={note.id}
                  className={cn('journal-stagger-' + Math.min(index + 2, 5))}
                >
                  <RelatedNoteCard
                    note={note}
                    onNoteClick={handleNoteClick}
                    onAddReference={handleAddReference}
                    onHideSuggestion={handleHideSuggestion}
                  />
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </div>
    </div>
  )
}
