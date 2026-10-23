import {
  hashSectionBody,
  readMarkedSection,
  SECTION_FORMAT_VERSION,
  type SectionRead
} from './section.ts'
import { collapseWhitespace, formatDay, toIsoInstant } from './text.ts'

/**
 * The journal day section (#3476, D17): the books a day's highlights belong to,
 * with a count each, linked to the book notes. The markers are a vault format
 * that older and newer builds read, so `readwise-day` and the `v1` token are
 * part of the contract. The text is English whatever the app language (D15).
 */

export const DAY_SECTION_START = '<!-- readwise-day:start -->'

export interface DayEndMarker {
  /** Hash of the section body as Memry wrote it. */
  hash: string
}

const DAY_END_LINE = /^<!-- readwise-day:end (.*) -->$/
const DAY_END_FIELDS = /^v(\d+) hash=([0-9a-f]+)$/

const DAY_SPEC = {
  start: DAY_SECTION_START,
  startPrefix: '<!-- readwise-day:start',
  endLine: DAY_END_LINE,
  endPrefix: '<!-- readwise-day:end',
  parseEnd(fieldsText: string): DayEndMarker | null {
    const fields = DAY_END_FIELDS.exec(fieldsText)
    return fields && Number(fields[1]) === SECTION_FORMAT_VERSION ? { hash: fields[2] } : null
  }
}

/** Find the day section in a journal entry's body, with the rules of `readSection`. */
export function readDaySection(body: string): SectionRead<DayEndMarker> {
  return readMarkedSection(body, DAY_SPEC)
}

export interface JournalBook {
  /** The book note's current title. */
  title: string
  /** Highlights to list: the day's live highlights, or the new arrivals for an append. */
  count: number
  /** ISO instant of the book's first highlight of the day, which orders the books. */
  first: string
}

export interface HighlightDates {
  highlightedAt?: string | null
  createdAt?: string | null
}

/** The day a highlight belongs to: the local date of `highlightedAt`, or of `createdAt` when it is missing. */
export function highlightDay(dates: HighlightDates, timeZone: string): string | null {
  return formatDay(toIsoInstant(dates.highlightedAt) ?? toIsoInstant(dates.createdAt), timeZone)
}

/** The sort key the index uses for `JournalBook.first`. */
export function highlightInstant(dates: HighlightDates): string | null {
  return toIsoInstant(dates.highlightedAt) ?? toIsoInstant(dates.createdAt)
}

function line({ title, count }: JournalBook): string {
  // `]` and `|` cannot sit in a wiki-link target.
  // `<!--` and `-->` would make the line read as a marker, so the section could never be re-rendered.
  const target = collapseWhitespace(title.replace(/[\]|[]|<!--|-->/g, ' ')) || 'Untitled'
  return `- [[${target}]]: ${count} highlight${count === 1 ? '' : 's'}`
}

function ordered(books: readonly JournalBook[]): JournalBook[] {
  return books
    .filter((book) => book.count > 0)
    .sort((a, b) => {
      if (a.first !== b.first) return a.first < b.first ? -1 : 1
      return a.title === b.title ? 0 : a.title < b.title ? -1 : 1
    })
}

/** The sealed section for a day: every book with its count, ordered by its first highlight of the day. Empty when no book has a highlight. */
export function planJournalDay(books: readonly JournalBook[]): string {
  const lines = ordered(books).map(line)
  if (lines.length === 0) return ''
  const body = `### Readwise\n\n${lines.join('\n')}`
  return `${DAY_SECTION_START}\n\n${body}\n\n<!-- readwise-day:end v${SECTION_FORMAT_VERSION} hash=${hashSectionBody(body)} -->`
}

/** The lines a touched section receives: one per book with new arrivals. Empty when there are none. */
export function planJournalAppend(books: readonly JournalBook[]): string {
  return ordered(books).map(line).join('\n')
}

export type JournalWrite =
  /** The entry has no section, or no entry exists: `appendToJournalEntry(date, markdown)`. */
  | { kind: 'append'; markdown: string }
  /** The entry's new body, for `updateJournalEntry`. */
  | { kind: 'update'; content: string }
  | { kind: 'unchanged' }

const LIST_ITEM = /^\s*(?:[-*+]|\d{1,9}[.)])\s/

/** `lines` placed before `body[at..]`, after the text before it, as one more list item or a new block. */
function insertLines(body: string, at: number, lines: string): string {
  const before = body.slice(0, at).trimEnd()
  const lastLine = before.slice(before.lastIndexOf('\n') + 1)
  const gap = before === '' ? '' : LIST_ITEM.test(lastLine) ? '\n' : '\n\n'
  return `${before}${gap}${lines}\n\n${body.slice(at)}`
}

/**
 * What an entry needs for a day (D17, the rules of D5). `body` is the entry's
 * content, or null when there is no entry. `day` lists every book with that
 * day's highlights, and `arrivals` the books with new arrivals and how many.
 *
 * - No section: the whole section goes at the end.
 * - Untouched section (the hash matches): re-rendered from `day`, and
 *   `unchanged` when the bytes are the same.
 * - Touched section, or a damaged one: never rewritten. One line per book in
 *   `arrivals` goes before the end marker, or at the end without one.
 * - An end marker of a version this build cannot read: left alone.
 */
export function planJournalWrite(
  body: string | null,
  day: readonly JournalBook[],
  arrivals: readonly JournalBook[]
): JournalWrite {
  const section = planJournalDay(day)
  if (section === '') return { kind: 'unchanged' }
  if (body === null) return { kind: 'append', markdown: section }

  const read = readDaySection(body)
  if (read.found && read.untouched) {
    const content = body.slice(0, read.range.start) + section + body.slice(read.range.end)
    return content === body ? { kind: 'unchanged' } : { kind: 'update', content }
  }

  const lines = planJournalAppend(arrivals)
  if (read.found) {
    if (read.marker === null || lines === '') return { kind: 'unchanged' }
    const endLine = body.lastIndexOf('\n', read.range.end - 1) + 1
    return { kind: 'update', content: insertLines(body, endLine, lines) }
  }
  if (read.end) {
    if (read.end.marker === null || lines === '') return { kind: 'unchanged' }
    return { kind: 'update', content: insertLines(body, read.end.range.start, lines) }
  }
  // No marker at all: the user has no section for this day yet (or removed it).
  if (read.problem === 'no-start') return { kind: 'append', markdown: section }
  if (lines === '') return { kind: 'unchanged' }
  return { kind: 'update', content: `${body.trimEnd()}\n\n${lines}` }
}
