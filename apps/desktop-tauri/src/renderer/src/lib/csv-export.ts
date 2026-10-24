/**
 * CSV export for folder-view notes.
 *
 * Builds a CSV string from notes + the currently-visible columns, then
 * triggers a browser download (Electron's Chromium renderer handles the save).
 */

import { evaluateFormula } from './expression-evaluator'
import { stringifyUnknown } from './stringify-unknown'
import type { ColumnConfig, NoteWithProperties } from '@memry/contracts/folder-view-api'

/** RFC 4180 quoting: wrap in quotes and double internal quotes when needed. */
function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

function columnHeader(col: ColumnConfig): string {
  if (col.displayName) return col.displayName
  if (col.id.startsWith('formula.')) return col.id.slice(8)
  return col.id
}

function columnValue(
  note: NoteWithProperties,
  columnId: string,
  formulas: Record<string, string>
): string {
  switch (columnId) {
    case 'title':
      return note.title
    case 'folder':
      return note.folder
    case 'tags':
      return note.tags.join('; ')
    case 'created':
      return note.created
    case 'modified':
      return note.modified
    case 'wordCount':
      return String(note.wordCount)
    default: {
      if (columnId.startsWith('formula.')) {
        const expr = formulas[columnId.slice(8)]
        if (!expr) return ''
        const result = evaluateFormula(expr, note)
        return result === null || result === undefined ? '' : stringifyUnknown(result)
      }
      const value = note.properties[columnId]
      return value === null || value === undefined ? '' : stringifyUnknown(value)
    }
  }
}

/** Serialize notes to a CSV string using the given visible columns. */
export function notesToCsv(
  notes: NoteWithProperties[],
  columns: ColumnConfig[],
  formulas: Record<string, string> = {}
): string {
  const header = columns.map((c) => csvCell(columnHeader(c))).join(',')
  const rows = notes.map((note) =>
    columns.map((c) => csvCell(columnValue(note, c.id, formulas))).join(',')
  )
  return [header, ...rows].join('\r\n')
}

/** UTF-8 BOM so Excel reads non-ASCII correctly. */
const BOM = '﻿'

/** Trigger a download of the given CSV content (BOM-prefixed for Excel UTF-8). */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([BOM + csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}
