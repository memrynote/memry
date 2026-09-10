/**
 * Table editing on a touch surface (#2101).
 *
 * Desktop reaches a table's rows and columns through hover nubs on the cell
 * borders (`table-border-handles.tsx`) and a `Mod-Shift-Enter` menu. Neither
 * survives the trip to a phone: there is no hover, and BlockNote's own
 * `TableHandlesExtension` aims every mutation through a `tablePos` that only
 * its `mousemove` listener ever writes. So the structure operations here are
 * pure transforms over the block's `tableContent`, applied with
 * `editor.updateBlock` — the same shape BlockNote reads and writes, so a table
 * edited on the phone is byte-identical to one edited on the desktop.
 *
 * The one thing that shape cannot express safely is a MERGED cell: row and
 * column indices stop matching the visual grid the moment a cell spans two of
 * them, and prosemirror-tables is the only code that carries the occupancy
 * grid needed to fix that up. Mobile cannot create a merge, so rather than
 * corrupt a table a desktop user merged, `hasMergedCells` locks the structure
 * actions and the panel says so.
 */

import type { TableStructureOp } from '@memry/contracts/webview-bridge'

/** The two node names BlockNote gives a table cell — a header cell is its own type. */
const TABLE_CELL_NODES = new Set(['tableCell', 'tableHeader'])

interface PasteContext {
  defaultPasteHandler: (options?: {
    prioritizeMarkdownOverHTML?: boolean
    plainTextAsMarkdown?: boolean
  }) => boolean | undefined
}

/** The narrow slice of the editor these helpers need, so they stay testable. */
export interface TableEditorSurface {
  transact<T>(cb: (tr: { selection: { $from: ResolvedLike } }) => T): T
}

interface ResolvedLike {
  depth: number
  node(depth: number): { type: { name: string } }
  index(depth: number): number
}

export interface TableCursor {
  rowIndex: number
  colIndex: number
}

/**
 * Where the caret sits inside a table, in plain row/column indices.
 *
 * Read off the resolved position rather than the DOM: a `td` found by walking
 * up from the selection anchor is the same cell right up until the selection
 * is not in the document the DOM shows.
 */
export function readTableCursor(editor: TableEditorSurface): TableCursor | null {
  try {
    return editor.transact((tr) => {
      const { $from } = tr.selection
      for (let depth = $from.depth; depth > 1; depth--) {
        if (!TABLE_CELL_NODES.has($from.node(depth).type.name)) continue
        return { colIndex: $from.index(depth - 1), rowIndex: $from.index(depth - 2) }
      }
      return null
    })
  } catch {
    // No editor view yet, or a selection shape with no resolved position.
    return null
  }
}

export function isSelectionInTableCell(editor: TableEditorSurface): boolean {
  return readTableCursor(editor) !== null
}

/**
 * Keep a paste into a cell inline (#1641, desktop's `table-cell-paste.ts`).
 *
 * BlockNote reads `text/plain` as markdown. A cell holds inline content only,
 * so text that merely LOOKS like a markdown table (`| a | b |`) is parsed into
 * a real table and prosemirror-tables splices its cells over the row the
 * cursor is in — the cell's own text is gone and columns appear that nobody
 * asked for. Both flags gate that reading: one sniffs the text for markdown,
 * the other is the fallback when `text/plain` is the only flavour. Richer
 * flavours (`blocknote/html`, `text/html`) are untouched and still paste as
 * structure.
 */
export function handleCellPaste(
  editor: TableEditorSurface,
  { defaultPasteHandler }: PasteContext
): boolean | undefined {
  if (!isSelectionInTableCell(editor)) return defaultPasteHandler()
  return defaultPasteHandler({ prioritizeMarkdownOverHTML: false, plainTextAsMarkdown: false })
}

/* ------------------------------------------------------------------ */
/* Structure operations                                                */
/* ------------------------------------------------------------------ */

interface TableCellLike {
  type: 'tableCell'
  content: unknown
  props?: Record<string, unknown>
}

export interface TableRowLike {
  cells: unknown[]
}

export interface TableContentLike {
  type: 'tableContent'
  columnWidths?: (number | undefined)[]
  headerRows?: number
  headerCols?: number
  rows: TableRowLike[]
}

function isCellObject(cell: unknown): cell is TableCellLike {
  return typeof cell === 'object' && cell !== null && (cell as TableCellLike).type === 'tableCell'
}

function span(cell: unknown, prop: 'colspan' | 'rowspan'): number {
  if (!isCellObject(cell)) return 1
  const value = Number(cell.props?.[prop] ?? 1)
  return Number.isFinite(value) && value > 0 ? value : 1
}

export function hasMergedCells(content: TableContentLike): boolean {
  return content.rows.some((row) =>
    row.cells.some((cell) => span(cell, 'colspan') > 1 || span(cell, 'rowspan') > 1)
  )
}

export function columnCount(content: TableContentLike): number {
  return content.rows.reduce((widest, row) => Math.max(widest, row.cells.length), 0)
}

/**
 * A blank cell in the same shape its neighbour uses.
 *
 * BlockNote accepts both the `tableCell` object form and the legacy bare
 * inline-content array, and a table written by an older client can still be in
 * the second one. Mixing the two inside one table is what makes a row come
 * back with no props at all, so the sample decides.
 */
function emptyCell(sample: unknown): unknown {
  if (!isCellObject(sample)) return []
  return { type: 'tableCell', content: [], props: { ...sample.props, colspan: 1, rowspan: 1 } }
}

function headerRowCount(content: TableContentLike): number {
  const value = Number(content.headerRows ?? 0)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function moved<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item as T)
  return next
}

/**
 * Apply one structure operation, or return `null` when it is not allowed.
 *
 * `null` is a first-class answer rather than a thrown error: the toolbar asks
 * the same question to decide whether to draw the button at all, so the two
 * can never disagree about what a table permits.
 */
export function applyTableStructureOp(
  content: TableContentLike,
  at: TableCursor,
  op: TableStructureOp
): TableContentLike | null {
  if (hasMergedCells(content)) return null

  const rows = content.rows
  const columns = columnCount(content)
  const headers = headerRowCount(content)
  if (at.rowIndex < 0 || at.rowIndex >= rows.length) return null
  if (at.colIndex < 0 || at.colIndex >= columns) return null

  switch (op.kind) {
    case 'insert-row': {
      const sampleRow = rows[at.rowIndex]
      const blank = {
        cells: Array.from({ length: columns }, (_, index) =>
          emptyCell(sampleRow?.cells[index] ?? sampleRow?.cells[0])
        )
      }
      // Clamped below the header band: the GFM storage format cannot express a
      // second header row, so a row inserted "above" the header goes under it.
      const index = Math.max(headers, op.side === 'above' ? at.rowIndex : at.rowIndex + 1)
      const next = [...rows]
      next.splice(index, 0, blank)
      return { ...content, rows: next }
    }

    case 'insert-column': {
      const index = op.side === 'before' ? at.colIndex : at.colIndex + 1
      const next = rows.map((row) => {
        const cells = [...row.cells]
        cells.splice(index, 0, emptyCell(row.cells[at.colIndex] ?? row.cells[0]))
        return { ...row, cells }
      })
      return { ...content, rows: next, columnWidths: insertWidth(content.columnWidths, index) }
    }

    case 'delete-row': {
      // The header row is structural, not content: deleting it is how a table
      // stops round-tripping through the vault's markdown.
      if (at.rowIndex < headers) return null
      if (rows.length - headers <= 1) return null
      return { ...content, rows: rows.filter((_, index) => index !== at.rowIndex) }
    }

    case 'delete-column': {
      if (columns <= 1) return null
      const next = rows.map((row) => ({
        ...row,
        cells: row.cells.filter((_, index) => index !== at.colIndex)
      }))
      return {
        ...content,
        rows: next,
        columnWidths: content.columnWidths?.filter((_, index) => index !== at.colIndex)
      }
    }

    case 'move-row': {
      const to = op.direction === 'up' ? at.rowIndex - 1 : at.rowIndex + 1
      // Both ends stay inside the body: a body row swapped into the header band
      // would silently become the header.
      if (at.rowIndex < headers || to < headers || to >= rows.length) return null
      return { ...content, rows: moved(rows, at.rowIndex, to) }
    }

    case 'move-column': {
      const to = op.direction === 'start' ? at.colIndex - 1 : at.colIndex + 1
      if (to < 0 || to >= columns) return null
      return {
        ...content,
        rows: rows.map((row) => ({ ...row, cells: moved(row.cells, at.colIndex, to) })),
        columnWidths: content.columnWidths && moved(content.columnWidths, at.colIndex, to)
      }
    }

    default: {
      const _exhaustive: never = op
      void _exhaustive
      return null
    }
  }
}

/** A new column has no dragged width; `undefined` is what BlockNote stores for that. */
function insertWidth(
  widths: (number | undefined)[] | undefined,
  index: number
): (number | undefined)[] | undefined {
  if (!widths) return widths
  const next = [...widths]
  next.splice(index, 0, undefined)
  return next
}
