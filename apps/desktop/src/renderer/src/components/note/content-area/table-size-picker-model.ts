import type { TableSize } from './slash-menu-utils'

/** How many rows and columns the picker's grid offers. */
export const TABLE_PICKER_MAX: TableSize = { rows: 10, columns: 10 }

/**
 * The size highlighted when the picker opens: the 3 x 3 table `/table` inserted
 * before the picker existed (a header row plus two body rows), so Enter
 * straight away gives the same table it always did.
 */
export const TABLE_PICKER_DEFAULT: TableSize = { rows: 3, columns: 3 }

const clamp = (value: number, max: number): number => Math.min(max, Math.max(1, value))

/**
 * The size an arrow key moves the highlight to, or null for any other key.
 *
 * Left and right follow the grid as drawn: in an RTL editor the first column is
 * on the right, so ArrowLeft grows the table there.
 */
export function moveTableSize(
  size: TableSize,
  key: string,
  direction: 'ltr' | 'rtl' = 'ltr'
): TableSize | null {
  const forward = direction === 'rtl' ? 'ArrowLeft' : 'ArrowRight'
  const back = direction === 'rtl' ? 'ArrowRight' : 'ArrowLeft'
  switch (key) {
    case 'ArrowDown':
      return { ...size, rows: clamp(size.rows + 1, TABLE_PICKER_MAX.rows) }
    case 'ArrowUp':
      return { ...size, rows: clamp(size.rows - 1, TABLE_PICKER_MAX.rows) }
    case forward:
      return { ...size, columns: clamp(size.columns + 1, TABLE_PICKER_MAX.columns) }
    case back:
      return { ...size, columns: clamp(size.columns - 1, TABLE_PICKER_MAX.columns) }
    default:
      return null
  }
}
