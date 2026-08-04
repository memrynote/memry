import type { RaindropRow } from './types'
import { IMPORT_MESSAGE_CODES, ImporterError } from '../messages'

/** RFC-4180 tokenizer; strips a leading BOM. Handles quoted commas/newlines + "" escapes. */
export function tokenizeCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input
  const records: string[][] = []
  let field = ''
  let record: string[] = []
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += c
      }
      continue
    }
    if (c === '"') {
      inQuotes = true
      continue
    }
    if (c === ',') {
      record.push(field)
      field = ''
      continue
    }
    if (c === '\r') continue
    if (c === '\n') {
      record.push(field)
      records.push(record)
      field = ''
      record = []
      continue
    }
    field += c
  }
  if (field.length > 0 || record.length > 0) {
    record.push(field)
    records.push(record)
  }
  return records
}

/** Split a Raindrop tags cell (comma-separated) into trimmed, lowercased tags. */
function splitTags(raw: string): string[] {
  return raw
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0)
}

function bool(raw: string): boolean {
  return raw.trim().toLowerCase() === 'true'
}

/** Parse a Raindrop.io CSV export (header row first) into typed rows. */
export function parseRaindropCsv(input: string): RaindropRow[] {
  const records = tokenizeCsv(input)
  if (records.length === 0) {
    throw new ImporterError(IMPORT_MESSAGE_CODES.raindropCsvEmpty, 'Raindrop CSV is empty')
  }
  const headers = records[0].map((h) => h.trim())
  if (!headers.includes('url')) {
    throw new ImporterError(
      IMPORT_MESSAGE_CODES.raindropHeaderNotFound,
      'Raindrop CSV header row ("url" column) not found'
    )
  }
  const col = (cells: string[], name: string): string => {
    const idx = headers.indexOf(name)
    return idx === -1 ? '' : (cells[idx] ?? '')
  }
  return records
    .slice(1)
    .filter((cells) => cells.some((c) => c.length > 0))
    .map((cells) => ({
      id: col(cells, 'id'),
      title: col(cells, 'title'),
      note: col(cells, 'note'),
      excerpt: col(cells, 'excerpt'),
      url: col(cells, 'url'),
      folder: col(cells, 'folder'),
      tags: splitTags(col(cells, 'tags')),
      created: col(cells, 'created'),
      cover: col(cells, 'cover'),
      highlights: col(cells, 'highlights'),
      favorite: bool(col(cells, 'favorite'))
    }))
}
