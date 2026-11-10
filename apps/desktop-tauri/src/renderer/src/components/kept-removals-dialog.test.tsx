import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  vaultNoticesList: vi.fn(),
  vaultNoticesRestoreKept: vi.fn(),
  vaultNoticesDeleteKept: vi.fn(),
  listener: null as null | ((event: { payload: null }) => void),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() })
}))

vi.mock('sonner', () => ({ toast: mocks.toast }))

vi.mock('../../../generated/bindings', () => ({
  commands: {
    vaultNoticesList: mocks.vaultNoticesList,
    vaultNoticesRestoreKept: mocks.vaultNoticesRestoreKept,
    vaultNoticesDeleteKept: mocks.vaultNoticesDeleteKept
  },
  events: {
    vaultNoticesChangedEvent: {
      listen: vi.fn(async (handler: (event: { payload: null }) => void) => {
        mocks.listener = handler
        return () => undefined
      })
    }
  }
}))

import { isReviewOpen, setReviewOpen } from '@/lib/kept-removals-review'
import { PermanentDeleteConfirm } from './note/permanent-delete-confirm'
import { KeptRemovalsDialog } from './kept-removals-dialog'

const NOTE = { noteId: 'n1', path: '/v/a/Alpha.md' }
const DAY = { noteId: 'j2025-01-02', path: '/v/a/journal/2025-01-02.md' }
const keptList = (notes: unknown[]): unknown => ({
  open: 1,
  notices: notes.length ? [{ kind: 'keptRemovals', notes, more: false }] : []
})
const trashRefused = { kind: 'storage', code: 'note_trash_unavailable', message: 'no trash' }

/** The vault's kept notes change to `notes`, as a restore or delete makes the notice say. */
async function keptChangeTo(notes: unknown[]): Promise<void> {
  mocks.vaultNoticesList.mockResolvedValue(keptList(notes))
  await act(async () => mocks.listener?.({ payload: null }))
}

const row = (name: string): HTMLElement => screen.getByText(name).closest('li') as HTMLElement

async function openReview(): Promise<void> {
  mocks.vaultNoticesList.mockResolvedValue(keptList([NOTE, DAY]))
  render(
    <>
      <KeptRemovalsDialog />
      <PermanentDeleteConfirm />
    </>
  )
  act(() => setReviewOpen(true))
  expect(await screen.findByText('Alpha')).toBeInTheDocument()
  expect(screen.getByText('2025-01-02')).toBeInTheDocument()
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.listener = null
  act(() => setReviewOpen(false))
  mocks.vaultNoticesRestoreKept.mockResolvedValue(null)
  mocks.vaultNoticesDeleteKept.mockResolvedValue(null)
})

describe('KeptRemovalsDialog (#4140)', () => {
  it('restores a note’s file, drops it as the notice does, and closes once none is left', async () => {
    const user = userEvent.setup()
    await openReview()

    await user.click(within(row('Alpha')).getByRole('button', { name: 'Restore file' }))
    expect(mocks.vaultNoticesRestoreKept).toHaveBeenCalledWith('n1')
    expect(mocks.toast.success).toHaveBeenCalledWith('File restored')

    await keptChangeTo([DAY])
    expect(screen.queryByText('Alpha')).toBeNull()
    await keptChangeTo([])
    await waitFor(() => expect(isReviewOpen()).toBe(false))
  })

  it('says why a restore was refused, and keeps the note listed', async () => {
    const user = userEvent.setup()
    mocks.vaultNoticesRestoreKept.mockRejectedValue({
      kind: 'conflict',
      code: 'unknown_code',
      message: 'A file named Alpha.md already exists'
    })
    await openReview()

    await user.click(within(row('Alpha')).getByRole('button', { name: 'Restore file' }))
    await waitFor(() =>
      expect(mocks.toast.error).toHaveBeenCalledWith('A file named Alpha.md already exists')
    )
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(isReviewOpen()).toBe(true)
  })

  it('deletes a note only once confirmed, to the trash', async () => {
    const user = userEvent.setup()
    await openReview()

    await user.click(within(row('Alpha')).getByRole('button', { name: 'Delete note' }))
    expect(mocks.vaultNoticesDeleteKept).not.toHaveBeenCalled()
    expect(
      screen.getByText('Delete this note on all your devices? Its text goes to the trash.')
    ).toBeInTheDocument()
    await user.click(within(row('Alpha')).getByRole('button', { name: 'Cancel' }))
    expect(mocks.vaultNoticesDeleteKept).not.toHaveBeenCalled()

    await user.click(within(row('Alpha')).getByRole('button', { name: 'Delete note' }))
    await user.click(within(row('Alpha')).getByRole('button', { name: 'Delete' }))
    expect(mocks.vaultNoticesDeleteKept).toHaveBeenCalledExactlyOnceWith('n1', null)
    await waitFor(() => expect(mocks.toast.success).toHaveBeenCalledWith('Note deleted'))
  })

  it('asks before a delete the trash refused goes for good, and keeps the note when told to', async () => {
    const user = userEvent.setup()
    mocks.vaultNoticesDeleteKept.mockRejectedValueOnce(trashRefused)
    await openReview()

    await user.click(within(row('Alpha')).getByRole('button', { name: 'Delete note' }))
    await user.click(within(row('Alpha')).getByRole('button', { name: 'Delete' }))
    await user.click(await screen.findByRole('button', { name: 'Keep note' }))
    await waitFor(() => expect(mocks.toast).toHaveBeenCalled())
    expect(mocks.vaultNoticesDeleteKept).toHaveBeenCalledExactlyOnceWith('n1', null)

    mocks.vaultNoticesDeleteKept.mockRejectedValueOnce(trashRefused)
    await user.click(within(row('Alpha')).getByRole('button', { name: 'Delete note' }))
    await user.click(within(row('Alpha')).getByRole('button', { name: 'Delete' }))
    const permanent = await screen.findByRole('button', { name: 'Delete permanently' })
    await waitFor(() => expect(permanent).toBeEnabled())
    await user.click(permanent)
    await waitFor(() => expect(mocks.vaultNoticesDeleteKept).toHaveBeenLastCalledWith('n1', true))
    await waitFor(() => expect(mocks.toast.success).toHaveBeenCalledWith('Note deleted'))
  })
})
