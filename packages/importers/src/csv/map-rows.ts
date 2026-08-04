import type { ParsedCsv, CsvImportPlan, MapRowsOptions, CsvImportNote } from './types.ts'
import { IMPORT_MESSAGE_CODES, type ImportMessage } from '../messages.ts'
import { applyTemplate } from './apply-template.ts'

const TITLE_ALIASES = ['title', 'name', 'subject']

/** Find the default title column: first header matching common aliases (case-insensitive), else first header. */
function detectTitleColumn(headers: string[]): string {
  for (const alias of TITLE_ALIASES) {
    const match = headers.find((h) => h.trim().toLowerCase() === alias)
    if (match) return match
  }
  return headers[0] ?? ''
}

/**
 * Sanitize a header name to a YAML-safe property key:
 * trim, collapse internal whitespace, drop leading non-alpha chars.
 */
function sanitizeKey(header: string): string {
  let key = header.trim().replace(/\s+/g, '_')
  // drop leading characters that aren't a letter or underscore
  key = key.replace(/^[^a-zA-Z_]+/, '')
  return key || 'property'
}

const SAMPLE_MAX = 5

/** Map parsed CSV rows into an import plan. */
export function mapRows(parsed: ParsedCsv, options?: MapRowsOptions): CsvImportPlan {
  const { headers, rows } = parsed
  const folder = options?.folder ?? 'CSV'

  if (headers.length === 0) {
    return {
      notes: [],
      stats: { notes: 0, skipped: 0 },
      sampleTitles: [],
      warnings: [{ code: IMPORT_MESSAGE_CODES.csvNoHeaders, message: 'CSV file has no headers' }],
      columns: [],
      titleColumn: ''
    }
  }

  const titleColumn = options?.titleColumn ?? detectTitleColumn(headers)
  const propertyColumns = options?.propertyColumns ?? headers.filter((h) => h !== titleColumn)

  const notes: CsvImportNote[] = []
  const warnings: ImportMessage[] = []
  let skipped = 0

  for (const row of rows) {
    const title = (row[titleColumn] ?? '').trim()
    if (!title) {
      skipped++
      warnings.push({
        code: IMPORT_MESSAGE_CODES.csvEmptyTitle,
        message: `Skipped row with empty title (column "${titleColumn}")`,
        params: { column: titleColumn }
      })
      continue
    }

    const content = options?.bodyTemplate ? applyTemplate(options.bodyTemplate, row) : ''

    const properties: Record<string, string> = {}
    for (const col of propertyColumns) {
      const val = (row[col] ?? '').trim()
      if (val) {
        const key = sanitizeKey(col)
        properties[key] = val
      }
    }

    notes.push({ title, content, folder, properties })
  }

  const sampleTitles = notes.slice(0, SAMPLE_MAX).map((n) => n.title)

  return {
    notes,
    stats: { notes: notes.length, skipped },
    sampleTitles,
    warnings,
    columns: headers,
    titleColumn
  }
}
