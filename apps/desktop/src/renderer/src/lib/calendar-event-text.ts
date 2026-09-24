/**
 * Text helpers for the read-only event card (#2374): recurrence in words,
 * Google's conference boilerplate removed from descriptions, and links found
 * in plain text.
 */

/**
 * Google writes the Meet/phone details into the description between two
 * `-::~:~::~…::-` lines. The card shows them as a Join row, so the block is
 * noise. An unclosed block runs to the end of the text.
 */
const CONFERENCE_BLOCK = /-::~[:~]*::-[\s\S]*?(?:-::~[:~]*::-|$)/g

export function stripConferenceBoilerplate(text: string): string {
  return text
    .replace(CONFERENCE_BLOCK, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export type TextPart = { kind: 'text'; value: string } | { kind: 'link'; value: string }

const LINK = /\bhttps?:\/\/[^\s<>"']+/gi
const TRAILING_PUNCTUATION = /[.,;:!?)\]]+$/

/** Plain text split into text and http(s) links. Trailing punctuation stays text. */
export function splitLinks(text: string): TextPart[] {
  const parts: TextPart[] = []
  let cursor = 0
  for (const match of text.matchAll(LINK)) {
    const start = match.index ?? 0
    let link = match[0]
    const trailing = TRAILING_PUNCTUATION.exec(link)?.[0] ?? ''
    if (trailing) link = link.slice(0, -trailing.length)
    if (start > cursor) parts.push({ kind: 'text', value: text.slice(cursor, start) })
    parts.push({ kind: 'link', value: link })
    cursor = start + link.length
  }
  if (cursor < text.length) parts.push({ kind: 'text', value: text.slice(cursor) })
  return parts
}

const WEEKDAY_ORDER = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const
// 2024-01-01 was a Monday; used only to ask Intl for weekday names.
const MONDAY_UTC = Date.UTC(2024, 0, 1)

function parseRrule(rrule: string): Map<string, string> {
  const fields = new Map<string, string>()
  for (const part of rrule.replace(/^RRULE:/i, '').split(';')) {
    const [key, value] = part.split('=')
    if (key && value) fields.set(key.toUpperCase(), value.toUpperCase())
  }
  return fields
}

export type RecurrenceKey = 'daily' | 'weekly' | 'weeklyOn' | 'monthly' | 'yearly' | 'other'

export interface RecurrenceDescription {
  key: RecurrenceKey
  count: number
  days?: string
}

/**
 * An RRULE in words. Only rules a short sentence can say truthfully get one
 * ("every 2 weeks on Tuesday and Friday"); anything with positions or
 * ordinal weekdays falls back to the frequency, then to plain "Repeats".
 */
export function describeRecurrence(rrule: string, locale: string): RecurrenceDescription {
  const fields = parseRrule(rrule)
  const count = Math.max(1, Number.parseInt(fields.get('INTERVAL') ?? '1', 10) || 1)
  const byDay = fields.get('BYDAY')?.split(',').filter(Boolean) ?? []
  switch (fields.get('FREQ')) {
    case 'DAILY':
      return { key: 'daily', count }
    case 'WEEKLY': {
      const plain = byDay.every((day) => (WEEKDAY_ORDER as readonly string[]).includes(day))
      if (byDay.length === 0 || !plain) return { key: 'weekly', count }
      const names = new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' })
      const days = WEEKDAY_ORDER.filter((day) => byDay.includes(day)).map((day) =>
        names.format(new Date(MONDAY_UTC + WEEKDAY_ORDER.indexOf(day) * 86_400_000))
      )
      return {
        key: 'weeklyOn',
        count,
        days: new Intl.ListFormat(locale, { type: 'conjunction' }).format(days)
      }
    }
    case 'MONTHLY':
      return { key: 'monthly', count }
    case 'YEARLY':
      return { key: 'yearly', count }
    default:
      return { key: 'other', count }
  }
}
