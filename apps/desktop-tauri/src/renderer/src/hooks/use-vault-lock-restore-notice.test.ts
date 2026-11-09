import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { VaultLockExternalEditRestoredEvent } from '@memry/contracts/vault-locks-api'
import { useVaultLockRestoreNotice } from './use-vault-lock-restore-notice'

const { listeners, unlisten } = vi.hoisted(() => ({
  listeners: [] as Array<(received: { payload: VaultLockExternalEditRestoredEvent }) => void>,
  unlisten: vi.fn()
}))
vi.mock('sonner', () => ({ toast: vi.fn() }))
vi.mock('../../../generated/bindings', () => ({
  events: {
    vaultLocksExternalEditRestoredEvent: {
      listen: async (
        handler: (received: { payload: VaultLockExternalEditRestoredEvent }) => void
      ) => {
        listeners.push(handler)
        return unlisten
      }
    }
  }
}))

describe('useVaultLockRestoreNotice (#2606)', () => {
  it('tells the owner a locked note was written back, and stops listening on unmount', async () => {
    const { unmount } = renderHook(() => useVaultLockRestoreNotice())
    await waitFor(() => expect(listeners).toHaveLength(1))
    listeners[0]({ payload: { noteId: 'n1', path: 'Notes/plan.md', title: 'Plan' } })

    expect(toast).toHaveBeenCalledWith('“Plan” is locked, so its outside edit was undone', {
      description: "The edited text is saved in the note's version history."
    })
    unmount()
    await waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1))
  })
})
