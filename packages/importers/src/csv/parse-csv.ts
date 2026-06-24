import type { ParsedCsv } from './types.ts'

/** RFC-4180 tokenizer: handles quoted fields, embedded commas/quotes/newlines, "" escapes, CRLF. */
function tokenize(text: string): string[][] {
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
      pushRow()
      // Consume a following \n so CRLF counts as a single row terminator.
      if (text[i + 1] === '\n') i++
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
  // flush trailing field/row unless text ended exactly on a newline
  if (field.length > 0 || row.length > 0) pushRow()
  return rows
}

/**
 * Parse CSV text into headers + record rows.
 * First row = headers; blank header names become "Column N" (1-based).
 */
export function parseCsv(text: string): ParsedCsv {
  // strip BOM
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const grid = tokenize(clean)
  if (grid.length === 0) return { headers: [], rows: [] }

  const rawHeaders = grid[0]
  const headers = rawHeaders.map((h, i) => {
    const trimmed = h.trim()
    return trimmed.length > 0 ? trimmed : `Column ${i + 1}`
  })

  const rows: Record<string, string>[] = []
  for (let r = 1; r < grid.length; r++) {
    const raw = grid[r]
    // skip completely empty rows
    if (raw.every((c) => c.trim() === '')) continue
    const record: Record<string, string> = {}
    for (let c = 0; c < headers.length; c++) {
      record[headers[c]] = raw[c] ?? ''
    }
    rows.push(record)
  }

  return { headers, rows }
}
