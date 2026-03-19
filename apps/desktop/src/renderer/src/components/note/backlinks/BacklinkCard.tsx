import { useState } from 'react'
import { cn } from '@/lib/utils'
import { BacklinkSnippet } from './BacklinkSnippet'
import type { Backlink } from './types'

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
        'flex flex-col grow shrink basis-0',
        'rounded-[10px] py-3 px-3.5 gap-1.5',
        'bg-background border border-border',
        'hover:border-border hover:shadow-sm',
        'transition-all duration-150',
        'cursor-pointer',
        'group',
        'focus:outline-none focus:ring-1 focus:ring-sidebar-terracotta/20 focus:ring-offset-1'
      )}
      aria-label={`Link from ${noteTitle}`}
    >
      {/* Title */}
      <span className="text-[13px] text-foreground font-sans font-semibold leading-4 truncate">
        {noteTitle}
      </span>

      {/* Context Snippet (first mention only for compact view) */}
      {visibleMentions.length > 0 && (
        <div className="text-[12px] leading-[18px] text-muted-foreground font-sans line-clamp-2">
          <BacklinkSnippet mention={visibleMentions[0]} />
        </div>
      )}

      {/* Show More Mentions */}
      {hasMultipleMentions && !showAllMentions && hiddenMentionCount > 0 && (
        <button
          onClick={handleShowMoreClick}
          className="text-[11px] text-text-tertiary hover:text-muted-foreground transition-colors"
        >
          +{hiddenMentionCount} more
        </button>
      )}
    </div>
  )
}
