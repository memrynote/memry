import type { TickTickRow } from './types'
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

const HEADER_FIRST_CELL = 'Folder Name'

function splitTags(raw: string): string[] {
  return raw
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0)
}

function bool(raw: string): boolean {
  return raw.trim().toLowerCase() === 'true'
}

function int(raw: string): number {
  const n = parseInt(raw.trim(), 10)
  return Number.isNaN(n) ? 0 : n
}

/** Parse a TickTick backup CSV (preamble + 25-column data) into typed rows. */
export function parseTickTickCsv(input: string): TickTickRow[] {
  const records = tokenizeCsv(input)
  const headerIdx = records.findIndex((r) => (r[0] ?? '').trim() === HEADER_FIRST_CELL)
  if (headerIdx === -1) {
    throw new ImporterError(
      IMPORT_MESSAGE_CODES.ticktickHeaderNotFound,
      'TickTick CSV header row ("Folder Name") not found'
    )
  }
  const headers = records[headerIdx].map((h) => h.trim())
  const col = (cells: string[], name: string): string => {
    const idx = headers.indexOf(name)
    return idx === -1 ? '' : (cells[idx] ?? '')
  }
  return records
    .slice(headerIdx + 1)
    .filter((cells) => cells.some((c) => c.length > 0))
    .map((cells) => ({
      folderName: col(cells, 'Folder Name'),
      listName: col(cells, 'List Name'),
      title: col(cells, 'Title'),
      kind: col(cells, 'Kind'),
      tags: splitTags(col(cells, 'Tags')),
      content: col(cells, 'Content'),
      isCheckList: bool(col(cells, 'Is Check list')),
      startDate: col(cells, 'Start Date'),
      dueDate: col(cells, 'Due Date'),
      reminder: col(cells, 'Reminder'),
      repeat: col(cells, 'Repeat'),
      priority: int(col(cells, 'Priority')),
      status: int(col(cells, 'Status')),
      createdTime: col(cells, 'Created Time'),
      completedTime: col(cells, 'Completed Time'),
      order: col(cells, 'Order'),
      timezone: col(cells, 'Timezone'),
      isAllDay: bool(col(cells, 'Is All Day')),
      isFloating: bool(col(cells, 'Is Floating')),
      columnName: col(cells, 'Column Name'),
      columnOrder: col(cells, 'Column Order'),
      viewMode: col(cells, 'View Mode'),
      taskId: col(cells, 'taskId'),
      parentId: col(cells, 'parentId'),
      projectKind: col(cells, 'projectKind')
    }))
}
