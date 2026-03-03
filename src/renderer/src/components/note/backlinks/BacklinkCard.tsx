import { useState } from 'react'
import { cn } from '@/lib/utils'
import { FileText, Folder } from 'lucide-react'
import { BacklinkSnippet } from './BacklinkSnippet'
import type { Backlink } from './types'
import { formatBacklinkDate } from './types'

interface BacklinkCardProps {
  backlink: Backlink
  onClick: (noteId: string) => void
}

export function BacklinkCard({ backlink, onClick }: BacklinkCardProps) {
  const [showAllMentions, setShowAllMentions] = useState(false)
  const { noteId, noteTitle, folder, date, mentions } = backlink

  const hasMultipleMentions = mentions.length > 1
  const visibleMentions = showAllMentions ? mentions : mentions.slice(0, 1)
  const hiddenMentionCount = mentions.length - 1

  const handleClick = () => {
    onClick(noteId)
  }

  const handleShowMoreClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    setShowAllMentions(!showAllMentions)
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          handleClick()
        }
      }}
      className={cn(
        'w-full text-left',
        'bg-stone-50 border border-stone-200 rounded-lg',
        'p-3 sm:p-4',
        'hover:bg-stone-100 hover:border-stone-300',
        'hover:shadow-sm',
        'transition-all duration-150',
        'cursor-pointer',
        'group',
        'focus:outline-none focus:ring-2 focus:ring-stone-400 focus:ring-offset-1'
      )}
      aria-label={`Link from ${noteTitle}`}
    >
      {/* Header Row: Icon + Title + Date */}
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <FileText className="h-4 w-4 text-stone-400 shrink-0" />
          <span className="text-sm font-medium text-stone-900 truncate">{noteTitle}</span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {hasMultipleMentions && (
            <span className="text-xs text-stone-400">{mentions.length} mentions</span>
          )}
          <span className="text-xs text-stone-400">{formatBacklinkDate(date)}</span>
        </div>
      </div>

      {/* Context Snippets */}
      <div className="space-y-2">
        {visibleMentions.map((mention, index) => (
          <div key={mention.id}>
            {index > 0 && <div className="border-t border-stone-200 my-2" />}
            <BacklinkSnippet mention={mention} />
          </div>
        ))}
      </div>

      {/* Show More Mentions */}
      {hasMultipleMentions && !showAllMentions && hiddenMentionCount > 0 && (
        <button
          onClick={handleShowMoreClick}
          className={cn(
            'mt-2 text-xs text-stone-400',
            'hover:text-stone-600 hover:underline',
            'transition-colors duration-150'
          )}
        >
          Show {hiddenMentionCount} more mention
          {hiddenMentionCount > 1 ? 's' : ''}
        </button>
      )}

      {hasMultipleMentions && showAllMentions && (
        <button
          onClick={handleShowMoreClick}
          className={cn(
            'mt-2 text-xs text-stone-400',
            'hover:text-stone-600 hover:underline',
            'transition-colors duration-150'
          )}
        >
          Show less
        </button>
      )}

      {/* Folder indicator */}
      {folder && (
        <div className="flex items-center gap-1 mt-2 text-xs text-stone-400">
          <Folder className="h-3 w-3" />
          <span>{folder}</span>
        </div>
      )}
    </div>
  )
}
