import { ScrollArea } from '@/components/ui/scroll-area'
import { RelatedNoteCard } from './RelatedNoteCard'
import { EmptyState } from './EmptyState'
import { LoadingSkeleton } from './LoadingSkeleton'
import type { RelatedNote } from './types'

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
    <div className="flex flex-col h-full">
      {/* Content Area - No header, no filters, just the notes */}
      <div className="flex-1 overflow-hidden">
        {isLoading ? (
          <div aria-live="polite" aria-busy="true">
            <div className="px-4 py-2 text-xs text-muted-foreground">
              Analyzing note content...
            </div>
            <LoadingSkeleton />
          </div>
        ) : relatedNotes.length === 0 ? (
          <EmptyState onRefresh={() => console.log('Refresh (not implemented)')} />
        ) : (
          <ScrollArea className="h-full">
            <div className="p-4 space-y-2.5" role="list">
              {relatedNotes.map((note) => (
                <RelatedNoteCard
                  key={note.id}
                  note={note}
                  onNoteClick={handleNoteClick}
                  onAddReference={handleAddReference}
                  onHideSuggestion={handleHideSuggestion}
                />
              ))}
            </div>
          </ScrollArea>
        )}
      </div>
    </div>
  )
}
