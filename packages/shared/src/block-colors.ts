export interface BlockColors {
  textColor?: string
  backgroundColor?: string
}

/**
 * Regex to match block color markers in markdown (full line only)
 * Format: <!-- colors:{"textColor":"red","backgroundColor":"blue"} -->
 * The marker applies to the block that immediately follows it.
 */
export const BLOCK_COLORS_LINE_REGEX = /^<!-- colors:(\{[^}]*\}) -->$/

/**
 * True when block props carry a non-default text or background color
 */
export function hasNonDefaultColors(props: BlockColors): boolean {
  return (
    (props.textColor !== undefined && props.textColor !== 'default') ||
    (props.backgroundColor !== undefined && props.backgroundColor !== 'default')
  )
}

/**
 * The non-default colors only, in a fixed key order.
 *
 * Both marker forms below serialize through this, so a block and a table cell
 * holding the same colors always produce the same JSON bytes.
 */
function pickNonDefaultColors(props: BlockColors): BlockColors {
  const colors: BlockColors = {}
  if (props.textColor !== undefined && props.textColor !== 'default') {
    colors.textColor = props.textColor
  }
  if (props.backgroundColor !== undefined && props.backgroundColor !== 'default') {
    colors.backgroundColor = props.backgroundColor
  }
  return colors
}

/**
 * Serialize non-default block colors to a markdown marker line
 */
export function serializeBlockColorsMarker(props: BlockColors): string {
  return `<!-- colors:${JSON.stringify(pickNonDefaultColors(props))} -->`
}

/**
 * Parse a block color marker line; null when the line is not a valid marker
 */
export function parseBlockColorsMarker(line: string): BlockColors | null {
  const match = line.match(BLOCK_COLORS_LINE_REGEX)
  if (!match) return null
  try {
    return JSON.parse(match[1])
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// table cell colors — one marker for the whole table, keyed by cell position
// ---------------------------------------------------------------------------

/**
 * A table's non-default cell colors, keyed `"<rowIndex>:<cellIndex>"`.
 *
 * BlockNote keeps a cell's text/background color in the cell's own props, and a
 * GFM row has nowhere to put them: `blocksToMarkdownLossy` writes `| a | b |`
 * and the color is gone on the next open. So a colored table carries a second
 * marker line, in the same position and the same shape as the block color
 * marker — immediately before the block it describes.
 *
 * Only colored cells appear, so a table nobody has colored emits no marker at
 * all and its bytes on disk are exactly what they were before this existed.
 */
export type TableCellColors = Record<string, BlockColors>

/** A whole line that is nothing but a table cell color marker. */
export const TABLE_CELL_COLORS_LINE_REGEX = /^<!-- table-colors:(\{.*\}) -->$/

interface TableCellLike {
  props?: BlockColors
}

interface TableContentLike {
  rows?: Array<{ cells?: unknown[] } | undefined>
}

/**
 * A cell's props, or null when the cell cannot hold any.
 *
 * BlockNote hands back a cell as a bare inline-content array on schemas where
 * no cell prop is in play, and only as `{ content, props }` otherwise. Both
 * shapes reach here, and only the second one has somewhere to keep a color.
 */
function cellProps(cell: unknown): BlockColors | null {
  if (!cell || typeof cell !== 'object' || Array.isArray(cell)) return null
  const props = (cell as TableCellLike).props
  return props && typeof props === 'object' ? props : null
}

function tableRows(content: unknown): TableContentLike['rows'] | null {
  const rows = (content as TableContentLike | undefined)?.rows
  return Array.isArray(rows) ? rows : null
}

/**
 * The colors of every non-default cell in a table's content, or null when the
 * block is not a table or nothing in it is colored.
 */
export function extractTableCellColors(content: unknown): TableCellColors | null {
  const rows = tableRows(content)
  if (!rows) return null

  const colors: TableCellColors = {}
  rows.forEach((row, rowIndex) => {
    const cells = row?.cells
    if (!Array.isArray(cells)) return
    cells.forEach((cell, cellIndex) => {
      const props = cellProps(cell)
      if (!props || !hasNonDefaultColors(props)) return
      colors[`${rowIndex}:${cellIndex}`] = pickNonDefaultColors(props)
    })
  })

  return Object.keys(colors).length > 0 ? colors : null
}

/** Serialize a table's cell colors to a markdown marker line. */
export function serializeTableCellColorsMarker(colors: TableCellColors): string {
  return `<!-- table-colors:${JSON.stringify(colors)} -->`
}

/** Parse a table cell color marker line; null when the line is not a valid marker. */
export function parseTableCellColorsMarker(line: string): TableCellColors | null {
  const match = line.match(TABLE_CELL_COLORS_LINE_REGEX)
  if (!match) return null
  try {
    const parsed = JSON.parse(match[1]) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as TableCellColors)
      : null
  } catch {
    return null
  }
}

/**
 * Put parsed cell colors back on a freshly parsed table's cells.
 *
 * A key that names a cell the table no longer has is skipped: the marker is a
 * projection of a document someone may have edited by hand since, and a row
 * deleted in a text editor must not throw the whole note's parse away.
 */
export function applyTableCellColors(content: unknown, colors: TableCellColors): void {
  const rows = tableRows(content)
  if (!rows) return

  for (const [key, cellColors] of Object.entries(colors)) {
    const [rowIndex, cellIndex] = key.split(':').map(Number)
    if (!Number.isInteger(rowIndex) || !Number.isInteger(cellIndex)) continue
    const cells = rows[rowIndex]?.cells
    const cell = Array.isArray(cells) ? cells[cellIndex] : undefined
    const props = cellProps(cell)
    if (!props) continue
    ;(cell as TableCellLike).props = { ...props, ...cellColors }
  }
}
