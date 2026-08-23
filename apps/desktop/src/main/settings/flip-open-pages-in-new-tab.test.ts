import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { getSetting, setSetting } from '@main/database/queries/settings'
import { readPreferences } from '@main/vault/vault-preferences'
import { populateSettingsCacheFromConfig } from '@main/vault/settings-cache'
import { SETTINGS_SYNC_CLOCKS_KEY } from '@memry/sync-client/settings-sync-keys'
import {
  flipOpenPagesInNewTabDefault,
  OPEN_PAGES_IN_NEW_TAB_FLIPPED_KEY
} from './flip-open-pages-in-new-tab'

const MEMRY_DIR = '.memry'

function createTempVault(config?: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-tab-flip-'))
  fs.mkdirSync(path.join(dir, MEMRY_DIR), { recursive: true })
  if (config) {
    fs.writeFileSync(path.join(dir, MEMRY_DIR, 'config.json'), JSON.stringify(config, null, 2))
  }
  return dir
}

function readConfig(vaultPath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(vaultPath, MEMRY_DIR, 'config.json'), 'utf-8'))
}

describe('flipOpenPagesInNewTabDefault', () => {
  let testDb: TestDatabaseResult
  let vaultPath: string

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = (): any => testDb.db

  beforeEach(() => {
    testDb = createTestDataDb()
  })

  afterEach(() => {
    testDb.close()
    if (vaultPath) fs.rmSync(vaultPath, { recursive: true, force: true })
  })

  it('#given a fresh install with no stored preference #then the setting reads false', () => {
    vaultPath = createTempVault()

    flipOpenPagesInNewTabDefault(db(), vaultPath)
    populateSettingsCacheFromConfig(db(), vaultPath)

    expect(readPreferences(vaultPath).openPagesInNewTab).toBe(false)
    expect(JSON.parse(getSetting(db(), 'general')!).openPagesInNewTab).toBe(false)
    // Nothing to rewrite, so the pass leaves config.json alone entirely.
    expect(fs.existsSync(path.join(vaultPath, MEMRY_DIR, 'config.json'))).toBe(false)
  })

  it('#given an existing install that never toggled #then it flips to false once', () => {
    vaultPath = createTempVault({
      excludePatterns: ['.git'],
      preferences: { theme: 'dark', openPagesInNewTab: true }
    })

    flipOpenPagesInNewTabDefault(db(), vaultPath)

    expect(readPreferences(vaultPath).openPagesInNewTab).toBe(false)
    expect(JSON.parse(getSetting(db(), 'general')!).openPagesInNewTab).toBe(false)
    expect(getSetting(db(), OPEN_PAGES_IN_NEW_TAB_FLIPPED_KEY)).toBe('1')
  })

  it('#given an older config.json #then unrelated settings survive the flip', () => {
    vaultPath = createTempVault({
      excludePatterns: ['.git', 'node_modules'],
      journalFolder: 'journal',
      preferences: {
        theme: 'dark',
        accentColor: '#ef4444',
        language: 'tr',
        createInSelectedFolder: false,
        openPagesInNewTab: true,
        editor: { width: 'full', toolbarMode: 'sticky' }
      }
    })

    flipOpenPagesInNewTabDefault(db(), vaultPath)

    const config = readConfig(vaultPath)
    expect(config.excludePatterns).toEqual(['.git', 'node_modules'])
    expect(config.journalFolder).toBe('journal')
    const prefs = readPreferences(vaultPath)
    expect(prefs).toMatchObject({
      theme: 'dark',
      accentColor: '#ef4444',
      language: 'tr',
      createInSelectedFolder: false,
      openPagesInNewTab: false,
      editor: { width: 'full', toolbarMode: 'sticky' }
    })
  })

  it('#given settings sync recorded a deliberate true #then the value stays true', () => {
    vaultPath = createTempVault({ preferences: { openPagesInNewTab: true } })
    setSetting(
      db(),
      SETTINGS_SYNC_CLOCKS_KEY,
      JSON.stringify({ 'general.openPagesInNewTab': { local: 3 } })
    )

    flipOpenPagesInNewTabDefault(db(), vaultPath)

    expect(readPreferences(vaultPath).openPagesInNewTab).toBe(true)
    expect(getSetting(db(), OPEN_PAGES_IN_NEW_TAB_FLIPPED_KEY)).toBe('1')
  })

  it('#given clocks for other fields only #then the flip still runs', () => {
    vaultPath = createTempVault({ preferences: { openPagesInNewTab: true } })
    setSetting(db(), SETTINGS_SYNC_CLOCKS_KEY, JSON.stringify({ 'general.theme': { local: 2 } }))

    flipOpenPagesInNewTabDefault(db(), vaultPath)

    expect(readPreferences(vaultPath).openPagesInNewTab).toBe(false)
  })

  it('#given a re-enable after the flip #then a second run leaves it on', () => {
    vaultPath = createTempVault({ preferences: { openPagesInNewTab: true } })

    flipOpenPagesInNewTabDefault(db(), vaultPath)
    expect(readPreferences(vaultPath).openPagesInNewTab).toBe(false)

    // The user turns it back on, then reopens the vault.
    fs.writeFileSync(
      path.join(vaultPath, MEMRY_DIR, 'config.json'),
      JSON.stringify({ preferences: { openPagesInNewTab: true } }, null, 2)
    )
    flipOpenPagesInNewTabDefault(db(), vaultPath)

    expect(readPreferences(vaultPath).openPagesInNewTab).toBe(true)
  })

  it('#given a vault already flipped #then a second run writes nothing', () => {
    vaultPath = createTempVault({ preferences: { openPagesInNewTab: true } })

    flipOpenPagesInNewTabDefault(db(), vaultPath)
    const afterFirst = fs.readFileSync(path.join(vaultPath, MEMRY_DIR, 'config.json'), 'utf-8')

    flipOpenPagesInNewTabDefault(db(), vaultPath)

    expect(fs.readFileSync(path.join(vaultPath, MEMRY_DIR, 'config.json'), 'utf-8')).toBe(
      afterFirst
    )
    expect(readPreferences(vaultPath).openPagesInNewTab).toBe(false)
  })

  it('#given a corrupt config.json #then vault open is not broken and it never retries', () => {
    vaultPath = createTempVault()
    fs.writeFileSync(path.join(vaultPath, MEMRY_DIR, 'config.json'), '{not json')

    expect(() => flipOpenPagesInNewTabDefault(db(), vaultPath)).not.toThrow()
    expect(getSetting(db(), OPEN_PAGES_IN_NEW_TAB_FLIPPED_KEY)).toBe('1')
  })
})
