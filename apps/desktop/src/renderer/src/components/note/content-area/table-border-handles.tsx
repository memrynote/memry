import { useCallback, useEffect, useRef, useState, type CSSProperties, type FC } from 'react'
import { createPortal } from 'react-dom'

/**
 * Table row/column/cell handles that sit ON the table's own border lines.
 *
 * BlockNote's stock handles (`tableHandles`, disabled where this renders) are
 * floating-ui elements anchored `placement: 'left'` / `'top'` against a row or
 * column, so they always float NEXT TO the table rather than on it. No amount
 * of restyling moves them onto a border line — hence our own overlay, measured
 * from the DOM.
 *
 * Mount point: one overlay per hovered table, portalled into that table's
 * `.tableWrapper`. The wrapper is `position: relative` and is also the
 * horizontal scroll container (`@blocknote/core/dist/style.css`), so bars
 * placed in its content coordinates scroll with the table for free and clip
 * with it. prosemirror-tables' table view keeps its content DOM inside a
 * `.tableWrapper-inner` child and its `ignoreMutation` returns true for
 * anything outside that child, so appending to the wrapper is invisible to
 * ProseMirror.
 *
 * Which bars appear, only while the pointer is over a table — all three belong
 * to the ONE hovered cell:
 *   - a nub on that cell's inline-start border   (vertical)
 *   - a nub on that cell's inline-end border     (vertical)
 *   - a nub on the table's block-start border, over that cell's column
 *     (horizontal)
 *
 * Each is a short nub centred on its border segment, not a bar spanning the
 * whole line: a full-length bar reads as a thickened table border rather than
 * a control, and lighting up every cell of the hovered row at once was the
 * noise this replaced.
 */

/** Resting bar thickness. Kept in step with `base.css`. */
const BAR_THICKNESS = 3

/**
 * How much of a border segment the resting nub covers, centred on it. Clamped
 * to the segment so a short row or a narrow column never grows a bar longer
 * than the line it sits on.
 */
const BAR_LENGTH = 18

/**
 * `@blocknote/core/dist/style.css`:
 * `.bn-editor [data-content-type=table] th, td { border: 1px solid #ddd }`.
 * The table is `border-collapse: collapse`, so this 1px line is the whole
 * border between two cells and the bar has to cover it, not sit beside it.
 */
const CELL_BORDER = 1

/** Marks the overlay so pointer bookkeeping can tell it apart from the table. */
const OVERLAY_ATTR = 'data-memry-table-handles'

const CELL_SELECTOR = '[data-content-type="table"] td, [data-content-type="table"] th'

type HandleKind = 'row' | 'column' | 'cell'

interface HandleBar {
  key: string
  kind: HandleKind
  orientation: 'vertical' | 'horizontal'
  /** Offset from the wrapper's inline-start padding edge, table content px. */
  inlineStart: number
  /** Offset from the wrapper's block-start padding edge, table content px. */
  blockStart: number
  /** How much of the border line the bar covers. */
  length: number
  /** Seam identity. -1 where the axis does not apply (a row bar has no column). */
  rowIndex: number
  colIndex: number
}

interface Geometry {
  wrapper: HTMLElement
  bars: HandleBar[]
}

/**
 * Measure the bars for one hovered cell, in the wrapper's content coordinates.
 *
 * Everything is expressed inline-start / block-start rather than left / top so
 * an RTL table puts the row bar on the other side without a second code path.
 */
function measure(cell: HTMLTableCellElement): Geometry | null {
  const wrapper = cell.closest<HTMLElement>('.tableWrapper')
  const table = cell.closest('table')
  const row = cell.parentElement as HTMLTableRowElement | null
  if (!wrapper || !table || !row || row.cells.length === 0) return null

  const rowIndex = Array.prototype.indexOf.call(table.rows, row)
  const colIndex = Array.prototype.indexOf.call(row.cells, cell)
  if (rowIndex < 0 || colIndex < 0) return null

  const wrapperRect = wrapper.getBoundingClientRect()
  // Chromium reports RTL scroll as <= 0 with 0 at the inline-start (right)
  // edge, so the magnitude is the logical scroll distance in both directions.
  const scrollInline = Math.abs(wrapper.scrollLeft)
  const scrollBlock = wrapper.scrollTop
  const rtl = getComputedStyle(wrapper).direction === 'rtl'

  const inlineStartOf = (rect: DOMRect): number =>
    (rtl ? wrapperRect.right - rect.right : rect.left - wrapperRect.left) + scrollInline
  const blockStartOf = (rect: DOMRect): number => rect.top - wrapperRect.top + scrollBlock

  /** Centre a bar on the border line that STARTS at `edge`. */
  const onLineFrom = (edge: number): number => edge - (BAR_THICKNESS - CELL_BORDER) / 2
  /** Centre a bar on the border line that ENDS at `edge`. */
  const onLineTo = (edge: number): number => onLineFrom(edge - CELL_BORDER)

  const tableRect = table.getBoundingClientRect()
  const cellRect = cell.getBoundingClientRect()

  /** The nub's own extent, and where it starts, for a segment of `span`. */
  const nub = (segmentStart: number, span: number): { start: number; length: number } => {
    const length = Math.min(BAR_LENGTH, span)
    return { start: segmentStart + (span - length) / 2, length }
  }

  const alongCell = nub(blockStartOf(cellRect), cellRect.height)
  const acrossCell = nub(inlineStartOf(cellRect), cellRect.width)

  const bars: HandleBar[] = [
    {
      key: `row-${rowIndex}-${colIndex}`,
      kind: 'row',
      orientation: 'vertical',
      inlineStart: onLineFrom(inlineStartOf(cellRect)),
      blockStart: alongCell.start,
      length: alongCell.length,
      rowIndex,
      colIndex: -1
    },
    {
      key: `column-${colIndex}`,
      kind: 'column',
      orientation: 'horizontal',
      // Centred over the hovered cell's own inline extent, not a lookup into
      // row 0: with a colspan there is no single "column width", and this stays
      // over the cell the pointer is actually in.
      inlineStart: acrossCell.start,
      blockStart: onLineFrom(blockStartOf(tableRect)),
      length: acrossCell.length,
      rowIndex: -1,
      colIndex
    },
    {
      key: `cell-${rowIndex}-${colIndex}`,
      kind: 'cell',
      orientation: 'vertical',
      inlineStart: onLineTo(inlineStartOf(cellRect) + cellRect.width),
      blockStart: alongCell.start,
      length: alongCell.length,
      rowIndex,
      colIndex
    }
  ]

  return { wrapper, bars }
}

/** The six-dot drag glyph. Vertical bars use it upright, column bars rotate it. */
const DragDots: FC = () => (
  <svg viewBox="0 0 20 20" className="memry-table-handle-icon" aria-hidden="true" focusable="false">
    <path d="M6.25 4a1.25 1.25 0 1 0 2.5 0 1.25 1.25 0 0 0-2.5 0m5 0a1.25 1.25 0 1 0 2.5 0 1.25 1.25 0 0 0-2.5 0m1.25 7.25a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5M6.25 10a1.25 1.25 0 1 0 2.5 0 1.25 1.25 0 0 0-2.5 0m6.25 7.25a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5M6.25 16a1.25 1.25 0 1 0 2.5 0 1.25 1.25 0 0 0-2.5 0" />
  </svg>
)

interface TableBorderHandlesProps {
  /** The `.bn-container` the editor renders into. */
  containerEl: HTMLElement | null
}

export const TableBorderHandles: FC<TableBorderHandlesProps> = ({ containerEl }) => {
  const hoveredCellRef = useRef<HTMLTableCellElement | null>(null)
  const [geometry, setGeometry] = useState<Geometry | null>(null)

  const remeasure = useCallback((): void => {
    const cell = hoveredCellRef.current
    setGeometry(cell?.isConnected ? measure(cell) : null)
  }, [])

  useEffect(() => {
    if (!containerEl) return

    const handlePointerOver = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Element)) return
      // A bar sits on a border line, which is outside every cell — a pointer
      // that reaches one must not read as "the table was left".
      if (target.closest(`[${OVERLAY_ATTR}]`)) return

      const cell = target.closest<HTMLTableCellElement>(CELL_SELECTOR)
      if (cell === hoveredCellRef.current) return
      hoveredCellRef.current = cell
      setGeometry(cell ? measure(cell) : null)
    }

    const handlePointerLeave = (): void => {
      hoveredCellRef.current = null
      setGeometry(null)
    }

    containerEl.addEventListener('pointerover', handlePointerOver)
    containerEl.addEventListener('pointerleave', handlePointerLeave)
    return () => {
      containerEl.removeEventListener('pointerover', handlePointerOver)
      containerEl.removeEventListener('pointerleave', handlePointerLeave)
    }
  }, [containerEl])

  // A column drag-resize, a window resize or a row growing under typing all
  // move the border lines the bars are pinned to.
  const table = geometry?.wrapper.querySelector('table') ?? null
  useEffect(() => {
    if (!table) return
    const observer = new ResizeObserver(remeasure)
    observer.observe(table)
    return () => observer.disconnect()
  }, [table, remeasure])

  if (!geometry) return null

  return createPortal(
    <div
      data-memry-table-handles=""
      className="memry-table-handles"
      contentEditable={false}
      suppressContentEditableWarning
      // Unwired this round: the bars are a pointer affordance with no action
      // behind them yet, so they stay out of the accessibility tree rather
      // than announcing buttons that do nothing. The wiring round gives each
      // one a label and drops this.
      aria-hidden="true"
    >
      {geometry.bars.map((bar) => (
        <div
          key={bar.key}
          className="memry-table-handle"
          data-memry-table-bar={bar.kind}
          data-orientation={bar.orientation}
          style={
            {
              insetInlineStart: `${bar.inlineStart}px`,
              insetBlockStart: `${bar.blockStart}px`,
              '--memry-table-handle-length': `${bar.length}px`
            } as CSSProperties
          }
        >
          <button
            type="button"
            tabIndex={-1}
            className="memry-table-handle-control"
            data-memry-table-handle={bar.kind}
            data-row-index={bar.rowIndex}
            data-col-index={bar.colIndex}
            // Keep the caret where the user left it; the click is the handle's.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              // TODO(next round): 'row' opens the row menu, 'column' opens the
              // column menu, 'cell' opens the CELL menu (Colors, split) for
              // {rowIndex, colIndex}. Decided; deliberately not wired here.
            }}
          >
            <DragDots />
          </button>
        </div>
      ))}
    </div>,
    geometry.wrapper
  )
}
