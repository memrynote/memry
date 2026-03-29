import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { getSetting } from '@main/database/queries/settings'
import { setSetting } from '@main/database/queries/settings'
import {
  GENERAL_SETTINGS_DEFAULTS,
  EDITOR_SETTINGS_DEFAULTS
} from '@memry/contracts/settings-schemas'
import {
  populateSettingsCacheFromConfig,
  migrateSettingsToConfig,
  writeCacheFromPreferences
} from './settings-cache'
import { VAULT_PREFERENCES_DEFAULTS, readPreferences } from './vault-preferences'

const MEMRY_DIR = '.memry'

function createTempVault(config?: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-vault-'))
  const memryDir = path.join(dir, MEMRY_DIR)
  fs.mkdirSync(memryDir, { recursive: true })
  if (config) {
    fs.writeFileSync(path.join(memryDir, 'config.json'), JSON.stringify(config, null, 2))
  }
  return dir
}

describe('populateSettingsCacheFromConfig', () => {
  let testDb: TestDatabaseResult
  let vaultPath: string

  beforeEach(() => {
    testDb = createTestDataDb()
  })

  afterEach(() => {
    testDb.close()
    if (vaultPath) fs.rmSync(vaultPath, { recursive: true, force: true })
  })

  it('#given config.json with preferences #then writes to SQLite general + editor keys', () => {
    vaultPath = createTempVault({
      excludePatterns: ['.git'],
      preferences: {
        theme: 'dark',
        fontSize: 'large',
        fontFamily: 'gelasio',
        accentColor: '#ef4444',
        language: 'tr',
        createInSelectedFolder: false,
        editor: {
          width: 'wide',
          spellCheck: false,
          autoSaveDelay: 2000,
          showWordCount: true,
          toolbarMode: 'sticky'
        }
      }
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    populateSettingsCacheFromConfig(testDb.db as any, vaultPath)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const generalRaw = getSetting(testDb.db as any, 'general')
    expect(generalRaw).toBeTruthy()
    const general = JSON.parse(generalRaw!)
    expect(general.theme).toBe('dark')
    expect(general.fontSize).toBe('large')
    expect(general.fontFamily).toBe('gelasio')
    expect(general.accentColor).toBe('#ef4444')
    expect(general.language).toBe('tr')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const editorRaw = getSetting(testDb.db as any, 'editor')
    expect(editorRaw).toBeTruthy()
    const editor = JSON.parse(editorRaw!)
    expect(editor.width).toBe('wide')
    expect(editor.spellCheck).toBe(false)
    expect(editor.toolbarMode).toBe('sticky')
  })

  it('#given no preferences in config #then writes defaults to SQLite', () => {
    vaultPath = createTempVault({ excludePatterns: ['.git'] })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    populateSettingsCacheFromConfig(testDb.db as any, vaultPath)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const generalRaw = getSetting(testDb.db as any, 'general')
    const general = JSON.parse(generalRaw!)
    expect(general.theme).toBe('system')
    expect(general.accentColor).toBe('#6366f1')
  })

  it('#given existing machine-local settings in SQLite #then preserves them', () => {
    vaultPath = createTempVault({
      preferences: {
        theme: 'dark',
        editor: { width: 'wide' }
      }
    })

    // Pre-existing machine-local fields
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setSetting(
      testDb.db as any,
      'general',
      JSON.stringify({
        ...GENERAL_SETTINGS_DEFAULTS,
        startOnBoot: true,
        onboardingCompleted: true
      })
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    populateSettingsCacheFromConfig(testDb.db as any, vaultPath)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const generalRaw = getSetting(testDb.db as any, 'general')
    const general = JSON.parse(generalRaw!)
    expect(general.theme).toBe('dark')
    expect(general.startOnBoot).toBe(true)
    expect(general.onboardingCompleted).toBe(true)
  })
})

describe('migrateSettingsToConfig', () => {
  let testDb: TestDatabaseResult
  let vaultPath: string

  beforeEach(() => {
    testDb = createTestDataDb()
  })

  afterEach(() => {
    testDb.close()
    if (vaultPath) fs.rmSync(vaultPath, { recursive: true, force: true })
  })

  it('#given old vault without preferences key #then seeds config.json from SQLite', () => {
    vaultPath = createTempVault({ excludePatterns: ['.git'] })

    // Simulate pre-migration SQLite state
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setSetting(
      testDb.db as any,
      'general',
      JSON.stringify({
        ...GENERAL_SETTINGS_DEFAULTS,
        theme: 'dark',
        accentColor: '#ef4444'
      })
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setSetting(
      testDb.db as any,
      'editor',
      JSON.stringify({
        ...EDITOR_SETTINGS_DEFAULTS,
        width: 'wide'
      })
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    migrateSettingsToConfig(testDb.db as any, vaultPath)

    const prefs = readPreferences(vaultPath)
    expect(prefs.theme).toBe('dark')
    expect(prefs.accentColor).toBe('#ef4444')
    expect(prefs.editor.width).toBe('wide')
  })

  it('#given config.json already has preferences #then uses config as source', () => {
    vaultPath = createTempVault({
      preferences: {
        theme: 'white',
        fontSize: 'large',
        fontFamily: 'geist',
        accentColor: '#10b981',
        language: 'de',
        editor: { width: 'narrow' }
      }
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    migrateSettingsToConfig(testDb.db as any, vaultPath)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const generalRaw = getSetting(testDb.db as any, 'general')
    const general = JSON.parse(generalRaw!)
    expect(general.theme).toBe('white')
    expect(general.fontFamily).toBe('geist')
  })

  it('#given fresh vault with no SQLite data #then writes defaults everywhere', () => {
    vaultPath = createTempVault({ excludePatterns: ['.git'] })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    migrateSettingsToConfig(testDb.db as any, vaultPath)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const generalRaw = getSetting(testDb.db as any, 'general')
    const general = JSON.parse(generalRaw!)
    expect(general.theme).toBe('system')
  })
})

describe('writeCacheFromPreferences', () => {
  let testDb: TestDatabaseResult

  beforeEach(() => {
    testDb = createTestDataDb()
  })

  afterEach(() => {
    testDb.close()
  })

  it('#given full preferences #then writes general and editor keys', () => {
    const prefs = {
      ...VAULT_PREFERENCES_DEFAULTS,
      theme: 'dark' as const,
      editor: {
        ...VAULT_PREFERENCES_DEFAULTS.editor,
        width: 'wide' as const
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    writeCacheFromPreferences(testDb.db as any, prefs)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const general = JSON.parse(getSetting(testDb.db as any, 'general')!)
    expect(general.theme).toBe('dark')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const editor = JSON.parse(getSetting(testDb.db as any, 'editor')!)
    expect(editor.width).toBe('wide')
  })
})
