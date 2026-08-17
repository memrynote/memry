/**
 * What a Journal tab remembers, and how it is read back.
 *
 * The DATE already lives in the tab under `date` and is written by `openTab`;
 * that key is load-bearing for sessions on disk and is not touched here. What
 * was missing is the DRILL LEVEL: month and year view were local `useState`, so
 * drilling up to a month and switching tabs dropped the user back on a day.
 *
 * The drill is stored WITHOUT the day's date on purpose. A day-level drill
 * carries no date of its own — the tab's `date` is the one truth for which day
 * is open, and duplicating it here would give one value two owners that
 * disagree the moment `openTab` writes the other one.
 */

import type { JournalViewState } from '@/components/journal'

export const JOURNAL_VIEW_STATE_KEYS = {
  /** Day, month or year — the level the breadcrumb has drilled to. */
  drill: 'journalDrill'
} as const

/** Key written by `openTab`, read by the page. Never written from here. */
export const JOURNAL_DATE_KEY = 'date'

/**
 * The persisted drill level. `day` deliberately has no `date`: see the header.
 */
export type JournalDrill =
  { type: 'day' } | { type: 'month'; year: number; month: number } | { type: 'year'; year: number }

export const DEFAULT_JOURNAL_DRILL: JournalDrill = { type: 'day' }

const isInteger = (raw: unknown): raw is number => typeof raw === 'number' && Number.isInteger(raw)

/**
 * Total, because `viewState` survives a restore and can have been written by an
 * older build. An out-of-range month is rejected rather than clamped: a clamp
 * would silently show January for a value that means nothing.
 */
export function parseJournalDrill(raw: unknown): JournalDrill | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as { type?: unknown; year?: unknown; month?: unknown }

  if (record.type === 'day') return { type: 'day' }
  if (record.type === 'year') {
    return isInteger(record.year) ? { type: 'year', year: record.year } : undefined
  }
  if (record.type === 'month') {
    if (!isInteger(record.year) || !isInteger(record.month)) return undefined
    if (record.month < 0 || record.month > 11) return undefined
    return { type: 'month', year: record.year, month: record.month }
  }
  return undefined
}

/** The date the page shows, given the tab's stored date and today's. */
export function resolveJournalDate(tabDate: string | undefined, fallback: string): string {
  return tabDate || fallback
}

/**
 * The view the page renders: the drill level, with the day's date supplied by
 * the tab rather than by the drill record.
 */
export function toJournalViewState(drill: JournalDrill, date: string): JournalViewState {
  return drill.type === 'day' ? { type: 'day', date } : drill
}

/**
 * Which scroller is on screen.
 *
 * Day view is keyed by its DATE. The three levels are different content in the
 * same element, and a day's offset means nothing on another day — but unlike a
 * note, moving to the next day does not change the tab's `entityId`, so the
 * entity stamp that normally discards a stale offset cannot see it. Putting the
 * date in the key does the same job, and the tab's bounded pane map keeps the
 * last few days rather than every day ever visited.
 */
export function journalScrollKey(view: JournalViewState): string {
  if (view.type === 'month') return 'journal-month'
  if (view.type === 'year') return 'journal-year'
  return `journal-day:${view.date}`
}
