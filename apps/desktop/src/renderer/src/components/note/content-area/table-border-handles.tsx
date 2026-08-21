import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FC,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'
import { TableHandlesExtension } from '@blocknote/core/extensions'
import {
  AddButton,
  ComponentsContext,
  DeleteButton,
  TableCellMenu,
  TableHandleMenu,
  useBlockNoteEditor,
  useComponentsContext,
  useEditorChange,
  useEditorSelectionChange,
  useExtension
} from '@blocknote/react'
import { useT } from '@memry/i18n/renderer'

import { isTableMenuShortcut } from './table-keyboard-menu'

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
 * Which bars appear, only while the pointer is over a table — all three are
 * placed from the ONE hovered cell:
 *   - the TABLE's inline-start outer border, centred on that cell's row
 *     (vertical)  -> `TableHandleMenu orientation="row"`
 *   - the TABLE's block-start outer border, centred over that cell's column
 *     (horizontal) -> `TableHandleMenu orientation="column"`
 *   - that cell's own inline-end border (vertical)
 *                 -> `TableCellMenu` (Colors, split/merge)
 *
 * Row and column live on the table's OUTER edges on purpose. An interior
 * vertical line belongs to two cells at once — the line to a cell's left is
 * also the line to its neighbour's right — so a handle there would silently
 * address either of them. An outer edge is shared with nothing, and the one
 * interior line we do use, the cell's inline-end border, is claimed by the
 * cell menu, which is the only menu that needs a single cell.
 *
 * Each is a short nub centred on its border segment, not a bar spanning the
 * whole line: a full-length bar reads as a thickened table border rather than
 * a control, and lighting up every cell of the hovered row at once was the
 * noise this replaced.
 *
 * The menus are BlockNote's own, not copies: rebuilding them would mean
 * rebuilding the nine-swatch colour picker with them, so the nubs are only a
 * new trigger for menus that already exist.
 *
 * Separately from all of this, and driven by the caret rather than the pointer,
 * the cell holding the selection is ringed in the user's accent — see
 * `measureFocus`, and gets the row and column actions on a keyboard shortcut —
 * see `openKeyboardMenu`. Hover is not a gesture every user has: without that
 * shortcut, adding a row or deleting a column is unreachable by keyboard and by
 * touch alike.
 */

/**
 * `@blocknote/core/dist/style.css`:
 * `.bn-editor [data-content-type=table] th, td { border: 1px solid #ddd }`.
 * The table is `border-collapse: collapse`, so this 1px line is the whole
 * border between two cells and the bar has to cover it, not sit beside it.
 */
const CELL_BORDER = 1

/**
 * Resting bar thickness. Matching the border's own 1px was tried and rejected
 * as too faint to find; the nub is a control, so it reads as a thickening of
 * the line rather than as the line. Kept in step with `base.css`.
 */
const BAR_THICKNESS = 3

/**
 * How much of a border segment the resting nub covers, centred on it. Clamped
 * to the segment so a short row or a narrow column never grows a bar longer
 * than the line it sits on.
 */
const BAR_LENGTH = 18

/**
 * How wide the resize shield is, centred on the focused cell's inline-end
 * border. Wide enough to cover prosemirror-tables' own grab zone around that
 * line, narrow enough that clicking into the next cell still works.
 */
const RESIZE_SHIELD_WIDTH = 7

/**
 * Keeps a pointer event off the editor root.
 *
 * prosemirror-tables installs column resizing through `handleDOMEvents`
 * (`{ mousedown: handleMouseDown }` in `prosemirror-tables/dist/index.js`), and
 * ProseMirror binds those on `view.dom`. So an element INSIDE the editor that
 * stops propagation is enough — the resize handler never sees the event. That
 * is the whole reason this is a DOM shield rather than a plugin: registering a
 * plugin on a live editor destroys the Yjs undo manager, and resizing decides
 * from pointer coordinates rather than from a handle element, so hiding
 * `.column-resize-handle` in CSS would change only the cursor, not the drag.
 */
const stopEvent = (event: { stopPropagation: () => void }): void => event.stopPropagation()

/** Marks the overlay so pointer bookkeeping can tell it apart from the table. */
const OVERLAY_ATTR = 'data-memry-table-handles'

/**
 * Marks the resize shield, for the same pointer bookkeeping.
 *
 * The shield covers the focused cell's inline-end border, which is the exact
 * strip that cell's own nub stands on. It is not a `<td>`, so without this the
 * hover lookup reads a pointer that reached it as "the table was left".
 */
const SHIELD_ATTR = 'data-memry-table-resize-shield'

/** Marks a menu that was moved out of the wrapper, for its layer in base.css. */
const MENU_CLASS = 'memry-table-menu'

/** The `openBarRef` pin for the keyboard's menu, which belongs to no bar. */
const KEYBOARD_MENU_KEY = 'keyboard'

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
  /** The one cell all three bars are placed from — the menus' target. */
  cell: HTMLTableCellElement
  bars: HandleBar[]
}

/** The caret's cell, as a box in its wrapper's content coordinates. */
interface FocusRing {
  wrapper: HTMLElement
  inlineStart: number
  blockStart: number
  inlineSize: number
  blockSize: number
  rowIndex: number
  colIndex: number
}

/**
 * Maps viewport rects into one wrapper's content coordinates.
 *
 * Logical, not left/top, so an RTL table needs no second code path: Chromium
 * reports RTL scroll as <= 0 with 0 at the inline-start (right) edge, so the
 * magnitude is the logical scroll distance in both directions.
 */
function wrapperCoords(wrapper: HTMLElement): {
  inlineStartOf: (rect: DOMRect) => number
  blockStartOf: (rect: DOMRect) => number
} {
  const wrapperRect = wrapper.getBoundingClientRect()
  const scrollInline = Math.abs(wrapper.scrollLeft)
  const scrollBlock = wrapper.scrollTop
  const rtl = getComputedStyle(wrapper).direction === 'rtl'
  return {
    inlineStartOf: (rect) =>
      (rtl ? wrapperRect.right - rect.right : rect.left - wrapperRect.left) + scrollInline,
    blockStartOf: (rect) => rect.top - wrapperRect.top + scrollBlock
  }
}

/** A cell's seam identity inside its table, or null if it has none. */
function locate(
  cell: HTMLTableCellElement
): { wrapper: HTMLElement; table: HTMLTableElement; rowIndex: number; colIndex: number } | null {
  const wrapper = cell.closest<HTMLElement>('.tableWrapper')
  const table = cell.closest('table')
  const row = cell.parentElement as HTMLTableRowElement | null
  if (!wrapper || !table || !row || row.cells.length === 0) return null

  const rowIndex = Array.prototype.indexOf.call(table.rows, row)
  const colIndex = Array.prototype.indexOf.call(row.cells, cell)
  if (rowIndex < 0 || colIndex < 0) return null
  return { wrapper, table, rowIndex, colIndex }
}

/**
 * The ring drawn over the cell the caret is in.
 *
 * Drawn rather than set as an attribute on the `<td>`: ProseMirror's DOM
 * observer treats an attribute it did not write as a mutation, marks the cell
 * dirty and redraws it, which takes the attribute straight back off. The
 * wrapper is outside prosemirror-tables' `ignoreMutation` boundary, so a box
 * painted there is invisible to it — the same reason the bars live there.
 */
function measureFocus(cell: HTMLTableCellElement): FocusRing | null {
  const seam = locate(cell)
  if (!seam) return null

  const { inlineStartOf, blockStartOf } = wrapperCoords(seam.wrapper)
  const rect = cell.getBoundingClientRect()
  return {
    wrapper: seam.wrapper,
    inlineStart: inlineStartOf(rect),
    blockStart: blockStartOf(rect),
    inlineSize: rect.width,
    blockSize: rect.height,
    rowIndex: seam.rowIndex,
    colIndex: seam.colIndex
  }
}

/**
 * Point BlockNote's table-handle state at `cell` before a menu reads it.
 *
 * `TableHandleMenu` and `TableCellMenu` take no target: every item reads
 * `rowIndex` / `colIndex` straight off `TableHandlesExtension`'s store, which
 * its ProseMirror plugin view fills from its own `mousemove` listener. A nub
 * sits ON a border line shared by two cells, so the cell the pointer last
 * crossed is not reliably the cell the nub belongs to — and a menu reading the
 * wrong one would act on the neighbour with nothing on screen to show it.
 *
 * Replaying a `mousemove` on the nub's own cell is the extension's own way in:
 * it moves the plugin VIEW's state, not just the store, so the re-emit that
 * follows the menu's own edit still names this cell. `freezeHandles()` then
 * pins it for as long as the menu is open.
 *
 * It has to be replayed on POINTERDOWN, not from the menu's `onOpenChange`.
 * Once the view's own `mousedown` listener has marked the mouse down it reads
 * any move over a cell as the start of a cell SELECTION: it drops `show`,
 * keeps the stale indices and ignores the rest. `onOpenChange` lands after
 * `mousedown`; `pointerdown` lands before it.
 */
function pointExtensionAtCell(cell: HTMLTableCellElement): void {
  const rect = cell.getBoundingClientRect()
  cell.dispatchEvent(
    new MouseEvent('mousemove', {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2
    })
  )
}

/**
 * Measure the bars for one hovered cell, in the wrapper's content coordinates.
 *
 * Everything is expressed inline-start / block-start rather than left / top so
 * an RTL table puts the row bar on the other side without a second code path.
 */
function measure(cell: HTMLTableCellElement): Geometry | null {
  const seam = locate(cell)
  if (!seam) return null
  const { wrapper, table, rowIndex, colIndex } = seam

  const { inlineStartOf, blockStartOf } = wrapperCoords(wrapper)

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
      key: `row-${rowIndex}`,
      kind: 'row',
      orientation: 'vertical',
      // The TABLE's outer edge, not the cell's own inline-start border: that
      // interior line is shared with the previous cell, so a handle on it
      // points at two cells at once. Only the block extent comes from the
      // hovered cell, which is what names the row.
      inlineStart: onLineFrom(inlineStartOf(tableRect)),
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

  return { wrapper, cell, bars }
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
  const editor = useBlockNoteEditor()
  const components = useComponentsContext()
  const tableHandles = useExtension(TableHandlesExtension)

  const { t } = useT('notes')
  const hoveredCellRef = useRef<HTMLTableCellElement | null>(null)
  /**
   * The cell the caret is in — the one the resize shield covers.
   *
   * Kept beside `focusRing` rather than inside it because it is read from a
   * DOM listener, where a state value would be the one captured when the
   * listener was installed.
   */
  const focusCellRef = useRef<HTMLTableCellElement | null>(null)
  const [geometry, setGeometry] = useState<Geometry | null>(null)
  const [focusRing, setFocusRing] = useState<FocusRing | null>(null)
  const keyboardTriggerRef = useRef<HTMLButtonElement | null>(null)
  /** Whether the keyboard menu is up, for the anchor's own focus handler. */
  const keyboardMenuOpenRef = useRef(false)
  /**
   * The bar whose menu is open, or null. While a menu is open the bars are
   * pinned to the cell it was opened from: the pointer is over the menu, which
   * is portalled outside the editor, so the plain hover bookkeeping would tear
   * the overlay down and take the open menu with it.
   */
  const openBarRef = useRef<string | null>(null)

  /**
   * BlockNote's components, with the menu dropdown moved out of the table.
   *
   * `@blocknote/shadcn` renders `Generic.Menu.Dropdown` with no portal, so a
   * menu opened from a trigger inside `.tableWrapper` mounts inside it — and
   * `@blocknote/core`'s stylesheet makes that wrapper `overflow-x: auto;
   * overflow-y: hidden; position: relative`, the table's own scroll container.
   * A menu mounted there is clipped to the table's box, sits below BlockNote's
   * own UI layers, and never becomes the topmost element under the pointer, so
   * it comes up behind the text with a caret cursor over it.
   *
   * BlockNote does not fix this with a portal: its own table handles simply
   * live in `.bn-container`, outside the wrapper. This moves the dropdown there
   * too. Only the DROPDOWN moves — the nubs stay in the wrapper, because they
   * are drawn on the table's border lines and have to scroll and clip with it.
   * React context reaches through a portal, so the dropdown keeps the menu
   * context of the trigger it was opened from and stays anchored to it.
   */
  const menuComponents = useMemo(() => {
    if (!components || !containerEl) return components

    const Dropdown = components.Generic.Menu.Dropdown
    const PortalledDropdown: FC<{ className?: string; children?: ReactNode; sub?: boolean }> = (
      props
    ) =>
      createPortal(
        <Dropdown {...props} className={[props.className, MENU_CLASS].filter(Boolean).join(' ')} />,
        containerEl
      )

    return {
      ...components,
      Generic: {
        ...components.Generic,
        Menu: { ...components.Generic.Menu, Dropdown: PortalledDropdown }
      }
    }
  }, [components, containerEl])

  const remeasure = useCallback((): void => {
    const cell = hoveredCellRef.current
    setGeometry(cell?.isConnected ? measure(cell) : null)
  }, [])

  /**
   * Find the cell the caret is in, from the editor's own selection.
   *
   * Not `:focus-within` and not prosemirror-tables' `.selectedCell`: the
   * contenteditable is the editor root, so no `<td>` is ever the focused
   * element, and `.selectedCell` is only set for a cell SELECTION, never for a
   * collapsed caret. The selection is the only thing that knows.
   */
  const resolveFocus = useCallback((): void => {
    const view = editor.prosemirrorView
    if (!view || view.isDestroyed) {
      focusCellRef.current = null
      setFocusRing(null)
      return
    }
    const { node } = view.domAtPos(view.state.selection.from)
    const element = node instanceof Element ? node : node.parentElement
    const cell = element?.closest<HTMLTableCellElement>(CELL_SELECTOR) ?? null
    focusCellRef.current = cell
    setFocusRing(cell ? measureFocus(cell) : null)
  }, [editor])

  // Selection covers arrow keys and clicking from one cell to another; change
  // covers typing, which both moves the caret and grows the cell it is in.
  useEditorSelectionChange(resolveFocus, editor)
  useEditorChange(resolveFocus, editor)
  useEffect(resolveFocus, [resolveFocus])

  /**
   * Aim the extension at this nub's cell, from the nub's own `pointerdown`.
   * That handler runs before the dropdown opens — `asChild` composes the
   * child's handler ahead of the trigger's — and before `mousedown`.
   */
  const handleAim = useCallback(
    (cell: HTMLTableCellElement): void => {
      pointExtensionAtCell(cell)
      tableHandles.freezeHandles()
    },
    [tableHandles]
  )

  const handleOpenChange = useCallback(
    (barKey: string, open: boolean): void => {
      if (open) {
        tableHandles.freezeHandles()
        openBarRef.current = barKey
        return
      }

      tableHandles.unfreezeHandles()
      openBarRef.current = null
      // Drop the pin rather than hold bars up over a cell the pointer may have
      // left while the menu was covering it; the next hover raises them again.
      hoveredCellRef.current = null
      setGeometry(null)
      editor.focus()
    },
    [editor, tableHandles]
  )

  /**
   * Open the row/column menu on the caret's cell, from the keyboard.
   *
   * The nubs are raised by hover and are not in the tab order, so without this
   * every row and column action is mouse-only — a keyboard-only user cannot add
   * a row or delete a column at all (#1661), and neither can a touch user, who
   * has no hover either.
   *
   * Aiming is the same as the mouse path's: replay a `mousemove` on the cell so
   * `TableHandlesExtension`'s own plugin view names it, then freeze while the
   * menu is up. The menu's items read their row and column indices from that
   * state, not from a prop.
   *
   * Opening it is a `pointerdown` on the anchor, not a synthetic `Enter` on it,
   * even though Radix opens on either: the anchor lives inside the table, so a
   * bubbling `Enter` reaches ProseMirror's own keydown handler on the way out
   * and splits the block under the caret. `pointerdown` is inert for
   * ProseMirror, and `fakeEvent` is the flag `@blocknote/shadcn`'s trigger
   * wrapper looks for to let one through to Radix.
   */
  const openKeyboardMenu = useCallback((): boolean => {
    const cell = focusCellRef.current
    const trigger = keyboardTriggerRef.current
    if (!cell?.isConnected || !trigger) return false

    pointExtensionAtCell(cell)
    tableHandles.freezeHandles()
    const press = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 })
    ;(press as PointerEvent & { fakeEvent?: boolean }).fakeEvent = true
    trigger.dispatchEvent(press)
    return true
  }, [tableHandles])

  const handleKeyboardOpenChange = useCallback(
    (open: boolean): void => {
      keyboardMenuOpenRef.current = open
      if (open) {
        // Same pin as a nub's menu: hover bookkeeping must not tear anything
        // down while this menu, portalled outside the editor, holds the pointer.
        openBarRef.current = KEYBOARD_MENU_KEY
        return
      }

      tableHandles.unfreezeHandles()
      openBarRef.current = null
      // Focus is handed back by `handleAnchorFocus`, not from here: Radix
      // restores it to the trigger on its own schedule, and a `focus()` racing
      // that lands nowhere.
    },
    [tableHandles]
  )

  /**
   * Hand focus on from the anchor to the editor.
   *
   * Radix focuses the trigger when the menu closes, however it was closed —
   * `Escape`, an item, or a click outside. The trigger is a box over a cell, not
   * a place a caret can live, so it passes focus straight on: the ProseMirror
   * selection never moved, so the caret lands back in the cell the menu was
   * opened from, which is what `Escape` has to do.
   *
   * Only while the menu is CLOSED. Radix's focus scope pulls focus back into an
   * open menu, so bouncing it out from here turns every arrow key into a fight:
   * focus leaves for the editor, the scope hauls it back to the menu's own box,
   * and the highlight starts again from the first item.
   */
  const handleAnchorFocus = useCallback((): void => {
    if (keyboardMenuOpenRef.current) return
    editor.focus()
  }, [editor])

  useEffect(() => {
    if (!containerEl) return

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (openBarRef.current) return
      if (!isTableMenuShortcut(event)) return
      if (!openKeyboardMenu()) return
      // Capture phase, so this lands before ProseMirror's own handler on
      // `view.dom` — `Mod+Shift+Enter` must not also split the cell.
      event.preventDefault()
      event.stopPropagation()
    }

    containerEl.addEventListener('keydown', handleKeyDown, true)
    return () => containerEl.removeEventListener('keydown', handleKeyDown, true)
  }, [containerEl, openKeyboardMenu])

  useEffect(() => {
    if (!containerEl) return

    const handlePointerOver = (event: PointerEvent): void => {
      if (openBarRef.current) return
      const target = event.target
      if (!(target instanceof Element)) return
      // A bar sits on a border line, which is outside every cell — a pointer
      // that reaches one must not read as "the table was left".
      if (target.closest(`[${OVERLAY_ATTR}]`)) return

      // The shield stands ON the focused cell's inline-end border, which is
      // where that cell's own nub is. It is a sibling of the table, not a
      // `<td>`, so the plain lookup answers "no cell" and takes the bars down
      // the moment the pointer approaches the very control the shield exists
      // to protect — the reason a focused cell's nub was unreachable while an
      // unfocused one was easy.
      const shielded = target.closest(`[${SHIELD_ATTR}]`) !== null
      const focusCell = focusCellRef.current
      const cell = shielded
        ? focusCell?.isConnected
          ? focusCell
          : null
        : target.closest<HTMLTableCellElement>(CELL_SELECTOR)
      if (cell === hoveredCellRef.current) return
      hoveredCellRef.current = cell
      setGeometry(cell ? measure(cell) : null)
    }

    const handlePointerLeave = (): void => {
      if (openBarRef.current) return
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
  // move the border lines the bars and the ring are pinned to.
  const table = geometry?.wrapper.querySelector('table') ?? null
  useEffect(() => {
    if (!table) return
    const observer = new ResizeObserver(remeasure)
    observer.observe(table)
    return () => observer.disconnect()
  }, [table, remeasure])

  const focusTable = focusRing?.wrapper.querySelector('table') ?? null
  useEffect(() => {
    if (!focusTable) return
    const observer = new ResizeObserver(resolveFocus)
    observer.observe(focusTable)
    return () => observer.disconnect()
  }, [focusTable, resolveFocus])

  let handles: ReactNode = null
  if (geometry && menuComponents) {
    const { Root, Trigger } = menuComponents.Generic.Menu
    const targetCell = geometry.cell
    handles = createPortal(
      <ComponentsContext.Provider value={menuComponents}>
        <div
          data-memry-table-handles=""
          className="memry-table-handles"
          contentEditable={false}
          suppressContentEditableWarning
          // Pointer-only, by design: the bars are raised by hover and are not
          // in the tab order, so announcing them would offer a control no
          // keyboard can reach. The keyboard has its own way to the same
          // actions — see `keyboardMenu` below.
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
                  '--memry-table-handle-length': `${bar.length}px`,
                  '--memry-table-handle-thickness': `${BAR_THICKNESS}px`
                } as CSSProperties
              }
            >
              <Root onOpenChange={(open) => handleOpenChange(bar.key, open)}>
                <Trigger>
                  <button
                    type="button"
                    tabIndex={-1}
                    className="memry-table-handle-control"
                    data-memry-table-handle={bar.kind}
                    data-row-index={bar.rowIndex}
                    data-col-index={bar.colIndex}
                    onPointerDown={(event) => {
                      if (event.button !== 0) return
                      handleAim(targetCell)
                    }}
                    // Keep the caret where the user left it; the click is the
                    // handle's.
                    onMouseDown={(event) => event.preventDefault()}
                  >
                    {/*
                      The button is the hit target and the pill is the paint:
                      the button is padded out across the bar's thin axis so
                      the pointer does not have to land on a 3px line, while
                      what the user sees stays exactly the line's width.
                    */}
                    <span className="memry-table-handle-pill">
                      <DragDots />
                    </span>
                  </button>
                </Trigger>
                {bar.kind === 'cell' ? (
                  <TableCellMenu />
                ) : (
                  <TableHandleMenu orientation={bar.kind} />
                )}
              </Root>
            </div>
          ))}
        </div>
      </ComponentsContext.Provider>,
      geometry.wrapper
    )
  }

  /**
   * The keyboard's way into the row and column actions.
   *
   * One menu rather than the pointer's two, because a keyboard has no cell to
   * point at: the caret's cell names both a row and a column at once, so both
   * sets of actions belong in the menu that cell opens. The items are
   * BlockNote's own `AddButton` / `DeleteButton`, so the edits and their labels
   * are the same ones the nubs perform.
   *
   * Mounted for as long as the caret is in a cell, not raised by the shortcut:
   * Radix opens a dropdown from an event on its trigger, so the trigger has to
   * already be there when the key is pressed. It is a box over that cell which
   * takes no pointer events and paints nothing — the cell under it is still
   * being typed in.
   */
  let keyboardMenu: ReactNode = null
  if (focusRing && menuComponents) {
    const { Root, Trigger, Dropdown, Divider, Label } = menuComponents.Generic.Menu
    // 1-based: the row and column a person counts, not the array index.
    const position = { row: focusRing.rowIndex + 1, column: focusRing.colIndex + 1 }
    keyboardMenu = createPortal(
      <ComponentsContext.Provider value={menuComponents}>
        <Root onOpenChange={handleKeyboardOpenChange}>
          <Trigger>
            <button
              ref={keyboardTriggerRef}
              type="button"
              tabIndex={-1}
              className="memry-table-keyboard-anchor"
              data-memry-table-keyboard-anchor=""
              data-row-index={focusRing.rowIndex}
              data-col-index={focusRing.colIndex}
              contentEditable={false}
              suppressContentEditableWarning
              onFocus={handleAnchorFocus}
              // Radix names the dropdown after its trigger, so the row and
              // column reach a screen reader as the menu's own name.
              aria-label={t('editor.table.keyboardMenuAria', position)}
              style={{
                insetInlineStart: `${focusRing.inlineStart}px`,
                insetBlockStart: `${focusRing.blockStart}px`,
                inlineSize: `${focusRing.inlineSize}px`,
                blockSize: `${focusRing.blockSize}px`
              }}
            />
          </Trigger>
          {/* `@blocknote/shadcn`'s dropdown forwards className and nothing
            else, so the class is also what names this menu in the E2E. */}
          <Dropdown className="bn-table-handle-menu memry-table-keyboard-menu">
            <Label>{t('editor.table.keyboardMenuTitle', position)}</Label>
            <DeleteButton orientation="row" />
            <AddButton orientation="row" side="above" />
            <AddButton orientation="row" side="below" />
            <Divider />
            <DeleteButton orientation="column" />
            <AddButton orientation="column" side="left" />
            <AddButton orientation="column" side="right" />
          </Dropdown>
        </Root>
      </ComponentsContext.Provider>,
      focusRing.wrapper
    )
  }

  return (
    <>
      {focusRing &&
        createPortal(
          <div
            className="memry-table-cell-focus"
            data-memry-table-cell-focus=""
            data-row-index={focusRing.rowIndex}
            data-col-index={focusRing.colIndex}
            contentEditable={false}
            suppressContentEditableWarning
            aria-hidden="true"
            style={{
              insetInlineStart: `${focusRing.inlineStart}px`,
              insetBlockStart: `${focusRing.blockStart}px`,
              inlineSize: `${focusRing.inlineSize}px`,
              blockSize: `${focusRing.blockSize}px`
            }}
          />,
          focusRing.wrapper
        )}
      {focusRing &&
        createPortal(
          <div
            className="memry-table-resize-shield"
            data-memry-table-resize-shield=""
            contentEditable={false}
            suppressContentEditableWarning
            aria-hidden="true"
            onPointerDown={stopEvent}
            onMouseDown={stopEvent}
            onMouseMove={stopEvent}
            style={{
              insetInlineStart: `${focusRing.inlineStart + focusRing.inlineSize - RESIZE_SHIELD_WIDTH / 2}px`,
              insetBlockStart: `${focusRing.blockStart}px`,
              inlineSize: `${RESIZE_SHIELD_WIDTH}px`,
              blockSize: `${focusRing.blockSize}px`
            }}
          />,
          focusRing.wrapper
        )}
      {handles}
      {keyboardMenu}
    </>
  )
}
