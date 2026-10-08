import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { VaultLockState } from '@memry/contracts/vault-locks-api'
import { VaultLockMenuItem } from './vault-lock-menu-item'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

vi.mock('@/components/ui/context-menu', () => ({
  ContextMenuItem: ({ children, onClick }: { children: React.ReactNode; onClick: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  )
}))

const broadcasts: Array<(state: VaultLockState) => void> = []
const set = vi.fn<(input: unknown) => Promise<VaultLockState>>()
Object.assign(window.api, {
  vaultLocks: { list: vi.fn().mockResolvedValue({ notes: [], folders: ['Archive'] }), set },
  onVaultLocksChanged: (callback: (state: VaultLockState) => void) => {
    broadcasts.push(callback)
    return () => {}
  }
})

describe('VaultLockMenuItem (#2606)', () => {
  it('locks a note and then offers to unlock it', async () => {
    set.mockResolvedValueOnce({ notes: ['note-1'], folders: ['Archive'] })
    render(<VaultLockMenuItem kind="note" target="note-1" />)

    fireEvent.click(screen.getByRole('button', { name: 'Lock note' }))

    await screen.findByRole('button', { name: 'Unlock note' })
    expect(set).toHaveBeenCalledWith({ kind: 'note', target: 'note-1', locked: true })
  })

  it('unlocks a locked folder', async () => {
    set.mockResolvedValueOnce({ notes: [], folders: [] })
    render(<VaultLockMenuItem kind="folder" target="Archive" />)

    fireEvent.click(await screen.findByRole('button', { name: 'Unlock folder' }))

    await screen.findByRole('button', { name: 'Lock folder' })
    expect(set).toHaveBeenCalledWith({ kind: 'folder', target: 'Archive', locked: false })
  })

  it('says so when the lock cannot be changed', async () => {
    act(() => {
      for (const callback of broadcasts) callback({ notes: [], folders: [] })
    })
    set.mockRejectedValueOnce(new Error('Folder not found: Gone'))
    render(<VaultLockMenuItem kind="folder" target="Gone" />)

    fireEvent.click(screen.getByRole('button', { name: 'Lock folder' }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Folder not found: Gone'))
    expect(screen.getByRole('button', { name: 'Lock folder' })).toBeInTheDocument()
  })
})
