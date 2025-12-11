import { useState } from 'react'
import { cn } from '@/lib/utils'
import { MoreVertical, Folder } from 'lucide-react'
import { CardActionsMenu } from './CardActionsMenu'
import type { RelatedNote } from './types'
import { getPercentageColors, formatRelativeTime } from './types'

interface RelatedNoteCardProps {
  note: RelatedNote
  onNoteClick: (noteId: string) => void
  onAddReference: (noteId: string) => void
  onHideSuggestion: (noteId: string) => void
}

export function RelatedNoteCard({
  note,
  onNoteClick,
  onAddReference,
  onHideSuggestion
}: RelatedNoteCardProps) {
  const [isHovered, setIsHovered] = useState(false)
  const colors = getPercentageColors(note.similarity)

  const handleCopyLink = () => {
    // Copy note link to clipboard
    navigator.clipboard.writeText(`memry://note/${note.noteId}`)
  }

  return (
    <div
      className={cn(
        'bg-white border border-stone-200 rounded-[10px] p-3.5',
        'cursor-pointer transition-all duration-150',
        'hover:bg-stone-50 hover:border-stone-300 hover:shadow-sm'
      )}
      onClick={() => onNoteClick(note.noteId)}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      role="listitem"
    >
      {/* Header Row */}
      <div className="flex justify-between items-start mb-2.5">
        <div className="flex items-start gap-2 flex-1 min-w-0">
          <span className="text-lg flex-shrink-0">{note.icon || '📄'}</span>
          <h4
            className={cn(
              'text-sm font-medium text-stone-900 leading-tight',
              'line-clamp-2'
            )}
          >
            {note.title}
          </h4>
        </div>
        <CardActionsMenu
          onOpenNote={() => onNoteClick(note.noteId)}
          onAddReference={() => onAddReference(note.noteId)}
          onCopyLink={handleCopyLink}
          onHide={() => onHideSuggestion(note.noteId)}
        >
          <button
            className={cn(
              'p-1 rounded hover:bg-stone-200 transition-all duration-150',
              'text-stone-400 hover:text-stone-600',
              isHovered ? 'opacity-100' : 'opacity-0'
            )}
            onClick={(e) => e.stopPropagation()}
            aria-label="More actions"
          >
            <MoreVertical className="h-4 w-4" />
          </button>
        </CardActionsMenu>
      </div>

      {/* Similarity Badge */}
      <div
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-[13px] font-semibold mb-2.5"
        style={{
          backgroundColor: colors.bg,
          color: colors.text
        }}
      >
        <span>{note.similarity}%</span>
      </div>

      {/* Context Snippet */}
      <p
        className={cn(
          'text-[13px] text-stone-600 leading-relaxed',
          'line-clamp-2 italic mb-2.5'
        )}
      >
        "{note.reason}"
      </p>

      {/* Metadata Row */}
      <div className="flex items-center gap-1.5 text-xs text-stone-400">
        {note.folder && (
          <>
            <Folder className="h-3 w-3" />
            <span>{note.folder}</span>
            <span className="mx-1">•</span>
          </>
        )}
        <span>Updated {formatRelativeTime(note.updatedAt)}</span>
      </div>
    </div>
  )
}
