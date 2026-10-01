import { describe, expect, it, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithProviders } from '@tests/utils/render'
import type { NoteListItem } from '@/hooks/use-notes-query'
import { NoteTreeDeleteDialog, NoteTreeJournalChangeDialog } from './note-tree-dialogs'

const getCarriedTasks = vi.fn()

vi.mock('@/services/notes-service', () => ({
  notesService: {
    getCarriedTasks: (...args: unknown[]) => getCarriedTasks(...args)
  }
}))

const note = { id: 'n1', path: 'Groceries.md', title: 'Groceries' } as NoteListItem

function renderDialog(onConfirm = vi.fn(), journalFolder: string | null = null) {
  renderWithProviders(
    <NoteTreeDeleteDialog
      open
      onOpenChange={vi.fn()}
      notesToDelete={[note]}
      foldersToDelete={['Archive']}
      isDeleting={false}
      onConfirm={onConfirm}
      journalFolder={journalFolder}
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

describe('NoteTreeDeleteDialog journal warning', () => {
  beforeEach(() => {
    getCarriedTasks.mockReset()
    getCarriedTasks.mockResolvedValue({ taskIds: [] })
  })

  it('warns when a deleted folder holds the journal folder', async () => {
    renderDialog(vi.fn(), 'Archive/Daily')
    expect(await screen.findByText(/This includes your journal folder/)).toBeInTheDocument()
  })

  it('says nothing about the journal for any other folder', async () => {
    renderDialog(vi.fn(), 'Daily')
    await waitFor(() => expect(getCarriedTasks).toHaveBeenCalled())
    expect(screen.queryByText(/This includes your journal folder/)).not.toBeInTheDocument()
  })
})

describe('NoteTreeJournalChangeDialog', () => {
  it('stays closed until there is something to confirm', () => {
    renderWithProviders(<NoteTreeJournalChangeDialog kind={null} onResolve={vi.fn()} />)
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('confirms an entry leaving the journal', async () => {
    const onResolve = vi.fn()
    renderWithProviders(<NoteTreeJournalChangeDialog kind="leave" onResolve={onResolve} />)

    expect(screen.getByText('Turn journal entries into notes?')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(onResolve).toHaveBeenCalledWith(true)
  })

  it('cancels a note joining the journal', async () => {
    const onResolve = vi.fn()
    renderWithProviders(<NoteTreeJournalChangeDialog kind="join" onResolve={onResolve} />)

    expect(screen.getByText('Turn notes into journal entries?')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onResolve).toHaveBeenCalledWith(false)
  })
})
