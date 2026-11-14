/**
 * The same day in other years, under a journal day's editor.
 *
 * Two layouts of one list: previews (On this day) and every year in full (the
 * Forever Journal). Only the day on screen is editable; another year opens as
 * its own day.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { SameDayEntry } from '@memry/contracts/journal-api'
import { useT } from '@memry/i18n/renderer'
import { useSameDayEntries } from '@/hooks/use-journal-same-day'
import { createJournalDateLabels, formatDateParts } from '@/lib/journal-utils'
import { createLogger } from '@/lib/logger'
import { cn } from '@/lib/utils'
import { CanvasNoteBody } from '@/pages/canvas/canvas-note-body'

const log = createLogger('JournalPastYears')

/** A full entry taller than this folds behind Show full entry. */
const FOLDED_MAX_HEIGHT_PX = 208

interface JournalPastYearsProps {
  /** The day on screen. */
  date: string
  today: string
  allYears: boolean
  onToggleAllYears: () => void
  onOpenDay: (date: string) => void
}

interface YearLabels {
  year: string
  /** Weekday, or the real date when a leap day shows on Feb 28. */
  day: string
  relative: string
}

export function JournalPastYears({
  date,
  today,
  allYears,
  onToggleAllYears,
  onOpenDay
}: JournalPastYearsProps): React.JSX.Element | null {
  const { t } = useT('journal')
  const { entries, error } = useSameDayEntries(date)
  const dateLabels = useMemo(() => createJournalDateLabels(t), [t])

  useEffect(() => {
    if (error) log.error('Failed to load the same day in other years', { date, error })
  }, [error, date])

  if (entries.length === 0 && !error) return null

  const labelsFor = (entry: SameDayEntry): YearLabels => {
    const parts = formatDateParts(entry.date, dateLabels)
    const yearDiff = parts.year - Number(date.slice(0, 4))
    return {
      year: String(parts.year),
      day: entry.date.slice(5) === date.slice(5) ? parts.dayName : `${parts.month} ${parts.day}`,
      relative:
        entry.date === today
          ? t('date.relative.today')
          : yearDiff < 0
            ? t('pastYears.yearsAgo', { count: -yearDiff })
            : t('pastYears.yearsLater', { count: yearDiff })
    }
  }

  return (
    <section
      aria-label={t('pastYears.title')}
      className="mt-6 flex flex-col"
      data-marquee-ignore
      data-journal-past-years
    >
      <div
        className={cn(
          'flex items-center justify-between gap-4 border-t border-border pt-4 pb-2',
          !allYears && 'px-3'
        )}
      >
        <div className="flex items-baseline gap-2">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-secondary">
            {t('pastYears.title')}
          </h2>
          <span className="text-xs text-text-tertiary">
            {t('pastYears.count', { count: entries.length })}
          </span>
        </div>
        <button
          type="button"
          onClick={onToggleAllYears}
          aria-pressed={allYears}
          className="rounded-sm px-1 py-0.5 text-xs font-medium text-text-secondary transition-colors duration-150 hover:bg-muted hover:text-foreground"
        >
          {allYears ? t('pastYears.showPreviews') : t('pastYears.showAll')}
        </button>
      </div>

      {error ? (
        <p role="alert" className="px-3 py-2 text-sm text-destructive">
          {t('pastYears.loadError')}
        </p>
      ) : allYears ? (
        entries.map((entry) => (
          <FullYear
            key={entry.date}
            entry={entry}
            labels={labelsFor(entry)}
            onOpen={() => onOpenDay(entry.date)}
          />
        ))
      ) : (
        entries.map((entry) => (
          <PreviewRow
            key={entry.date}
            entry={entry}
            labels={labelsFor(entry)}
            onOpen={() => onOpenDay(entry.date)}
          />
        ))
      )}
    </section>
  )
}

function PreviewRow({
  entry,
  labels,
  onOpen
}: {
  entry: SameDayEntry
  labels: YearLabels
  onOpen: () => void
}): React.JSX.Element {
  const { t } = useT('journal')
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={t('pastYears.openDay', { date: entry.date })}
      className="flex w-full items-start gap-5 rounded-lg px-3 py-3 text-start transition-colors duration-150 hover:bg-surface"
    >
      <span className="flex w-16 shrink-0 flex-col gap-0.5">
        <span className="font-heading text-lg leading-6 font-medium text-foreground">
          {labels.year}
        </span>
        <span className="text-xs text-text-tertiary">{labels.day}</span>
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="line-clamp-2 text-sm leading-[21px] text-text-secondary">
          {entry.preview}
        </span>
        <span className="text-xs text-text-tertiary">
          {labels.relative} · {t('pastYears.words', { count: entry.wordCount })}
        </span>
      </span>
    </button>
  )
}

function FullYear({
  entry,
  labels,
  onOpen
}: {
  entry: SameDayEntry
  labels: YearLabels
  onOpen: () => void
}): React.JSX.Element {
  const { t } = useT('journal')
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)

  // The body paints after BlockNote parses the markdown, so its height is only
  // known once it settles.
  const bodyRef = useCallback((body: HTMLDivElement | null) => {
    if (!body) return undefined
    const observer = new ResizeObserver(() => {
      setOverflows(body.scrollHeight > FOLDED_MAX_HEIGHT_PX)
    })
    observer.observe(body)
    return () => observer.disconnect()
  }, [])

  const folded = overflows && !expanded

  return (
    <article className="flex items-start gap-6 border-t border-border py-6 first-of-type:border-t-0">
      <div className="flex w-24 shrink-0 flex-col gap-0.5">
        <button
          type="button"
          onClick={onOpen}
          aria-label={t('pastYears.openDay', { date: entry.date })}
          className="w-fit rounded-sm text-start font-heading text-2xl leading-7 font-medium tracking-[-0.01em] text-foreground hover:text-text-secondary"
        >
          {labels.year}
        </button>
        <span className="text-xs text-text-tertiary">{labels.day}</span>
        <span className="text-xs text-text-tertiary">{labels.relative}</span>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div
          className={cn('relative', folded && 'overflow-hidden')}
          style={folded ? { maxHeight: FOLDED_MAX_HEIGHT_PX } : undefined}
        >
          <div ref={bodyRef}>
            <CanvasNoteBody markdown={entry.content} noteId={entry.id} />
          </div>
          {folded && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-b from-transparent to-background"
            />
          )}
        </div>
        {overflows && (
          <button
            type="button"
            onClick={() => setExpanded((open) => !open)}
            aria-expanded={expanded}
            className="w-fit rounded-sm px-1 py-0.5 text-xs font-medium text-text-secondary transition-colors duration-150 hover:bg-muted hover:text-foreground"
          >
            {expanded ? t('pastYears.showLess') : t('pastYears.showFull')}
          </button>
        )}
      </div>
    </article>
  )
}
