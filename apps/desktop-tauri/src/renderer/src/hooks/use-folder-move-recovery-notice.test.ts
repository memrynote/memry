import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  vaultGetStatus: vi.fn(),
  statusListener: null as null | ((event: { payload: unknown }) => void),
  toast: vi.fn()
}))

vi.mock('sonner', () => ({ toast: mocks.toast }))

vi.mock('../../../generated/bindings', () => ({
  commands: { vaultGetStatus: mocks.vaultGetStatus },
  events: {
    vaultStatusChangedEvent: {
      listen: vi.fn(async (handler: (event: { payload: unknown }) => void) => {
        mocks.statusListener = handler
        return () => undefined
      })
    }
  }
}))

import { useFolderMoveRecoveryNotice } from './use-folder-move-recovery-notice'

/** `vault_get_status` as the Rust command sends it. */
function wireStatus(movesRecovered: Record<string, unknown> | null): Record<string, unknown> {
  return {
    isOpen: true,
    path: '/v/a',
    isIndexing: false,
    indexProgress: 0,
    indexBuilt: null,
    indexTotal: null,
    error: null,
    movesRecovered
  }
}

const sticky = { duration: Infinity, closeButton: true }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.statusListener = null
})

describe('useFolderMoveRecoveryNotice (#3754)', () => {
  it('shows the notice the open left in the status, read once it subscribes', async () => {
    // The open swept before the window existed: no event reached it, the status holds it.
    mocks.vaultGetStatus.mockResolvedValue(
      wireStatus({ id: 'open-1', undone: 1, conflictCopies: 2, keptFolders: 1, shownFolders: 0 })
    )
    renderHook(() => useFolderMoveRecoveryNotice())

    await waitFor(() => expect(mocks.toast).toHaveBeenCalledTimes(1))
    expect(mocks.toast).toHaveBeenCalledWith('An interrupted folder move was undone', {
      description:
        'Its notes are back in the folder they were moved from. ' +
        'Notes whose name was taken in the meantime end in “(conflict copy)”. ' +
        'Some notes are in folders ending in “(incomplete move)”. ' +
        'Nothing was deleted.',
      ...sticky
    })
  })

  it('never calls a folder it only made visible undone', async () => {
    mocks.vaultGetStatus.mockResolvedValue(
      wireStatus({ id: 'open-2', undone: 0, conflictCopies: 0, keptFolders: 0, shownFolders: 1 })
    )
    renderHook(() => useFolderMoveRecoveryNotice())

    await waitFor(() => expect(mocks.toast).toHaveBeenCalledTimes(1))
    expect(mocks.toast).toHaveBeenCalledWith(
      'Notes from an interrupted folder move are visible again',
      {
        description:
          'Some notes are in folders ending in “(incomplete move)”. Nothing was deleted.',
        ...sticky
      }
    )
  })

  it('shows each open’s notice once, and nothing for an open with none', async () => {
    const notice = { id: 'open-3', undone: 1, conflictCopies: 0, keptFolders: 0, shownFolders: 0 }
    mocks.vaultGetStatus.mockResolvedValue(wireStatus(notice))
    const first = renderHook(() => useFolderMoveRecoveryNotice())
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledTimes(1))
    expect(mocks.toast).toHaveBeenLastCalledWith('An interrupted folder move was undone', {
      description: 'Its notes are back in the folder they were moved from. Nothing was deleted.',
      ...sticky
    })

    // The shell mounts again (a vault switch back) and the status changes: same open, no repeat.
    first.unmount()
    renderHook(() => useFolderMoveRecoveryNotice())
    await waitFor(() => expect(mocks.vaultGetStatus).toHaveBeenCalledTimes(2))
    mocks.statusListener?.({ payload: wireStatus(notice) })
    mocks.statusListener?.({ payload: wireStatus(null) })
    expect(mocks.toast).toHaveBeenCalledTimes(1)

    // The next open that swept something has its own notice.
    mocks.statusListener?.({ payload: wireStatus({ ...notice, id: 'open-4' }) })
    expect(mocks.toast).toHaveBeenCalledTimes(2)
  })
})
