import { describe, expect, it, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithProviders } from '@tests/utils/render'
import type { NoteListItem } from '@/hooks/use-notes-query'
import { NoteTreeDeleteDialog } from './note-tree-dialogs'

const getCarriedTasks = vi.fn()

vi.mock('@/services/notes-service', () => ({
  notesService: {
    getCarriedTasks: (...args: unknown[]) => getCarriedTasks(...args)
  }
}))

const note = { id: 'n1', path: 'Groceries.md', title: 'Groceries' } as NoteListItem

function renderDialog(onConfirm = vi.fn()) {
  renderWithProviders(
    <NoteTreeDeleteDialog
      open
      onOpenChange={vi.fn()}
      notesToDelete={[note]}
      foldersToDelete={['Archive']}
      isDeleting={false}
      onConfirm={onConfirm}
    />
  )
  return onConfirm
}

describe('NoteTreeDeleteDialog', () => {
  beforeEach(() => {
    getCarriedTasks.mockReset()
  })

  it('asks main which tasks the notes and folders carry', async () => {
    getCarriedTasks.mockResolvedValue({ taskIds: [] })
    renderDialog()
    await waitFor(() =>
      expect(getCarriedTasks).toHaveBeenCalledWith({ noteIds: ['n1'], folderPaths: ['Archive'] })
    )
  })

  it('offers nothing extra when the notes carry no tasks', async () => {
    getCarriedTasks.mockResolvedValue({ taskIds: [] })
    const onConfirm = renderDialog()
    await waitFor(() => expect(getCarriedTasks).toHaveBeenCalled())

    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Delete 2' }))
    expect(onConfirm).toHaveBeenCalledWith([])
  })

  it('keeps the tasks unless the box is ticked', async () => {
    getCarriedTasks.mockResolvedValue({ taskIds: ['t1', 't2'] })
    const onConfirm = renderDialog()

    const option = await screen.findByText('Also delete the 2 tasks inside')
    expect(screen.getByText('Left unticked, they stay in Tasks.')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Delete 2' }))
    expect(onConfirm).toHaveBeenLastCalledWith([])

    await userEvent.click(option)
    await userEvent.click(screen.getByRole('button', { name: 'Delete 2' }))
    expect(onConfirm).toHaveBeenLastCalledWith(['t1', 't2'])
  })
})
