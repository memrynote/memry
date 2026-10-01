import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { TableSizePicker } from './table-size-picker'
import { TABLE_PICKER_DEFAULT, TABLE_PICKER_MAX, moveTableSize } from './table-size-picker-model'

describe('moveTableSize', () => {
  it('grows and shrinks rows with the vertical arrows', () => {
    expect(moveTableSize({ rows: 3, columns: 3 }, 'ArrowDown')).toEqual({ rows: 4, columns: 3 })
    expect(moveTableSize({ rows: 3, columns: 3 }, 'ArrowUp')).toEqual({ rows: 2, columns: 3 })
  })

  it('grows columns toward the grid end, mirrored in RTL', () => {
    expect(moveTableSize({ rows: 3, columns: 3 }, 'ArrowRight')).toEqual({ rows: 3, columns: 4 })
    expect(moveTableSize({ rows: 3, columns: 3 }, 'ArrowLeft', 'rtl')).toEqual({
      rows: 3,
      columns: 4
    })
  })

  it('stays within one cell and the grid', () => {
    expect(moveTableSize({ rows: 1, columns: 1 }, 'ArrowUp')).toEqual({ rows: 1, columns: 1 })
    expect(moveTableSize({ rows: 1, columns: 1 }, 'ArrowLeft')).toEqual({ rows: 1, columns: 1 })
    expect(moveTableSize(TABLE_PICKER_MAX, 'ArrowDown')).toEqual(TABLE_PICKER_MAX)
    expect(moveTableSize(TABLE_PICKER_MAX, 'ArrowRight')).toEqual(TABLE_PICKER_MAX)
  })

  it('ignores every other key', () => {
    expect(moveTableSize({ rows: 3, columns: 3 }, 'a')).toBeNull()
  })
})

function renderPicker() {
  const onPick = vi.fn()
  const onClose = vi.fn()
  render(
    <TableSizePicker anchorRect={new DOMRect(10, 10, 0, 16)} onPick={onPick} onClose={onClose} />
  )
  return { onPick, onClose, grid: screen.getByRole('application') }
}

describe('TableSizePicker', () => {
  it('opens on the default size and picks it with Enter', () => {
    const { onPick, grid } = renderPicker()

    fireEvent.keyDown(grid, { key: 'Enter' })

    expect(onPick).toHaveBeenCalledWith(TABLE_PICKER_DEFAULT)
  })

  it('sizes the table with the arrow keys', () => {
    const { onPick, grid } = renderPicker()

    fireEvent.keyDown(grid, { key: 'ArrowDown' })
    fireEvent.keyDown(grid, { key: 'ArrowDown' })
    fireEvent.keyDown(grid, { key: 'ArrowRight' })
    fireEvent.keyDown(grid, { key: 'Enter' })

    expect(onPick).toHaveBeenCalledWith({ rows: 5, columns: 4 })
  })

  it('sizes the table by hover and picks it with a click', () => {
    const { onPick } = renderPicker()
    const cell = document.querySelector('[data-table-size-cell="6x2"]') as HTMLElement

    fireEvent.pointerEnter(cell)
    expect(document.querySelectorAll('[data-table-size-cell][data-selected]')).toHaveLength(12)
    fireEvent.click(cell)

    expect(onPick).toHaveBeenCalledWith({ rows: 6, columns: 2 })
  })

  it('closes without picking on Escape', () => {
    const { onPick, onClose, grid } = renderPicker()

    fireEvent.keyDown(grid, { key: 'Escape' })

    expect(onClose).toHaveBeenCalled()
    expect(onPick).not.toHaveBeenCalled()
  })
})
