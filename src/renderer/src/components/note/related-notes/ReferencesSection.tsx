import { useState } from 'react'
import { cn } from '@/lib/utils'
import { Paperclip, Plus } from 'lucide-react'
import { ReferenceChip, OverflowChip } from './ReferenceChip'
import { AddReferencePopup } from './AddReferencePopup'
import type { ReferencedNote, RelatedNote } from './types'

interface ReferencesSectionProps {
  referencedNotes: ReferencedNote[]
  onRemoveReference: (noteId: string) => void
  onAddReference: (noteId: string) => void
  onNoteClick?: (noteId: string) => void
  // For the popup
  recentNotes?: Array<{
    id: string
    noteId: string
    title: string
    icon?: string
  }>
  suggestedNotes?: RelatedNote[]
  maxVisibleChips?: number
}

export function ReferencesSection({
  referencedNotes,
  onRemoveReference,
  onAddReference,
  onNoteClick,
  recentNotes = [],
  suggestedNotes = [],
  maxVisibleChips = 3
}: ReferencesSectionProps) {
  const [showAll, setShowAll] = useState(false)

  const visibleNotes = showAll
    ? referencedNotes
    : referencedNotes.slice(0, maxVisibleChips)

  const overflowCount = referencedNotes.length - maxVisibleChips
  const hasOverflow = overflowCount > 0 && !showAll

  const alreadyReferenced = referencedNotes.map((n) => n.noteId)

  // Convert RelatedNote to search result format
  const popupSuggested = suggestedNotes.map((n) => ({
    id: n.id,
    noteId: n.noteId,
    title: n.title,
    icon: n.icon,
    similarity: n.similarity
  }))

  return (
    <div className="flex-shrink-0 px-4 py-3 border-t border-stone-200 bg-stone-50">
      {/* Section Header */}
      <div className="flex items-center gap-1.5 mb-2.5">
        <Paperclip className="h-3 w-3 text-stone-400" />
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-stone-400">
          Referenced in this note
        </h4>
      </div>

      {/* Reference Chips */}
      {referencedNotes.length > 0 ? (
        <div className="flex flex-wrap gap-2 mb-3" role="list">
          {visibleNotes.map((note) => (
            <ReferenceChip
              key={note.id}
              note={note}
              onRemove={onRemoveReference}
              onClick={onNoteClick}
            />
          ))}
          {hasOverflow && (
            <OverflowChip count={overflowCount} onClick={() => setShowAll(true)} />
          )}
        </div>
      ) : (
        <p className="text-sm text-stone-400 mb-3">No references yet</p>
      )}

      {/* Add Reference Button */}
      <AddReferencePopup
        recentNotes={recentNotes}
        suggestedNotes={popupSuggested}
        onSelect={onAddReference}
        alreadyReferenced={alreadyReferenced}
      >
        <button
          className={cn(
            'inline-flex items-center gap-1.5',
            'px-3 py-1.5',
            'bg-transparent border border-dashed border-stone-300 rounded-2xl',
            'text-[13px] text-stone-500',
            'cursor-pointer hover:bg-stone-100 hover:border-stone-400',
            'transition-colors duration-150'
          )}
        >
          <Plus className="h-3.5 w-3.5" />
          <span>Add reference</span>
        </button>
      </AddReferencePopup>
    </div>
  )
}
