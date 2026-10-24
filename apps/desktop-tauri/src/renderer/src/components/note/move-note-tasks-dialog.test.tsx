import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MoveNoteTasksDialog } from './move-note-tasks-dialog'

describe('MoveNoteTasksDialog', () => {
  it('names the project and the number of tasks, and answers both ways', async () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    const user = userEvent.setup()

    render(
      <MoveNoteTasksDialog
        isOpen
        taskCount={3}
        projectName="Work"
        isMoving={false}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    )

    expect(screen.getByText(/3 tasks in this note belong to other projects/)).toBeInTheDocument()
    expect(screen.getByText(/Move them to Work\?/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Move tasks' }))
    expect(onConfirm).toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Keep as is' }))
    expect(onCancel).toHaveBeenCalled()
  })

  it('speaks of one task in the singular', () => {
    render(
      <MoveNoteTasksDialog
        isOpen
        taskCount={1}
        projectName="Work"
        isMoving={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    expect(screen.getByText(/1 task in this note belongs to another project/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Move task' })).toBeInTheDocument()
  })

  it('locks both answers while the move is running', () => {
    render(
      <MoveNoteTasksDialog
        isOpen
        taskCount={2}
        projectName="Work"
        isMoving
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    expect(screen.getByRole('button', { name: 'Move tasks' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Keep as is' })).toBeDisabled()
  })
})
