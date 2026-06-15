/**
 * Obsidian-style journal filename date formats.
 *
 * A journal (daily note) filename is derived from a date using a format string
 * built from these tokens:
 *   YYYY (4-digit year)  YY (2-digit year)
 *   MM   (2-digit month) M  (1-2 digit month)
 *   DD   (2-digit day)   D  (1-2 digit day)
 * Everything else in the format is a literal separator (e.g. `-`, `_`, `.`, ` `).
 *
 * The functions operate on the filename STEM (no `.md` extension). Callers add
 * the folder and extension.
 */

export const DEFAULT_JOURNAL_DATE_FORMAT = 'YYYY-MM-DD'

type DateField = 'year' | 'month' | 'day'

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
  D: { field: 'day', pattern: '\\d{1,2}' }
}

// Longest tokens first so `YYYY` wins over `YY` and `MM`/`DD` over `M`/`D`.
const TOKEN_ORDER = ['YYYY', 'YY', 'MM', 'DD', 'M', 'D']

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

  for (let g = 0; g < fields.length; g++) {
    const value = parseInt(match[g + 1], 10)
    if (Number.isNaN(value)) return null
    if (fields[g] === 'year') year = value < 100 ? 2000 + value : value
    else if (fields[g] === 'month') month = value
    else day = value
  }

  if (year === null) return null
  if (month < 1 || month > 12) return null
  if (day < 1 || day > 31) return null

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
    default:
      return token
  }
}
