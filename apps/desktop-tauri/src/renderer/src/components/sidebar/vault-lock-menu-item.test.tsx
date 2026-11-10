import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { VaultLockState } from '@memry/contracts/vault-locks-api'
import { VaultLockMenuItem } from './vault-lock-menu-item'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), loading: vi.fn(() => 'progress'), dismiss: vi.fn() }
}))

vi.mock('@/components/ui/context-menu', () => ({
  ContextMenuItem: ({
    children,
    onClick,
    disabled
  }: {
    children: React.ReactNode
    onClick: () => void
    disabled?: boolean
  }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  )
}))

const broadcasts: Array<(state: VaultLockState) => void> = []
const set = vi.fn<(input: unknown) => Promise<VaultLockState>>()
const list = vi.fn<() => Promise<VaultLockState>>()
list.mockResolvedValue({ notes: [], folders: ['Archive'] })
Object.assign(window.api, {
  vaultLocks: { list, set },
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

  it('shows progress while a folder lock runs and takes no second click', async () => {
    act(() => {
      for (const callback of broadcasts) callback({ notes: [], folders: [] })
    })
    let answer: (state: VaultLockState) => void = () => {}
    set.mockReturnValueOnce(new Promise<VaultLockState>((resolve) => (answer = resolve)))
    render(<VaultLockMenuItem kind="folder" target="Big" />)

    fireEvent.click(screen.getByRole('button', { name: 'Lock folder' }))

    await waitFor(() => expect(toast.loading).toHaveBeenCalledWith('Locking folder…'))
    expect(screen.getByRole('button', { name: 'Lock folder' })).toBeDisabled()
    await act(async () => answer({ notes: [], folders: ['Big'] }))
    expect(await screen.findByRole('button', { name: 'Unlock folder' })).toBeEnabled()
    expect(toast.dismiss).toHaveBeenCalledWith('progress')
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('an unlock of a folder another window already unlocked shows no error', async () => {
    act(() => {
      for (const callback of broadcasts) callback({ notes: [], folders: ['Old'] })
    })
    set.mockRejectedValueOnce({
      kind: 'notFound',
      code: 'folder_not_found',
      message: 'the folder is not there anymore'
    })
    list.mockResolvedValueOnce({ notes: [], folders: [] })
    render(<VaultLockMenuItem kind="folder" target="Old" />)

    fireEvent.click(screen.getByRole('button', { name: 'Unlock folder' }))

    await screen.findByRole('button', { name: 'Lock folder' })
    expect(toast.error).not.toHaveBeenCalled()
  })
})
