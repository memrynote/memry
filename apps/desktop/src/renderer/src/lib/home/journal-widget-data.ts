import { replaceWikiLinks } from '@memry/shared/wiki-target'
import type { HeatmapEntry } from '../../../../preload/index.d'

export interface WeekDay {
  iso: string
  dayNum: number
  weekdayNarrow: string
  hasEntry: boolean
  isToday: boolean
}

export type RelativeDayLabel =
  { kind: 'today' } | { kind: 'yesterday' } | { kind: 'date'; text: string }

function toLocalIso(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function parseIso(iso: string): Date {
  return new Date(`${iso}T00:00:00`)
}

/** Seven days ending on `todayIso` (oldest first, today last). */
export function buildWeekDays(todayIso: string, entryDates: Set<string>, lang: string): WeekDay[] {
  const today = parseIso(todayIso)
  const days: WeekDay[] = []
  for (let offset = 6; offset >= 0; offset--) {
    const d = new Date(today)
    d.setDate(today.getDate() - offset)
    const iso = toLocalIso(d)
    days.push({
      iso,
      dayNum: d.getDate(),
      weekdayNarrow: d.toLocaleDateString(lang, { weekday: 'narrow' }),
      hasEntry: entryDates.has(iso),
      isToday: iso === todayIso
    })
  }
  return days
}

/** Dates with content, most recent first, capped at `limit`. */
export function recentEntryDates(entries: HeatmapEntry[], limit: number): string[] {
  return entries
    .filter((e) => e.level > 0)
    .map((e) => e.date)
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
    .slice(0, limit)
}

export function relativeDayLabel(iso: string, todayIso: string, lang: string): RelativeDayLabel {
  if (iso === todayIso) return { kind: 'today' }
  const yesterday = parseIso(todayIso)
  yesterday.setDate(yesterday.getDate() - 1)
  if (iso === toLocalIso(yesterday)) return { kind: 'yesterday' }
  return {
    kind: 'date',
    text: parseIso(iso).toLocaleDateString(lang, { month: 'short', day: 'numeric' })
  }
}

// ponytail: light markdown strip — drop frontmatter/markers, collapse whitespace, slice.
// Upgrade to the shared snippet util if entries need richer formatting.
export function entrySnippet(content: string, max = 140): string {
  const withoutLinks = replaceWikiLinks(
    content.replace(/^---\n[\s\S]*?\n---\n?/, '').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
  )
  const text = withoutLinks
    // The heading half went with the brackets above. Keeping it left
    // `Note#Heading`, and the `#` strip below then welded that into
    // `NoteHeading`.
    .replace(/[#>*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text
}
