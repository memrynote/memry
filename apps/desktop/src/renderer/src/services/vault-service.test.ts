import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createMockApi } from '@tests/setup-dom'
import {
  vaultService,
  onVaultStatusChanged,
  onVaultIndexProgress,
  onVaultError,
  onVaultIndexRecovered
} from './vault-service'

describe('vault-service', () => {
  let api: ReturnType<typeof createMockApi>

  beforeEach(() => {
    api = createMockApi()
    api.vault.select = vi.fn().mockResolvedValue({ success: true, path: '/vault' })
    api.vault.create = vi.fn().mockResolvedValue({ success: true, path: '/vault' })
    api.vault.getAll = vi.fn().mockResolvedValue({ vaults: [] })
    api.vault.getStatus = vi.fn().mockResolvedValue({ isOpen: true })
    api.vault.getConfig = vi.fn().mockResolvedValue({})
    api.vault.updateConfig = vi.fn().mockResolvedValue({})
    api.vault.close = vi.fn().mockResolvedValue({ success: true })
    api.vault.switch = vi.fn().mockResolvedValue({ success: true })
    api.vault.remove = vi.fn().mockResolvedValue({ success: true })
    api.vault.reindex = vi.fn().mockResolvedValue({ success: true })

    api.onVaultStatusChanged = vi.fn().mockReturnValue(() => {})
    api.onVaultIndexProgress = vi.fn().mockReturnValue(() => {})
    api.onVaultError = vi.fn().mockReturnValue(() => {})
    api.onVaultIndexRecovered = vi.fn().mockReturnValue(() => {})
    ;(window as Window & { api: unknown }).api = api
  })

  it('forwards vault operations to window.api.vault', async () => {
    await vaultService.select('/path')
    expect(api.vault.select).toHaveBeenCalledWith('/path')

    await vaultService.create('/path', 'Name')
    expect(api.vault.create).toHaveBeenCalledWith('/path', 'Name')

    await vaultService.getAll()
    expect(api.vault.getAll).toHaveBeenCalled()

    await vaultService.getStatus()
    expect(api.vault.getStatus).toHaveBeenCalled()

    await vaultService.getConfig()
    expect(api.vault.getConfig).toHaveBeenCalled()

    await vaultService.updateConfig({ name: 'Updated' })
    expect(api.vault.updateConfig).toHaveBeenCalledWith({ name: 'Updated' })

    await vaultService.close()
    expect(api.vault.close).toHaveBeenCalled()

    await vaultService.switch('/other')
    expect(api.vault.switch).toHaveBeenCalledWith('/other')

    await vaultService.remove('/old')
    expect(api.vault.remove).toHaveBeenCalledWith('/old')

    await vaultService.reindex()
    expect(api.vault.reindex).toHaveBeenCalled()
  })

  it('registers vault event subscriptions', () => {
    const unsubscribe = vi.fn()
    api.onVaultStatusChanged = vi.fn(() => unsubscribe)
    api.onVaultIndexProgress = vi.fn(() => unsubscribe)
    api.onVaultError = vi.fn(() => unsubscribe)
    api.onVaultIndexRecovered = vi.fn(() => unsubscribe)

    expect(onVaultStatusChanged(vi.fn())).toBe(unsubscribe)
    expect(onVaultIndexProgress(vi.fn())).toBe(unsubscribe)
    expect(onVaultError(vi.fn())).toBe(unsubscribe)
    expect(onVaultIndexRecovered(vi.fn())).toBe(unsubscribe)
  })
})
