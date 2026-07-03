/**
 * DocumentInfoTab Component
 *
 * Displays document statistics in a clean, organized format.
 * Shows word count, character count, reading time, and dates.
 */

import { memo, useMemo } from 'react'
import { cn } from '@/lib/utils'
import { FileText, Type, Clock, Calendar, Pencil } from '@/lib/icons'
import { parseISO, isValid } from 'date-fns'
import { formatDate as applyDateFormat, type DateFormat } from '@/lib/format-date'
import { useDateFormat } from '@/hooks/use-date-format'
import { useT } from '@memry/i18n/renderer'

export interface DocumentStats {
  wordCount: number
  characterCount: number
  createdAt: string | Date | null
  modifiedAt: string | Date | null
}

interface DocumentInfoTabProps {
  stats: DocumentStats
  className?: string
}

/**
 * Calculate estimated reading time based on word count
 * Average reading speed: 200-250 words per minute
 */
function calculateReadingTime(wordCount: number): string {
  if (wordCount === 0) return '0 min'
  const minutes = Math.ceil(wordCount / 200)
  if (minutes === 1) return '1 min'
  return `${minutes} min`
}

/**
 * Format a date for display
 */
function formatDate(date: string | Date | null, df: DateFormat): string {
  if (!date) return '—'

  try {
    let dateObj: Date

    if (typeof date === 'string') {
      // Try parsing as ISO string
      dateObj = parseISO(date)
    } else {
      dateObj = date
    }

    if (!isValid(dateObj)) return '—'

    return applyDateFormat(dateObj, df)
  } catch {
    return '—'
  }
}

/**
 * Format a number with thousand separators
 */
function formatNumber(num: number): string {
  return num.toLocaleString()
}

interface StatRowProps {
  icon: React.ReactNode
  label: string
  value: string
  className?: string
}

function StatRow({ icon, label, value, className }: StatRowProps) {
  return (
    <div className={cn('flex items-center justify-between py-1.5', className)}>
      <div className="flex items-center gap-2 text-stone-500 dark:text-stone-400">
        {icon}
        <span className="text-xs">{label}</span>
      </div>
      <span className="text-sm font-medium text-stone-700 dark:text-stone-300">{value}</span>
    </div>
  )
}

export const DocumentInfoTab = memo(function DocumentInfoTab({
  stats,
  className
}: DocumentInfoTabProps) {
  const { t: tPhaseF } = useT('notes')
  const dateFormat = useDateFormat()
  const readingTime = useMemo(() => calculateReadingTime(stats.wordCount), [stats.wordCount])

  const formattedCreatedAt = useMemo(
    () => formatDate(stats.createdAt, dateFormat),
    [stats.createdAt, dateFormat]
  )
  const formattedModifiedAt = useMemo(
    () => formatDate(stats.modifiedAt, dateFormat),
    [stats.modifiedAt, dateFormat]
  )

  const iconClass = 'h-3.5 w-3.5'

  return (
    <div className={cn('px-3 py-2', className)}>
      {/* Content Stats */}
      <div className="space-y-0.5">
        <StatRow
          icon={<FileText className={iconClass} />}
          label={tPhaseF('phaseF.componentsSharedDocumentInfoTab.words')}
          value={formatNumber(stats.wordCount)}
        />
        <StatRow
          icon={<Type className={iconClass} />}
          label={tPhaseF('phaseF.componentsSharedDocumentInfoTab.characters')}
          value={formatNumber(stats.characterCount)}
        />
        <StatRow
          icon={<Clock className={iconClass} />}
          label={tPhaseF('phaseF.componentsSharedDocumentInfoTab.readingTime')}
          value={readingTime}
        />
      </div>

      {/* Divider */}
      <div className="my-2 border-t border-stone-200 dark:border-stone-700" />

      {/* Date Stats */}
      <div className="space-y-0.5">
        <StatRow
          icon={<Calendar className={iconClass} />}
          label={tPhaseF('phaseF.componentsSharedDocumentInfoTab.created')}
          value={formattedCreatedAt}
        />
        <StatRow
          icon={<Pencil className={iconClass} />}
          label={tPhaseF('phaseF.componentsSharedDocumentInfoTab.modified')}
          value={formattedModifiedAt}
        />
      </div>
    </div>
  )
})
