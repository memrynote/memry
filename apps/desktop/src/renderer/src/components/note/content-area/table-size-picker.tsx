import { useId, useRef, useState, type KeyboardEvent } from 'react'
import { useT } from '@memry/i18n/renderer'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import type { TableSize } from './slash-menu-utils'
import { TABLE_PICKER_DEFAULT, TABLE_PICKER_MAX, moveTableSize } from './table-size-picker-model'

interface TableSizePickerProps {
  /**
   * Where the caret was when `/table` was picked; the grid opens under it.
   * Null while the grid is closed.
   */
  anchorRect: DOMRect | null
  onPick: (size: TableSize) => void
  onClose: () => void
}

/**
 * The rows x columns grid `/table` opens before it inserts anything (#2568).
 *
 * The pointer sizes the table by hovering and picks with a click; the keyboard
 * sizes it with the arrows and picks with Enter. Escape or a click away closes
 * the grid with nothing inserted. The grid itself is the one focus stop: its
 * cells are paint, and the size they show is announced from the label.
 */
export function TableSizePicker({ anchorRect, ...props }: TableSizePickerProps) {
  if (!anchorRect) return null
  // Mounted only while open, so every opening starts from the default size.
  return <OpenTableSizePicker anchorRect={anchorRect} {...props} />
}

function OpenTableSizePicker({
  anchorRect,
  onPick,
  onClose
}: TableSizePickerProps & { anchorRect: DOMRect }) {
  const { t } = useT('notes')
  const [size, setSize] = useState<TableSize>(TABLE_PICKER_DEFAULT)
  const gridRef = useRef<HTMLDivElement>(null)
  const labelId = useId()
  const anchorRef = useRef({ getBoundingClientRect: () => anchorRect })
  anchorRef.current.getBoundingClientRect = () => anchorRect

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onPick(size)
      return
    }
    const direction = gridRef.current && getComputedStyle(gridRef.current).direction
    const next = moveTableSize(size, event.key, direction === 'rtl' ? 'rtl' : 'ltr')
    if (!next) return
    event.preventDefault()
    setSize(next)
  }

  const sizeLabel = t('editor.table.sizePicker.size', { rows: size.rows, columns: size.columns })

  return (
    <Popover open onOpenChange={(open) => !open && onClose()}>
      <PopoverAnchor virtualRef={anchorRef} />
      <PopoverContent
        align="start"
        className="w-auto p-1"
        data-table-size-picker=""
        // Focus goes back to the editor from `onClose`/`onPick`; Radix handing
        // it to a trigger this popover does not have would drop it on <body>.
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <div
          ref={gridRef}
          // Two axes at once, so no single-value role fits; the arrows are the
          // grid's own, and the size reaches a screen reader from the live label.
          role="application"
          tabIndex={0}
          aria-label={t('editor.table.sizePicker.aria')}
          aria-describedby={labelId}
          className="grid gap-0.5 rounded-md p-1 outline-none focus-visible:ring-1 focus-visible:ring-[var(--tint-ring)]"
          style={{ gridTemplateColumns: `repeat(${TABLE_PICKER_MAX.columns}, 1rem)` }}
          onKeyDown={handleKeyDown}
        >
          {Array.from({ length: TABLE_PICKER_MAX.rows }, (_row, rowIndex) =>
            Array.from({ length: TABLE_PICKER_MAX.columns }, (_column, columnIndex) => {
              const cell = { rows: rowIndex + 1, columns: columnIndex + 1 }
              const inside = cell.rows <= size.rows && cell.columns <= size.columns
              return (
                <div
                  key={`${rowIndex}-${columnIndex}`}
                  aria-hidden="true"
                  data-table-size-cell={`${cell.rows}x${cell.columns}`}
                  data-selected={inside ? '' : undefined}
                  className={cn(
                    'size-4 cursor-pointer rounded-[3px] border transition-colors',
                    inside ? 'border-foreground/40 bg-accent' : 'border-border bg-background'
                  )}
                  onPointerEnter={() => setSize(cell)}
                  // Keep focus on the grid so the keyboard keeps working after
                  // a hover.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => onPick(cell)}
                />
              )
            })
          )}
        </div>
        <p
          id={labelId}
          aria-live="polite"
          className="px-1 pt-1 text-center text-[13px] text-muted-foreground"
        >
          {sizeLabel}
        </p>
      </PopoverContent>
    </Popover>
  )
}
