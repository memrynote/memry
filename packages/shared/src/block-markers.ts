import {
  applyTableCellColors,
  extractTableCellColors,
  hasNonDefaultColors,
  parseBlockColorsMarker,
  parseTableCellColorsMarker,
  serializeBlockColorsMarker,
  serializeTableCellColorsMarker
} from './block-colors'
import { isObject, isRecord } from './is-record'
import { applyLinkCard, parseLinkCardMarker, serializeLinkCardMarker } from './link-card-marker'

/**
 * The block a sidecar marker describes, narrowed to the two fields a marker can
 * reach: the props a block-level marker writes into, and the content a
 * table-level one walks.
 */
export interface MarkedBlock {
  type?: string
  props: Record<string, unknown>
  content: unknown
}

/** What a parsed marker line does to the block that follows it. */
export type SidecarPatch = (block: MarkedBlock) => void

export type TextAlignment = 'left' | 'center' | 'right' | 'justify'

/** A whole line that is nothing but a text alignment marker. */
export const BLOCK_ALIGN_LINE_REGEX = /^<!-- align:(center|right|justify) -->$/

/**
 * The alignment marker a block needs, or null when its alignment is the default
 * (or absent, or a value outside the enum).
 */
export function serializeBlockAlignMarker(props: { textAlignment?: unknown }): string | null {
  if (typeof props.textAlignment !== 'string') return null
  const marker = `<!-- align:${props.textAlignment} -->`
  return BLOCK_ALIGN_LINE_REGEX.test(marker) ? marker : null
}

/** Parse a text alignment marker line; null when the line is not one. */
export function parseBlockAlignMarker(line: string): Exclude<TextAlignment, 'left'> | null {
  const match = line.match(BLOCK_ALIGN_LINE_REGEX)
  const alignment = match?.[1]
  return isNonDefaultAlignment(alignment) ? alignment : null
}

/**
 * A table's non-default cell alignments, keyed `"<rowIndex>:<cellIndex>"`.
 *
 * BlockNote keeps a cell's alignment in the cell's own props, and a GFM row has
 * nowhere to put it per cell, so an aligned table carries a marker line shaped
 * like the `table-colors` one. Only non-left cells appear, so a table nobody
 * has aligned writes no marker and keeps its bytes.
 */
export type TableCellAlignments = Record<string, Exclude<TextAlignment, 'left'>>

/** A whole line that is nothing but a table cell alignment marker. */
export const TABLE_ALIGN_LINE_REGEX = /^<!-- table-align:(\{.*\}) -->$/

const NON_DEFAULT_ALIGNMENTS = new Set<unknown>(['center', 'right', 'justify'])

function isNonDefaultAlignment(value: unknown): value is Exclude<TextAlignment, 'left'> {
  return NON_DEFAULT_ALIGNMENTS.has(value)
}

/** The alignment of every non-left cell, or null when there is none. */
export function extractTableCellAlignments(content: unknown): TableCellAlignments | null {
  const rows = tableContent(content)?.rows
  if (!rows) return null

  const alignments: TableCellAlignments = {}
  rows.forEach((row, rowIndex) => {
    row?.cells?.forEach((cell, cellIndex) => {
      const alignment =
        isRecord(cell) && isObject(cell.props) ? cell.props.textAlignment : undefined
      if (isNonDefaultAlignment(alignment)) {
        alignments[`${rowIndex}:${cellIndex}`] = alignment
      }
    })
  })
  return Object.keys(alignments).length > 0 ? alignments : null
}

export function serializeTableCellAlignmentsMarker(alignments: TableCellAlignments): string {
  return `<!-- table-align:${JSON.stringify(alignments)} -->`
}

/** Parse a table cell alignment marker; null unless every value is a non-left alignment. */
export function parseTableCellAlignmentsMarker(line: string): TableCellAlignments | null {
  const match = line.match(TABLE_ALIGN_LINE_REGEX)
  if (!match) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(match[1])
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const alignments: [string, Exclude<TextAlignment, 'left'>][] = []
  for (const [key, value] of Object.entries(parsed)) {
    if (!isNonDefaultAlignment(value)) return null
    alignments.push([key, value])
  }
  return Object.fromEntries(alignments)
}

/**
 * Put parsed cell alignments back on a freshly parsed table. A key naming a
 * cell the table no longer has (a row deleted in another editor) is skipped.
 */
export function applyTableCellAlignments(content: unknown, alignments: TableCellAlignments): void {
  const rows = tableContent(content)?.rows
  if (!rows) return

  for (const [key, textAlignment] of Object.entries(alignments)) {
    const [rowIndex, cellIndex] = key.split(':').map(Number)
    if (!Number.isInteger(rowIndex) || !Number.isInteger(cellIndex)) continue
    const cell = rows[rowIndex]?.cells?.[cellIndex]
    if (!isRecord(cell) || !isObject(cell.props)) continue
    cell.props = { ...cell.props, textAlignment }
  }
}

/**
 * The widths of a table's columns, one slot per column, null where the column
 * is whatever width the editor picks for it.
 *
 * BlockNote keeps a dragged column width in the table content's `columnWidths`,
 * and GFM has nowhere to put it: `blocksToMarkdownLossy` writes `| a | b |` and
 * the width is gone on the next open. So a resized table carries a marker line
 * in the same position as the cell colour one. There is no row height half:
 * BlockNote's table content has `columnWidths`, `headerRows` and `headerCols`
 * and nothing about rows' sizes.
 */
export interface TableLayout {
  columnWidths: (number | null)[]
}

/** A whole line that is nothing but a table layout marker. */
export const TABLE_LAYOUT_LINE_REGEX = /^<!-- table-layout:(\{.*\}) -->$/

interface TableContentLike {
  columnWidths?: unknown
  rows?: Array<{ cells?: unknown[] } | undefined>
}

function isTableContentLike(content: unknown): content is TableContentLike {
  return isRecord(content) && Array.isArray(content.rows)
}

function tableContent(content: unknown): TableContentLike | null {
  return isTableContentLike(content) ? content : null
}

function isStoredWidth(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * A table's column widths, or null when the block is not a table or nobody has
 * resized a column, so a table on disk today keeps its exact bytes.
 */
export function extractTableLayout(content: unknown): TableLayout | null {
  const table = tableContent(content)
  if (!table || !Array.isArray(table.columnWidths)) return null

  const columnWidths = table.columnWidths.map((width) => (isStoredWidth(width) ? width : null))
  return columnWidths.some((width) => width !== null) ? { columnWidths } : null
}

/** Serialize a table's column widths to a markdown marker line. */
export function serializeTableLayoutMarker(layout: TableLayout): string {
  return `<!-- table-layout:${JSON.stringify({ columnWidths: layout.columnWidths })} -->`
}

/** Parse a table layout marker line; null when the line is not a valid marker. */
export function parseTableLayoutMarker(line: string): TableLayout | null {
  const match = line.match(TABLE_LAYOUT_LINE_REGEX)
  if (!match) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(match[1])
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null

  const widths = parsed.columnWidths
  if (!Array.isArray(widths)) return null
  if (!widths.every((width): width is number | null => width === null || isStoredWidth(width))) {
    return null
  }

  return { columnWidths: widths }
}

/**
 * Put parsed column widths back on a freshly parsed table.
 *
 * The column count is the table's own, not the marker's: somebody may have
 * added or removed a column in a text editor since, and a marker that no longer
 * fits degrades to a pad or a truncate rather than throwing the note's parse
 * away. A null slot keeps whatever width the parser gave that column.
 */
export function applyTableLayout(content: unknown, layout: TableLayout): void {
  const table = tableContent(content)
  if (!table) return

  const parsed = Array.isArray(table.columnWidths) ? table.columnWidths : null
  const columnCount = parsed ? parsed.length : (table.rows?.[0]?.cells?.length ?? 0)
  if (columnCount === 0) return

  table.columnWidths = Array.from({ length: columnCount }, (_unused, column) => {
    const stored = layout.columnWidths[column]
    return isStoredWidth(stored) ? stored : parsed?.[column]
  })
}

interface SidecarMarker {
  write(block: MarkedBlock): string | null
  read(line: string): SidecarPatch | null
}

const MARKERS_IN_DISK_ORDER: readonly SidecarMarker[] = [
  {
    write: (block) =>
      hasNonDefaultColors(block.props) ? serializeBlockColorsMarker(block.props) : null,
    read: (line) => {
      const colors = parseBlockColorsMarker(line)
      if (!colors) return null
      return (block) => {
        block.props = { ...block.props, ...colors }
      }
    }
  },
  {
    write: (block) => {
      const cellColors = extractTableCellColors(block.content)
      return cellColors ? serializeTableCellColorsMarker(cellColors) : null
    },
    read: (line) => {
      const cellColors = parseTableCellColorsMarker(line)
      if (!cellColors) return null
      return (block) => applyTableCellColors(block.content, cellColors)
    }
  },
  {
    write: (block) => {
      const alignments = extractTableCellAlignments(block.content)
      return alignments ? serializeTableCellAlignmentsMarker(alignments) : null
    },
    read: (line) => {
      const alignments = parseTableCellAlignmentsMarker(line)
      if (!alignments) return null
      return (block) => applyTableCellAlignments(block.content, alignments)
    }
  },
  {
    write: (block) => serializeBlockAlignMarker(block.props),
    read: (line) => {
      const alignment = parseBlockAlignMarker(line)
      if (!alignment) return null
      return (block) => {
        block.props = { ...block.props, textAlignment: alignment }
      }
    }
  },
  {
    write: (block) => {
      const layout = extractTableLayout(block.content)
      return layout ? serializeTableLayoutMarker(layout) : null
    },
    read: (line) => {
      const layout = parseTableLayoutMarker(line)
      if (!layout) return null
      return (block) => applyTableLayout(block.content, layout)
    }
  },
  {
    write: serializeLinkCardMarker,
    read: (line) => {
      const display = parseLinkCardMarker(line)
      if (!display) return null
      return (block) => applyLinkCard(block, display)
    }
  }
]

/**
 * The marker lines a block needs in front of it, in on-disk order; empty for a
 * block in every default state.
 */
export function sidecarMarkerLines(block: MarkedBlock): string[] {
  const lines: string[] = []
  for (const marker of MARKERS_IN_DISK_ORDER) {
    const line = marker.write(block)
    if (line !== null) lines.push(line)
  }
  return lines
}

/** The patch `line` applies to the block after it; null leaves the line alone. */
export function parseSidecarMarkerLine(line: string): SidecarPatch | null {
  for (const marker of MARKERS_IN_DISK_ORDER) {
    const patch = marker.read(line)
    if (patch) return patch
  }
  return null
}
