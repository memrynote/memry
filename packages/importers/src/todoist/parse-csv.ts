import type { TodoistRow } from './types.ts'
import { IMPORT_MESSAGE_CODES, ImporterError } from '../messages.ts'

/** RFC-4180 tokenizer: handles quoted fields, embedded commas/quotes/newlines, "" escapes, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let inQuotes = false
  let i = 0

  const pushField = () => {
    row.push(field)
    field = ''
  }
  const pushRow = () => {
    pushField()
    rows.push(row)
    row = []
  }

  while (i < text.length) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      field += ch
      i++
      continue
    }
    if (ch === '"') {
      inQuotes = true
      i++
      continue
    }
    if (ch === ',') {
      pushField()
      i++
      continue
    }
    if (ch === '\r') {
      i++
      continue
    }
    if (ch === '\n') {
      pushRow()
      i++
      continue
    }
    field += ch
    i++
  }
  // flush a trailing field/row unless the text ended exactly on a newline
  if (field.length > 0 || row.length > 0) pushRow()
  return rows
}

const TYPES = new Set(['task', 'note', 'section', 'meta'])

/** Parse a Todoist project CSV (15 columns) into typed rows, header-mapped. */
export function parseTodoistCsv(text: string): TodoistRow[] {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const grid = parseCsv(clean)
  const headerIdx = grid.findIndex((r) => (r[0] ?? '').trim().toUpperCase() === 'TYPE')
  if (headerIdx === -1) {
    throw new ImporterError(
      IMPORT_MESSAGE_CODES.todoistHeaderNotFound,
      'Not a Todoist CSV: missing TYPE header row'
    )
  }

  const header = grid[headerIdx].map((h) => h.trim().toUpperCase())
  const col = (name: string) => header.indexOf(name)
  const idx = {
    type: col('TYPE'),
    content: col('CONTENT'),
    description: col('DESCRIPTION'),
    priority: col('PRIORITY'),
    indent: col('INDENT'),
    date: col('DATE'),
    dateLang: col('DATE_LANG'),
    timezone: col('TIMEZONE'),
    deadline: col('DEADLINE')
  }

  const get = (r: string[], i: number) => (i >= 0 ? (r[i] ?? '').trim() : '')
  const out: TodoistRow[] = []
  for (let r = headerIdx + 1; r < grid.length; r++) {
    const raw = grid[r]
    const rawType = get(raw, idx.type).toLowerCase()
    const type = (TYPES.has(rawType) ? rawType : '') as TodoistRow['type']
    if (type === '') continue // blank separator / unknown row
    out.push({
      type,
      content: idx.content >= 0 ? (raw[idx.content] ?? '') : '',
      description: idx.description >= 0 ? (raw[idx.description] ?? '') : '',
      priority: parseInt(get(raw, idx.priority), 10) || 0,
      indent: parseInt(get(raw, idx.indent), 10) || 1,
      date: get(raw, idx.date),
      dateLang: get(raw, idx.dateLang),
      timezone: get(raw, idx.timezone),
      deadline: get(raw, idx.deadline),
      rowNumber: r + 1
    })
  }
  return out
}
