import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createMockApi } from '@tests/setup-dom'
import {
  vaultService,
  onVaultStatusChanged,
  onVaultIndexProgress,
  onVaultError,
  onVaultIndexRecovered
} from './vault-service'
import { invoke } from '@/lib/ipc/invoke'

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

  it('forwards vault operations through real Tauri payloads', async () => {
    Object.assign(api.vault, {
      open: vi.fn().mockResolvedValue({ success: true, path: '/vault' })
    })

    await vaultService.select('/path')
    expect(invoke).toHaveBeenCalledWith('vault_open', { input: { path: '/path' } })

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
    expect(invoke).toHaveBeenCalledWith('vault_switch', { input: { path: '/other' } })

    await vaultService.remove('/old')
    expect(api.vault.remove).toHaveBeenCalledWith('/old')

    await vaultService.reindex()
    expect(api.vault.reindex).toHaveBeenCalled()
  })

  it('chooses a folder before opening a vault when no path is provided', async () => {
    Object.assign(api, {
      dialogChooseFolder: vi.fn().mockResolvedValue('/chosen/vault')
    })
    Object.assign(api.vault, {
      open: vi.fn().mockResolvedValue({ success: true, path: '/chosen/vault' })
    })

    await vaultService.select()

    expect(invoke).toHaveBeenCalledWith('dialog_choose_folder', {
      title: 'Select Vault Folder'
    })
    expect(invoke).toHaveBeenCalledWith('vault_open', { input: { path: '/chosen/vault' } })
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
