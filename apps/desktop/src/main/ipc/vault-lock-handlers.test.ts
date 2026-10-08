import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invokeHandler, mockIpcMain, resetIpcMocks } from '@tests/utils/mock-ipc'
import { VaultLocksChannels } from '@memry/contracts/vault-locks-api'

const mocks = vi.hoisted(() => ({
  getVaultLockState: vi.fn(),
  setVaultLock: vi.fn(),
  trackMainError: vi.fn()
}))

vi.mock('electron', () => ({ ipcMain: mockIpcMain }))
vi.mock('../vault-locks/registry', () => ({ getVaultLockState: mocks.getVaultLockState }))
vi.mock('../telemetry/diagnostics', () => ({ trackMainError: mocks.trackMainError }))
vi.mock('../vault-locks/service', () => ({ setVaultLock: mocks.setVaultLock }))

import { registerVaultLockHandlers, unregisterVaultLockHandlers } from './vault-lock-handlers'

describe('vault lock IPC handlers (#2606)', () => {
  beforeEach(() => {
    resetIpcMocks()
    vi.clearAllMocks()
    registerVaultLockHandlers()
  })

  it('lists the locks and sets one from validated input', async () => {
    mocks.getVaultLockState.mockReturnValue({ notes: ['n1'], folders: [] })
    mocks.setVaultLock.mockResolvedValue({ notes: [], folders: ['Archive'] })

    await expect(invokeHandler(VaultLocksChannels.invoke.LIST)).resolves.toEqual({
      notes: ['n1'],
      folders: []
    })
    await expect(
      invokeHandler(VaultLocksChannels.invoke.SET, {
        kind: 'folder',
        target: 'Archive',
        locked: true
      })
    ).resolves.toEqual({ notes: [], folders: ['Archive'] })
    expect(mocks.setVaultLock).toHaveBeenCalledWith({
      kind: 'folder',
      target: 'Archive',
      locked: true
    })
  })

  it('rejects a lock of a kind it does not know before touching the vault', async () => {
    await expect(
      invokeHandler(VaultLocksChannels.invoke.SET, { kind: 'tag', target: 'work', locked: true })
    ).rejects.toThrow()
    expect(mocks.setVaultLock).not.toHaveBeenCalled()
  })

  it('removes both channels on unregister', async () => {
    unregisterVaultLockHandlers()

    await expect(invokeHandler(VaultLocksChannels.invoke.LIST)).rejects.toThrow(
      'No handler registered'
    )
    expect(mockIpcMain.removeHandler).toHaveBeenCalledWith(VaultLocksChannels.invoke.SET)
  })
})
