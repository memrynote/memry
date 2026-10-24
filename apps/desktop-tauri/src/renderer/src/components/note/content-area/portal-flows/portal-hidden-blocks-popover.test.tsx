import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PortalHiddenBlocksPanel, type PortalBlockRow } from './portal-hidden-blocks-popover'

const rows = (count: number): PortalBlockRow[] =>
  Array.from({ length: count }, (_, i) => ({
    key: `b${i}`,
    path: 'Lecture 1 › DNA',
    text: `block ${i}`
  }))

function setup(count: number) {
  const onPick = vi.fn()
  const onShowAll = vi.fn()
  render(<PortalHiddenBlocksPanel rows={rows(count)} onPick={onPick} onShowAll={onShowAll} />)
  return { onPick, onShowAll }
}

describe('PortalHiddenBlocksPanel', () => {
  it('lists each block under its path, without a search box for a short list', () => {
    setup(2)

    expect(screen.getAllByText('Lecture 1 › DNA')).toHaveLength(2)
    expect(screen.getByText('block 1')).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('takes focus when there is no search box, so the keys reach it', () => {
    setup(3)

    expect(document.activeElement).toBe(screen.getByTestId('portal-hidden-blocks'))
  })

  it('brings in the active block on Enter, and the next one after an arrow', () => {
    const { onPick } = setup(3)
    const panel = screen.getByTestId('portal-hidden-blocks')

    fireEvent.keyDown(panel, { key: 'Enter' })
    fireEvent.keyDown(panel, { key: 'ArrowDown' })
    fireEvent.keyDown(panel, { key: 'Enter' })

    expect(onPick).toHaveBeenNthCalledWith(1, expect.objectContaining({ key: 'b0' }))
    expect(onPick).toHaveBeenNthCalledWith(2, expect.objectContaining({ key: 'b1' }))
  })

  it('shows all on Alt+Shift+A and from the footer', () => {
    const { onShowAll } = setup(2)

    fireEvent.keyDown(screen.getByTestId('portal-hidden-blocks'), {
      code: 'KeyA',
      altKey: true,
      shiftKey: true
    })
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }))

    expect(onShowAll).toHaveBeenCalledTimes(2)
  })

  it('adds a search box past five rows and filters by path and text', () => {
    setup(6)

    const search = screen.getByRole('textbox')
    fireEvent.change(search, { target: { value: 'block 4' } })

    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.getByText('block 4')).toBeTruthy()
  })
})
