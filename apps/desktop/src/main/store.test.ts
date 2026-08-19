import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { mockApp } from '@tests/utils/mock-electron'

vi.mock('electron', () => ({
  app: mockApp
}))

// The real module pulls the telemetry runtime, whose electron import ('net')
// the mock above does not provide.
vi.mock('./telemetry/diagnostics', () => ({
  trackMainError: vi.fn()
}))

import {
  getCurrentVaultPath,
  setCurrentVaultPath,
  getVaults,
  upsertVault,
  removeVault,
  findVault,
  touchVault,
  getDefaultVaultPath,
  setDefaultVaultPath,
  getStoredLocale,
  setStoredLocale,
  getWindowBounds,
  setWindowBounds,
  getCrdtInMemorySessions,
  recordCrdtPersistenceOutcome
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
    expect(getStoredLocale()).toBeNull()
    expect(getWindowBounds()).toBeNull()
  })

  it('persists window bounds across reads', () => {
    const bounds = { width: 1400, height: 920, x: 40, y: 30, isMaximized: false }
    setWindowBounds(bounds)

    expect(getWindowBounds()).toEqual(bounds)

    const configPath = path.join(tempDir, 'memry-config.json')
    const stored = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
      windowBounds: typeof bounds
      currentVault: string | null
    }
    expect(stored.windowBounds).toEqual(bounds)
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

  it('persists the app-level locale used before a vault opens', () => {
    setStoredLocale('tr')

    expect(getStoredLocale()).toBe('tr')

    const configPath = path.join(tempDir, 'memry-config.json')
    const stored = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
      locale: string
    }
    expect(stored.locale).toBe('tr')
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

  it('preserves a stored vaultUuid when an update omits it', () => {
    // The uuid links the row to the account vault directory; callers rebuild
    // VaultInfo from scratch, so an omitted uuid must not erase a stored one.
    upsertVault({
      path: '/vaults/a',
      name: 'Vault A',
      noteCount: 2,
      taskCount: 5,
      lastOpened: '2025-01-01T00:00:00.000Z',
      isDefault: true,
      vaultUuid: 'uuid-1'
    })

    upsertVault({
      path: '/vaults/a',
      name: 'Vault A',
      noteCount: 9,
      taskCount: 5,
      lastOpened: '2025-01-02T00:00:00.000Z',
      isDefault: true
    })

    expect(findVault('/vaults/a')?.vaultUuid).toBe('uuid-1')
    expect(findVault('/vaults/a')?.noteCount).toBe(9)

    upsertVault({
      path: '/vaults/a',
      name: 'Vault A',
      noteCount: 9,
      taskCount: 5,
      lastOpened: '2025-01-03T00:00:00.000Z',
      isDefault: true,
      vaultUuid: 'uuid-2'
    })
    expect(findVault('/vaults/a')?.vaultUuid).toBe('uuid-2')
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

  it('sets exactly one known vault as the CLI default', () => {
    upsertVault({
      path: '/vaults/personal',
      name: 'Personal',
      noteCount: 1,
      taskCount: 1,
      lastOpened: '2025-01-01T00:00:00.000Z',
      isDefault: true
    })
    upsertVault({
      path: '/vaults/work',
      name: 'Work',
      noteCount: 2,
      taskCount: 2,
      lastOpened: '2025-01-02T00:00:00.000Z',
      isDefault: false
    })

    expect(setDefaultVaultPath('/vaults/work')?.path).toBe('/vaults/work')
    expect(getDefaultVaultPath()).toBe('/vaults/work')
    expect(findVault('/vaults/personal')?.isDefault).toBe(false)
    expect(findVault('/vaults/work')?.isDefault).toBe(true)
    expect(setDefaultVaultPath('/vaults/missing')).toBeNull()
  })

  // A whole Windows population ran CRDT state in memory for six releases with a
  // log line as the only signal (issue #1583). This streak is what the
  // user-facing notice is thresholded on, so it has to survive quitting.
  describe('CRDT persistence streak', () => {
    beforeEach(() => {
      recordCrdtPersistenceOutcome(true)
    })

    it('reads as healthy on an install that has never degraded', () => {
      expect(getCrdtInMemorySessions()).toBe(0)
    })

    it('counts consecutive degraded launches', () => {
      expect(recordCrdtPersistenceOutcome(false)).toBe(1)
      expect(recordCrdtPersistenceOutcome(false)).toBe(2)
      expect(recordCrdtPersistenceOutcome(false)).toBe(3)
      expect(getCrdtInMemorySessions()).toBe(3)
    })

    it('forgets the streak the moment the store opens again', () => {
      recordCrdtPersistenceOutcome(false)
      recordCrdtPersistenceOutcome(false)

      expect(recordCrdtPersistenceOutcome(true)).toBe(0)
      expect(getCrdtInMemorySessions()).toBe(0)
    })
  })
})
