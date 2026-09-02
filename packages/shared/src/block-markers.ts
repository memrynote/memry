import {
  type BlockColors,
  applyTableCellColors,
  extractTableCellColors,
  hasNonDefaultColors,
  parseBlockColorsMarker,
  parseTableCellColorsMarker,
  serializeBlockColorsMarker,
  serializeTableCellColorsMarker
} from './block-colors'

/**
 * The block a sidecar marker describes, narrowed to the two fields a marker can
 * reach: the props a block-level marker writes into, and the content a
 * table-level one walks.
 */
export interface MarkedBlock {
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
  return match ? (match[1] as Exclude<TextAlignment, 'left'>) : null
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

function tableContent(content: unknown): TableContentLike | null {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return null
  return Array.isArray((content as TableContentLike).rows) ? (content as TableContentLike) : null
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
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null

  const widths = (parsed as { columnWidths?: unknown }).columnWidths
  if (!Array.isArray(widths)) return null
  if (!widths.every((width) => width === null || isStoredWidth(width))) return null

  return { columnWidths: widths as (number | null)[] }
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
      hasNonDefaultColors(block.props as BlockColors)
        ? serializeBlockColorsMarker(block.props as BlockColors)
        : null,
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
