import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { mockApp } from '@tests/utils/mock-electron'

vi.mock('electron', () => ({
  app: mockApp
}))

import {
  getCurrentVaultPath,
  setCurrentVaultPath,
  getVaults,
  upsertVault,
  removeVault,
  findVault,
  touchVault
} from './store'

describe('store', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-store-'))
    mockApp.getPath.mockImplementation((name: string) =>
      name === 'userData' ? tempDir : `/mock/${name}`
    )
  })

  afterEach(() => {
    vi.useRealTimers()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('returns defaults when config is missing', () => {
    expect(getCurrentVaultPath()).toBeNull()
    expect(getVaults()).toEqual([])
  })

  it('persists current vault path', () => {
    setCurrentVaultPath('/vaults/personal')

    expect(getCurrentVaultPath()).toBe('/vaults/personal')

    const configPath = path.join(tempDir, 'memry-config.json')
    const stored = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
      currentVault: string | null
    }
    expect(stored.currentVault).toBe('/vaults/personal')
  })

  it('upserts and finds vaults by path', () => {
    const vault = {
      path: '/vaults/a',
      name: 'Vault A',
      noteCount: 2,
      taskCount: 5,
      lastOpened: '2025-01-01T00:00:00.000Z',
      isDefault: true
    }

    upsertVault(vault)
    expect(getVaults()).toHaveLength(1)
    expect(findVault('/vaults/a')?.noteCount).toBe(2)

    upsertVault({ ...vault, noteCount: 8 })
    expect(getVaults()).toHaveLength(1)
    expect(findVault('/vaults/a')?.noteCount).toBe(8)
  })

  it('removes vaults and updates lastOpened', () => {
    const vaultA = {
      path: '/vaults/a',
      name: 'Vault A',
      noteCount: 1,
      taskCount: 1,
      lastOpened: '2025-01-01T00:00:00.000Z',
      isDefault: false
    }
    const vaultB = {
      path: '/vaults/b',
      name: 'Vault B',
      noteCount: 3,
      taskCount: 4,
      lastOpened: '2025-01-02T00:00:00.000Z',
      isDefault: false
    }

    upsertVault(vaultA)
    upsertVault(vaultB)
    removeVault('/vaults/b')

    expect(getVaults()).toHaveLength(1)
    expect(findVault('/vaults/b')).toBeUndefined()

    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-02-01T00:00:00.000Z'))
    touchVault('/vaults/a')

    expect(findVault('/vaults/a')?.lastOpened).toBe('2025-02-01T00:00:00.000Z')
  })
})
