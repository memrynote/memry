/**
 * Journal filename date formats.
 *
 * A journal (daily note) filename is derived from a date using a format string
 * built from these tokens:
 *   YYYY (4-digit year)  YY (2-digit year)
 *   MM   (2-digit month) M  (1-2 digit month)
 *   DD   (2-digit day)   D  (1-2 digit day)
 *   dddd (weekday name, `Saturday`)  ddd (short weekday name, `Sat`)
 * Everything else in the format is a literal separator (e.g. `-`, `_`, `.`, ` `).
 *
 * Weekday names are always English, never the UI locale: a filename has to parse
 * back to the same date after the user switches app language, otherwise existing
 * journal files would silently stop being recognised. Parsing rejects a stem whose
 * weekday does not match its date, so every date maps to exactly one filename.
 *
 * The functions operate on the filename STEM (no `.md` extension). Callers add
 * the folder and extension.
 */

export const DEFAULT_JOURNAL_DATE_FORMAT = 'YYYY-MM-DD'

type DateField = 'year' | 'month' | 'day' | 'weekday'

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const SHORT_WEEKDAYS = WEEKDAYS.map((name) => name.slice(0, 3))

interface TokenInfo {
  field: DateField
  pattern: string
}

const TOKEN_TABLE: Record<string, TokenInfo> = {
  YYYY: { field: 'year', pattern: '\\d{4}' },
  YY: { field: 'year', pattern: '\\d{2}' },
  MM: { field: 'month', pattern: '\\d{2}' },
  M: { field: 'month', pattern: '\\d{1,2}' },
  DD: { field: 'day', pattern: '\\d{2}' },
  D: { field: 'day', pattern: '\\d{1,2}' },
  dddd: { field: 'weekday', pattern: WEEKDAYS.join('|') },
  ddd: { field: 'weekday', pattern: SHORT_WEEKDAYS.join('|') }
}

// Longest tokens first so `YYYY` wins over `YY`, `dddd` over `ddd`, and `MM`/`DD`
// over `M`/`D`.
const TOKEN_ORDER = ['YYYY', 'YY', 'dddd', 'ddd', 'MM', 'DD', 'M', 'D']

function escapeLiteral(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

interface CompiledFormat {
  regex: RegExp
  fields: DateField[]
}

function compile(format: string): CompiledFormat {
  const parts: string[] = []
  const fields: DateField[] = []
  let i = 0

  while (i < format.length) {
    let matched = false
    for (const token of TOKEN_ORDER) {
      if (format.startsWith(token, i)) {
        const info = TOKEN_TABLE[token]
        parts.push(`(${info.pattern})`)
        fields.push(info.field)
        i += token.length
        matched = true
        break
      }
    }
    if (!matched) {
      parts.push(escapeLiteral(format[i]))
      i += 1
    }
  }

  return { regex: new RegExp(`^${parts.join('')}$`), fields }
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0')
}

/** 0 (Sunday) - 6 (Saturday). `setUTCFullYear` keeps years below 100 literal. */
function weekdayOf(year: number, month: number, day: number): number {
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  return date.getUTCDay()
}

/**
 * An anchored RegExp matching a journal filename stem (no extension) for `format`.
 * Falls back to the default format when `format` is empty.
 */
export function buildJournalRegex(format: string): RegExp {
  return compile(format || DEFAULT_JOURNAL_DATE_FORMAT).regex
}

/**
 * Parse a filename stem into a canonical ISO date (`YYYY-MM-DD`), or `null` when
 * it does not match the format or yields an invalid date.
 */
export function parseJournalDate(stem: string, format: string): string | null {
  const { regex, fields } = compile(format || DEFAULT_JOURNAL_DATE_FORMAT)
  const match = stem.match(regex)
  if (!match) return null

  let year: number | null = null
  let month = 1
  let day = 1
  let weekday: number | null = null

  for (let g = 0; g < fields.length; g++) {
    const raw = match[g + 1]
    if (fields[g] === 'weekday') {
      weekday = raw.length === 3 ? SHORT_WEEKDAYS.indexOf(raw) : WEEKDAYS.indexOf(raw)
      continue
    }
    const value = parseInt(raw, 10)
    if (Number.isNaN(value)) return null
    if (fields[g] === 'year') year = value < 100 ? 2000 + value : value
    else if (fields[g] === 'month') month = value
    else day = value
  }

  if (year === null) return null
  if (month < 1 || month > 12) return null
  if (day < 1 || day > 31) return null
  if (weekday !== null && weekday !== weekdayOf(year, month, day)) return null

  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`
}

/**
 * Render a journal filename stem (no extension) from a canonical ISO date.
 * Falls back to the default format when `format` is empty.
 */
export function formatJournalFilename(isoDate: string, format: string): string {
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
    case 'dddd':
      return WEEKDAYS[weekdayOf(year, month, day)] ?? ''
    case 'ddd':
      return SHORT_WEEKDAYS[weekdayOf(year, month, day)] ?? ''
    default:
      return token
  }
}
