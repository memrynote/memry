/**
 * Daily-note detection + date formatting for Roam pages.
 *
 * Roam daily-note pages are titled in US long form, e.g. `January 1st, 2024`
 * or `March 5th, 2024`. Their page `uid` is also an `MM-DD-YYYY` string. We
 * detect either form, normalize to an ISO date, then re-title the note using
 * the journal date format (default `YYYY-MM-DD`) so daily notes land with
 * canonical, sortable filenames.
 *
 * The formatter is a self-contained port of `@memry/storage-vault`'s
 * `formatJournalFilename` (kept inline to honor this package's zero-dependency
 * rule). It supports the `YYYY YY MM M DD D` tokens; everything else is literal.
 */

export const DEFAULT_JOURNAL_DATE_FORMAT = 'YYYY-MM-DD'

const MONTHS = [
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

const MONTH_INDEX: Record<string, number> = MONTHS.reduce<Record<string, number>>(
  (acc, name, i) => {
    acc[name.toLowerCase()] = i + 1
    return acc
  },
  {}
)

// `January 1st, 2024` / `March 22nd, 2024` — ordinal suffix is optional.
const LONG_DATE_RE = /^([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,\s*(\d{4})$/

// Roam daily-note uid form: `MM-DD-YYYY`.
const UID_DATE_RE = /^(\d{2})-(\d{2})-(\d{4})$/

const TOKEN_ORDER = ['YYYY', 'YY', 'MM', 'DD', 'M', 'D']

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0')
}

function isValidYmd(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12) return false
  if (day < 1 || day > 31) return false
  const probe = new Date(Date.UTC(year, month - 1, day))
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  )
}

function toIso(year: number, month: number, day: number): string | null {
  if (!isValidYmd(year, month, day)) return null
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`
}

/**
 * Parse a Roam page title into an ISO date (`YYYY-MM-DD`), or `null` when the
 * title is not a daily-note long-form date.
 */
export function parseDailyNoteTitle(title: string): string | null {
  const match = title.trim().match(LONG_DATE_RE)
  if (!match) return null
  const month = MONTH_INDEX[match[1].toLowerCase()]
  if (!month) return null
  const day = parseInt(match[2], 10)
  const year = parseInt(match[3], 10)
  return toIso(year, month, day)
}

/**
 * Parse a Roam page uid (`MM-DD-YYYY`) into an ISO date, or `null`.
 */
export function parseDailyNoteUid(uid: string | undefined): string | null {
  if (!uid) return null
  const match = uid.match(UID_DATE_RE)
  if (!match) return null
  const month = parseInt(match[1], 10)
  const day = parseInt(match[2], 10)
  const year = parseInt(match[3], 10)
  return toIso(year, month, day)
}

/**
 * Detect whether a page is a daily note from its title or uid, returning the
 * ISO date or `null`. Title wins over uid.
 */
export function detectDailyNote(title: string, uid: string | undefined): string | null {
  return parseDailyNoteTitle(title) ?? parseDailyNoteUid(uid)
}

function renderToken(token: string, year: number, month: number, day: number): string {
  switch (token) {
    case 'YYYY':
      return pad(year, 4)
    case 'YY':
      return pad(year % 100, 2)
    case 'MM':
      return pad(month, 2)
    case 'M':
      return String(month)
    case 'DD':
      return pad(day, 2)
    case 'D':
      return String(day)
    default:
      return token
  }
}

/**
 * Render a journal filename stem from an ISO date. Falls back to the default
 * format when `format` is empty. Mirrors `@memry/storage-vault`.
 */
export function formatJournalFilename(
  isoDate: string,
  format: string = DEFAULT_JOURNAL_DATE_FORMAT
): string {
  const [y, m, d] = isoDate.split('-').map((part) => parseInt(part, 10))
  const fmt = format || DEFAULT_JOURNAL_DATE_FORMAT
  const out: string[] = []
  let i = 0

  while (i < fmt.length) {
    let matched = false
    for (const token of TOKEN_ORDER) {
      if (fmt.startsWith(token, i)) {
        out.push(renderToken(token, y, m, d))
        i += token.length
        matched = true
        break
      }
    }
    if (!matched) {
      out.push(fmt[i])
      i += 1
    }
  }

  return out.join('')
}
