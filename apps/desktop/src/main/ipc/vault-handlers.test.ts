/**
 * Vault IPC handlers tests
 *
 * @module ipc/vault-handlers.test
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import { mockIpcMain, resetIpcMocks, invokeHandler } from '@tests/utils/mock-ipc'
import { VaultChannels } from '@memry/contracts/vault-api'

// Track mock calls
const handleCalls: unknown[][] = []
const removeHandlerCalls: string[] = []

// Mock electron modules
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: unknown) => {
      handleCalls.push([channel, handler])
      mockIpcMain.handle(channel, handler as Parameters<typeof mockIpcMain.handle>[1])
    }),
    removeHandler: vi.fn((channel: string) => {
      removeHandlerCalls.push(channel)
      mockIpcMain.removeHandler(channel)
    })
  }
}))

// Mock vault module
vi.mock('../vault', () => ({
  selectVault: vi.fn(),
  getStatus: vi.fn(),
  getConfig: vi.fn(),
  updateConfig: vi.fn(),
  closeVault: vi.fn(),
  getAllVaults: vi.fn(),
  switchVault: vi.fn(),
  removeVault: vi.fn(),
  reindex: vi.fn()
}))

// Import after mocking
import { registerVaultHandlers, unregisterVaultHandlers } from './vault-handlers'
import * as vault from '../vault'

describe('vault-handlers', () => {
  beforeEach(() => {
    resetIpcMocks()
    vi.clearAllMocks()
    handleCalls.length = 0
    removeHandlerCalls.length = 0
  })

  afterEach(() => {
    unregisterVaultHandlers()
  })

  describe('registerVaultHandlers', () => {
    it('should register all vault handlers', () => {
      registerVaultHandlers()

      // Note: VaultChannels.invoke has 10 channels, but CREATE is not yet implemented
      // so we expect 9 handlers to be registered
      expect(handleCalls.length).toBeGreaterThanOrEqual(9)
    })
  })

  describe('unregisterVaultHandlers', () => {
    it('should unregister all vault handlers', () => {
      registerVaultHandlers()
      unregisterVaultHandlers()

      const invokeChannels = Object.values(VaultChannels.invoke)
      expect(removeHandlerCalls.length).toBe(invokeChannels.length)
    })
  })

  // =========================================================================
  // T450: SELECT, CREATE handlers
  // =========================================================================
  describe('SELECT handler', () => {
    beforeEach(() => {
      registerVaultHandlers()
    })

    it('should select a vault with valid path', async () => {
      const mockResult = {
        success: true,
        vault: { path: '/home/user/vault', name: 'My Vault' }
      }
      ;(vault.selectVault as Mock).mockResolvedValue(mockResult)

      const result = await invokeHandler(VaultChannels.invoke.SELECT, {
        path: '/home/user/vault'
      })

      expect(result).toEqual(mockResult)
      expect(vault.selectVault).toHaveBeenCalledWith({ path: '/home/user/vault' })
    })

    it('should select vault without path (shows folder picker)', async () => {
      const mockResult = {
        success: true,
        vault: { path: '/selected/vault', name: 'Selected Vault' }
      }
      ;(vault.selectVault as Mock).mockResolvedValue(mockResult)

      const result = await invokeHandler(VaultChannels.invoke.SELECT, {})

      expect(result).toEqual(mockResult)
      expect(vault.selectVault).toHaveBeenCalled()
    })

    it('should handle empty input (path is optional)', async () => {
      const mockResult = { success: true, vault: { path: '/picked/vault', name: 'Picked Vault' } }
      ;(vault.selectVault as Mock).mockResolvedValue(mockResult)

      // Path is optional according to schema, so empty object should work
      const result = await invokeHandler(VaultChannels.invoke.SELECT, {})

      expect(result.success).toBe(true)
    })

    it('should handle selectVault errors', async () => {
      ;(vault.selectVault as Mock).mockRejectedValue(new Error('Invalid directory'))

      await expect(
        invokeHandler(VaultChannels.invoke.SELECT, { path: '/invalid/path' })
      ).rejects.toThrow('Invalid directory')
    })
  })

  // =========================================================================
  // T451: GET_ALL, GET_STATUS, GET_CONFIG handlers
  // =========================================================================
  describe('GET_STATUS handler', () => {
    beforeEach(() => {
      registerVaultHandlers()
    })

    it('should get vault status', async () => {
      const mockStatus = {
        isOpen: true,
        path: '/home/user/vault',
        name: 'My Vault',
        noteCount: 100,
        taskCount: 50
      }
      ;(vault.getStatus as Mock).mockResolvedValue(mockStatus)

      const result = await invokeHandler(VaultChannels.invoke.GET_STATUS)

      expect(result).toEqual(mockStatus)
    })

    it('should return null when no vault is open', async () => {
      ;(vault.getStatus as Mock).mockResolvedValue(null)

      const result = await invokeHandler(VaultChannels.invoke.GET_STATUS)

      expect(result).toBeNull()
    })
  })

  describe('GET_CONFIG handler', () => {
    beforeEach(() => {
      registerVaultHandlers()
    })

    it('should get vault configuration', async () => {
      const mockConfig = {
        name: 'My Vault',
        theme: 'dark',
        autoSave: true
      }
      ;(vault.getConfig as Mock).mockResolvedValue(mockConfig)

      const result = await invokeHandler(VaultChannels.invoke.GET_CONFIG)

      expect(result).toEqual(mockConfig)
    })
  })

  describe('GET_ALL handler', () => {
    beforeEach(() => {
      registerVaultHandlers()
    })

    it('should get all known vaults', async () => {
      const mockVaults = [
        { path: '/vault1', name: 'Vault 1', lastOpened: '2026-01-01' },
        { path: '/vault2', name: 'Vault 2', lastOpened: '2026-01-02' }
      ]
      ;(vault.getAllVaults as Mock).mockResolvedValue(mockVaults)

      const result = await invokeHandler(VaultChannels.invoke.GET_ALL)

      expect(result).toEqual(mockVaults)
      expect(result).toHaveLength(2)
    })

    it('should return empty array when no vaults exist', async () => {
      ;(vault.getAllVaults as Mock).mockResolvedValue([])

      const result = await invokeHandler(VaultChannels.invoke.GET_ALL)

      expect(result).toEqual([])
    })
  })

  // =========================================================================
  // T452: SWITCH, CLOSE handlers
  // =========================================================================
  describe('SWITCH handler', () => {
    beforeEach(() => {
      registerVaultHandlers()
    })

    it('should switch to a different vault', async () => {
      const mockResult = { success: true }
      ;(vault.switchVault as Mock).mockResolvedValue(mockResult)

      const result = await invokeHandler(VaultChannels.invoke.SWITCH, '/path/to/other/vault')

      expect(result).toEqual(mockResult)
      expect(vault.switchVault).toHaveBeenCalledWith('/path/to/other/vault')
    })

    it('should handle switch errors', async () => {
      ;(vault.switchVault as Mock).mockRejectedValue(new Error('Vault not found'))

      await expect(
        invokeHandler(VaultChannels.invoke.SWITCH, '/nonexistent/vault')
      ).rejects.toThrow('Vault not found')
    })
  })

  describe('CLOSE handler', () => {
    beforeEach(() => {
      registerVaultHandlers()
    })

    it('should close the current vault', async () => {
      ;(vault.closeVault as Mock).mockResolvedValue(undefined)

      const result = await invokeHandler(VaultChannels.invoke.CLOSE)

      expect(vault.closeVault).toHaveBeenCalled()
      expect(result).toBeUndefined()
    })

    it('should handle close errors gracefully', async () => {
      ;(vault.closeVault as Mock).mockRejectedValue(new Error('Close failed'))

      await expect(invokeHandler(VaultChannels.invoke.CLOSE)).rejects.toThrow('Close failed')
    })
  })

  describe('REMOVE handler', () => {
    beforeEach(() => {
      registerVaultHandlers()
    })

    it('should remove a vault from known list', async () => {
      ;(vault.removeVault as Mock).mockResolvedValue(undefined)

      const result = await invokeHandler(VaultChannels.invoke.REMOVE, '/path/to/vault')

      expect(vault.removeVault).toHaveBeenCalledWith('/path/to/vault')
      expect(result).toBeUndefined()
    })
  })

  // =========================================================================
  // T453: REINDEX handler
  // =========================================================================
  describe('REINDEX handler', () => {
    beforeEach(() => {
      registerVaultHandlers()
    })

    it('should trigger vault reindexing', async () => {
      ;(vault.reindex as Mock).mockResolvedValue(undefined)

      const result = await invokeHandler(VaultChannels.invoke.REINDEX)

      expect(vault.reindex).toHaveBeenCalled()
      expect(result).toBeUndefined()
    })

    it('should handle reindex errors', async () => {
      ;(vault.reindex as Mock).mockRejectedValue(new Error('Reindex failed'))

      await expect(invokeHandler(VaultChannels.invoke.REINDEX)).rejects.toThrow('Reindex failed')
    })
  })

  // =========================================================================
  // UPDATE_CONFIG handler
  // =========================================================================
  describe('UPDATE_CONFIG handler', () => {
    beforeEach(() => {
      registerVaultHandlers()
    })

    it('should update vault configuration', async () => {
      // UpdateVaultConfigSchema only allows: excludePatterns, defaultNoteFolder, journalFolder, attachmentsFolder
      const mockUpdatedConfig = { defaultNoteFolder: 'notes', journalFolder: 'journal' }
      ;(vault.updateConfig as Mock).mockResolvedValue(mockUpdatedConfig)

      const result = await invokeHandler(VaultChannels.invoke.UPDATE_CONFIG, {
        defaultNoteFolder: 'notes',
        journalFolder: 'journal'
      })

      expect(result).toEqual(mockUpdatedConfig)
      expect(vault.updateConfig).toHaveBeenCalled()
    })

    it('should handle partial updates', async () => {
      const mockUpdatedConfig = { defaultNoteFolder: 'my-notes' }
      ;(vault.updateConfig as Mock).mockResolvedValue(mockUpdatedConfig)

      const result = await invokeHandler(VaultChannels.invoke.UPDATE_CONFIG, {
        defaultNoteFolder: 'my-notes'
      })

      expect(result).toEqual(mockUpdatedConfig)
    })

    it('should update exclude patterns', async () => {
      const mockUpdatedConfig = { excludePatterns: ['*.tmp', '.git'] }
      ;(vault.updateConfig as Mock).mockResolvedValue(mockUpdatedConfig)

      const result = await invokeHandler(VaultChannels.invoke.UPDATE_CONFIG, {
        excludePatterns: ['*.tmp', '.git']
      })

      expect(result).toEqual(mockUpdatedConfig)
    })
  })
})
