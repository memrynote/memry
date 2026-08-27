import type { NoteHit, TaskHit } from './repo'

// Month names are literals rather than `toLocaleDateString` output. Hermes is
// built without ICU on some React Native configurations, and that call then
// returns another format or throws outright.
const SHORT_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec'
]

const LONG_MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
]

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

export function formatEditedAt(updatedAt: number, now: number): string {
  const elapsed = now - updatedAt
  if (elapsed < 60_000) return 'just now'
  if (elapsed < 3_600_000) return `edited ${Math.floor(elapsed / 60_000)} m ago`
  if (elapsed < 86_400_000) return `edited ${Math.floor(elapsed / 3_600_000)} h ago`

  const edited = new Date(updatedAt)
  const dayMonth = formatDayMonth(edited.getDate(), edited.getMonth())
  const year = edited.getFullYear()
  return year === new Date(now).getFullYear() ? dayMonth : `${dayMonth} ${year}`
}

// The LOCAL calendar day, not `toISOString`'s UTC day, so a task due tonight
// still reads as due today either side of midnight. Every caller that needs
// "today" takes it from here, because a second copy of this rule is a second
// place for the UTC bug to come back.
export function localIsoDay(at: number): string {
  const d = new Date(at)
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
}

export function formatJournalDate(date: string): string {
  const parsed = parseIsoDate(date)
  if (!parsed) return date
  return `${parsed.day} ${LONG_MONTHS[parsed.month - 1]}`
}

export function noteSubtitle(hit: NoteHit, now: number): string {
  const edited = formatEditedAt(hit.updatedAt, now)
  return hit.folderPath ? `${hit.folderPath} · ${edited}` : edited
}

export function taskSubtitle(hit: TaskHit, todayIso: string): string {
  const parts = [dueSegment(hit, todayIso), hit.projectName]
  return parts.filter((part): part is string => !!part).join(' · ')
}

export function snippetAround(content: string, query: string, width = 64): string | null {
  const text = content.replace(/\s+/g, ' ').trim()
  const needle = query.trim()
  const index = text.toLowerCase().indexOf(needle.toLowerCase())
  if (index === -1) return null

  const lead = Math.max(0, Math.floor((width - needle.length) / 2))
  const start = Math.max(0, index - lead)
  const end = Math.min(text.length, start + width)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  return `${prefix}${text.slice(start, end)}${suffix}`
}

// `YYYY-MM-DD` strings order correctly under `<` because every field is fixed
// width and written most-significant first, so no parsing is needed to compare
// two of them.
function dueSegment(hit: TaskHit, todayIso: string): string | null {
  if (hit.completedAt) return 'Done'
  if (!hit.dueDate) return null
  if (hit.dueDate < todayIso) return 'Overdue'
  if (hit.dueDate === todayIso) return 'Due today'
  if (hit.dueDate === nextDay(todayIso)) return 'Due tomorrow'

  const parsed = parseIsoDate(hit.dueDate)
  return parsed ? `Due ${formatDayMonth(parsed.day, parsed.month - 1)}` : `Due ${hit.dueDate}`
}

function nextDay(iso: string): string | null {
  const parsed = parseIsoDate(iso)
  if (!parsed) return null
  const next = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day) + 86_400_000)
  const month = String(next.getUTCMonth() + 1).padStart(2, '0')
  const day = String(next.getUTCDate()).padStart(2, '0')
  return `${next.getUTCFullYear()}-${month}-${day}`
}

function formatDayMonth(day: number, monthIndex: number): string {
  return `${day} ${SHORT_MONTHS[monthIndex]}`
}

// `new Date('2026-08-26')` is read as UTC midnight, so it renders as the 25th
// everywhere west of Greenwich. The digits are taken from the string instead.
function parseIsoDate(value: string): { year: number; month: number; day: number } | null {
  const match = ISO_DATE.exec(value)
  if (!match) return null
  const month = Number(match[2])
  if (month < 1 || month > 12) return null
  return { year: Number(match[1]), month, day: Number(match[3]) }
}
