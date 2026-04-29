/**
 * Journal Stats Footer Component
 *
 * A minimal sticky footer that displays word count, character count,
 * reading time, and modification date at the bottom of journal entries.
 */

import { memo } from 'react'
import { FileText, Type, Clock, Calendar } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'

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
const calculateReadingMinutes = (wordCount: number): number => Math.ceil(wordCount / 200)

/**
 * Format date for display
 */
const formatDate = (dateStr: string | null, locale: string): string => {
  if (!dateStr) return '—'
  try {
    const date = new Date(dateStr)
    return date.toLocaleDateString(locale, {
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
  const { t, i18n } = useT('journal')
  const readingMinutes = calculateReadingMinutes(wordCount)
  const readingTime =
    readingMinutes < 1
      ? t('stats.lessThanOneMinute')
      : t('stats.minutes', { minutes: readingMinutes })
  const modifiedDate = formatDate(modifiedAt || createdAt, i18n.language)

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
      aria-label={t('aria.documentStatistics')}
    >
      {/* Word Count */}
      <div className="flex items-center gap-1.5" title={t('stats.wordCount')}>
        <FileText className="size-3.5" aria-hidden="true" />
        <span>{t('count.words', { count: wordCount })}</span>
      </div>

      <span className="text-border" aria-hidden="true">
        ·
      </span>

      {/* Character Count */}
      <div className="flex items-center gap-1.5" title={t('stats.characterCount')}>
        <Type className="size-3.5" aria-hidden="true" />
        <span>{t('count.characters', { count: characterCount })}</span>
      </div>

      <span className="text-border" aria-hidden="true">
        ·
      </span>

      {/* Reading Time */}
      <div className="flex items-center gap-1.5" title={t('stats.readingTime')}>
        <Clock className="size-3.5" aria-hidden="true" />
        <span>{t('stats.read', { readingTime })}</span>
      </div>

      <span className="text-border" aria-hidden="true">
        ·
      </span>

      {/* Modified Date */}
      <div className="flex items-center gap-1.5" title={t('stats.lastModified')}>
        <Calendar className="size-3.5" aria-hidden="true" />
        <span>{t('stats.modified', { date: modifiedDate })}</span>
      </div>
    </div>
  )
})

export default JournalStatsFooter
