/**
 * Journal Stats Footer Component
 *
 * A minimal sticky footer that displays word count, character count,
 * reading time, and modification date at the bottom of journal entries.
 */

import { memo } from 'react'
import { FileText, Type, Clock, Calendar } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface JournalStatsFooterProps {
  /** Word count of the entry */
  wordCount: number
  /** Character count of the entry */
  characterCount: number
  /** Created date ISO string */
  createdAt: string | null
  /** Modified date ISO string */
  modifiedAt: string | null
  /** Additional class names */
  className?: string
}

/**
 * Calculate estimated reading time in minutes
 * Average reading speed is ~200-250 words per minute
 */
const calculateReadingTime = (wordCount: number): string => {
  const minutes = Math.ceil(wordCount / 200)
  if (minutes < 1) return '< 1 min'
  return `${minutes} min`
}

/**
 * Format date for display
 */
const formatDate = (dateStr: string | null): string => {
  if (!dateStr) return '—'
  try {
    const date = new Date(dateStr)
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    })
  } catch {
    return '—'
  }
}

export const JournalStatsFooter = memo(function JournalStatsFooter({
  wordCount,
  characterCount,
  createdAt,
  modifiedAt,
  className
}: JournalStatsFooterProps): React.JSX.Element {
  const readingTime = calculateReadingTime(wordCount)
  const modifiedDate = formatDate(modifiedAt || createdAt)

  return (
    <div
      className={cn(
        'sticky bottom-0 left-0 right-0',
        'border-t border-border/40 bg-background/95 backdrop-blur-sm',
        'px-4 py-2',
        'flex items-center justify-center gap-6',
        'text-xs text-muted-foreground',
        'z-10',
        className
      )}
      role="contentinfo"
      aria-label="Document statistics"
    >
      {/* Word Count */}
      <div className="flex items-center gap-1.5" title="Word count">
        <FileText className="size-3.5" aria-hidden="true" />
        <span>{wordCount.toLocaleString()} words</span>
      </div>

      <span className="text-border" aria-hidden="true">
        ·
      </span>

      {/* Character Count */}
      <div className="flex items-center gap-1.5" title="Character count">
        <Type className="size-3.5" aria-hidden="true" />
        <span>{characterCount.toLocaleString()} chars</span>
      </div>

      <span className="text-border" aria-hidden="true">
        ·
      </span>

      {/* Reading Time */}
      <div className="flex items-center gap-1.5" title="Estimated reading time">
        <Clock className="size-3.5" aria-hidden="true" />
        <span>{readingTime} read</span>
      </div>

      <span className="text-border" aria-hidden="true">
        ·
      </span>

      {/* Modified Date */}
      <div className="flex items-center gap-1.5" title="Last modified">
        <Calendar className="size-3.5" aria-hidden="true" />
        <span>Modified {modifiedDate}</span>
      </div>
    </div>
  )
})

export default JournalStatsFooter
