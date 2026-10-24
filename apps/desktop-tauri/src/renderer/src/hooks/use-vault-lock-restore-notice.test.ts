import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { VaultLockExternalEditRestoredEvent } from '@memry/contracts/vault-locks-api'
import { useVaultLockRestoreNotice } from './use-vault-lock-restore-notice'

vi.mock('sonner', () => ({ toast: vi.fn() }))

describe('useVaultLockRestoreNotice (#2606)', () => {
  it('tells the owner a locked note was written back, and stops listening on unmount', () => {
    const listeners: Array<(event: VaultLockExternalEditRestoredEvent) => void> = []
    const unsubscribe = vi.fn()
    Object.assign(window.api, {
      onVaultLockExternalEditRestored: (
        callback: (event: VaultLockExternalEditRestoredEvent) => void
      ) => {
        listeners.push(callback)
        return unsubscribe
      }
    })

    const { unmount } = renderHook(() => useVaultLockRestoreNotice())
    for (const listener of listeners)
      listener({ noteId: 'n1', path: 'Notes/plan.md', title: 'Plan' })

    expect(toast).toHaveBeenCalledWith('“Plan” is locked, so its outside edit was undone', {
      description: "The edited text is saved in the note's version history."
    })
    unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})
