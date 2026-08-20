import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BoardManagerDialog } from './board-manager-dialog'
import type { HomePage } from '@/lib/home/types'

const board = (id: string, name: string, position: number): HomePage => ({
  id,
  name,
  position,
  widgets: []
})

const boards = [board('b1', 'Home', 0), board('b2', 'Work', 1)]

function setup(overrides: Partial<React.ComponentProps<typeof BoardManagerDialog>> = {}) {
  const props = {
    boards,
    open: true,
    onOpenChange: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
    onReorder: vi.fn(),
    ...overrides
  }
  render(<BoardManagerDialog {...props} />)
  return props
}

describe('BoardManagerDialog', () => {
  it('lists one row per board, in board order', () => {
    setup()
    const rows = screen.getAllByTestId('board-manager-row')
    expect(rows.map((r) => r.getAttribute('data-board-id'))).toEqual(['b1', 'b2'])
  })

  it('renames a board on Enter', async () => {
    const user = userEvent.setup()
    const { onRename } = setup()

    await user.click(screen.getAllByTestId('board-manager-rename')[1])
    const input = screen.getByTestId('board-manager-name-input')
    await user.clear(input)
    await user.type(input, '  Planning  {Enter}')

    expect(onRename).toHaveBeenCalledWith('b2', 'Planning')
  })

  it('keeps the dialog open and drops the edit on Escape', async () => {
    const user = userEvent.setup()
    const { onRename, onOpenChange } = setup()

    await user.click(screen.getAllByTestId('board-manager-name')[0])
    await user.type(screen.getByTestId('board-manager-name-input'), 'X{Escape}')

    expect(onRename).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(screen.queryByTestId('board-manager-name-input')).not.toBeInTheDocument()
  })

  it('does not call onRename when the name is unchanged or blank', async () => {
    const user = userEvent.setup()
    const { onRename } = setup()

    await user.click(screen.getAllByTestId('board-manager-name')[0])
    await user.type(screen.getByTestId('board-manager-name-input'), '{Enter}')
    expect(onRename).not.toHaveBeenCalled()

    await user.click(screen.getAllByTestId('board-manager-name')[0])
    const input = screen.getByTestId('board-manager-name-input')
    await user.clear(input)
    await user.type(input, '   {Enter}')
    expect(onRename).not.toHaveBeenCalled()
  })

  it('deletes a board, and refuses to delete the last one', async () => {
    const user = userEvent.setup()
    const { onDelete } = setup()

    await user.click(screen.getAllByTestId('board-manager-delete')[1])
    expect(onDelete).toHaveBeenCalledWith('b2')

    screen.getAllByTestId('board-manager-delete').forEach((b) => expect(b).toBeEnabled())
  })

  it('disables delete when a single board is left', () => {
    setup({ boards: [board('b1', 'Home', 0)] })
    expect(screen.getByTestId('board-manager-delete')).toBeDisabled()
  })

  it('renders nothing while closed', () => {
    setup({ open: false })
    expect(screen.queryByTestId('board-manager')).not.toBeInTheDocument()
  })
})
