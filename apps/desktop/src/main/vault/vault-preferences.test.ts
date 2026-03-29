import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import {
  VaultPreferencesSchema,
  VAULT_PREFERENCES_DEFAULTS,
  type VaultPreferences
} from './vault-preferences'
import { readPreferences, writePreferences } from './vault-preferences'

const MEMRY_DIR = '.memry'

function createTempVault(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-vault-'))
  const memryDir = path.join(dir, MEMRY_DIR)
  fs.mkdirSync(memryDir, { recursive: true })
  return dir
}

describe('VaultPreferencesSchema', () => {
  it('#given valid preferences #then parses successfully', () => {
    const input = {
      theme: 'dark' as const,
      fontSize: 'large' as const,
      fontFamily: 'gelasio' as const,
      accentColor: '#ff0000',
      language: 'tr',
      createInSelectedFolder: false,
      editor: {
        width: 'wide' as const,
        spellCheck: false,
        autoSaveDelay: 2000,
        showWordCount: true,
        toolbarMode: 'sticky' as const
      }
    }

    const result = VaultPreferencesSchema.parse(input)
    expect(result).toEqual(input)
  })

  it('#given invalid theme #then throws', () => {
    const input = { ...VAULT_PREFERENCES_DEFAULTS, theme: 'neon' }
    expect(() => VaultPreferencesSchema.parse(input)).toThrow()
  })

  it('#given invalid accentColor #then throws', () => {
    const input = { ...VAULT_PREFERENCES_DEFAULTS, accentColor: 'not-hex' }
    expect(() => VaultPreferencesSchema.parse(input)).toThrow()
  })

  it('#given defaults #then parses successfully', () => {
    const result = VaultPreferencesSchema.parse(VAULT_PREFERENCES_DEFAULTS)
    expect(result).toEqual(VAULT_PREFERENCES_DEFAULTS)
  })
})

describe('readPreferences', () => {
  let vaultPath: string

  beforeEach(() => {
    vaultPath = createTempVault()
  })

  afterEach(() => {
    fs.rmSync(vaultPath, { recursive: true, force: true })
  })

  it('#given config.json with preferences #then returns parsed preferences', () => {
    const config = {
      excludePatterns: ['.git'],
      defaultNoteFolder: 'notes',
      journalFolder: 'journal',
      attachmentsFolder: 'attachments',
      preferences: {
        theme: 'dark',
        fontSize: 'large',
        fontFamily: 'system',
        accentColor: '#6366f1',
        language: 'en',
        createInSelectedFolder: true,
        editor: {
          width: 'wide',
          spellCheck: true,
          autoSaveDelay: 1000,
          showWordCount: false,
          toolbarMode: 'floating'
        }
      }
    }
    fs.writeFileSync(
      path.join(vaultPath, MEMRY_DIR, 'config.json'),
      JSON.stringify(config, null, 2)
    )

    const prefs = readPreferences(vaultPath)
    expect(prefs.theme).toBe('dark')
    expect(prefs.fontSize).toBe('large')
    expect(prefs.editor.width).toBe('wide')
  })

  it('#given config.json without preferences key #then returns defaults', () => {
    const config = {
      excludePatterns: ['.git'],
      defaultNoteFolder: 'notes',
      journalFolder: 'journal',
      attachmentsFolder: 'attachments'
    }
    fs.writeFileSync(
      path.join(vaultPath, MEMRY_DIR, 'config.json'),
      JSON.stringify(config, null, 2)
    )

    const prefs = readPreferences(vaultPath)
    expect(prefs).toEqual(VAULT_PREFERENCES_DEFAULTS)
  })

  it('#given no config.json #then returns defaults', () => {
    const prefs = readPreferences(vaultPath)
    expect(prefs).toEqual(VAULT_PREFERENCES_DEFAULTS)
  })

  it('#given corrupted config.json #then returns defaults', () => {
    fs.writeFileSync(path.join(vaultPath, MEMRY_DIR, 'config.json'), '{broken json')

    const prefs = readPreferences(vaultPath)
    expect(prefs).toEqual(VAULT_PREFERENCES_DEFAULTS)
  })

  it('#given partial preferences #then merges with defaults', () => {
    const config = {
      excludePatterns: ['.git'],
      preferences: {
        theme: 'dark'
      }
    }
    fs.writeFileSync(
      path.join(vaultPath, MEMRY_DIR, 'config.json'),
      JSON.stringify(config, null, 2)
    )

    const prefs = readPreferences(vaultPath)
    expect(prefs.theme).toBe('dark')
    expect(prefs.fontSize).toBe(VAULT_PREFERENCES_DEFAULTS.fontSize)
    expect(prefs.editor).toEqual(VAULT_PREFERENCES_DEFAULTS.editor)
  })

  it('#given partial editor prefs #then merges editor with defaults', () => {
    const config = {
      preferences: {
        theme: 'system',
        editor: { width: 'narrow' }
      }
    }
    fs.writeFileSync(
      path.join(vaultPath, MEMRY_DIR, 'config.json'),
      JSON.stringify(config, null, 2)
    )

    const prefs = readPreferences(vaultPath)
    expect(prefs.editor.width).toBe('narrow')
    expect(prefs.editor.spellCheck).toBe(VAULT_PREFERENCES_DEFAULTS.editor.spellCheck)
  })
})

describe('writePreferences', () => {
  let vaultPath: string

  beforeEach(() => {
    vaultPath = createTempVault()
    const config = {
      excludePatterns: ['.git'],
      defaultNoteFolder: 'notes',
      journalFolder: 'journal',
      attachmentsFolder: 'attachments'
    }
    fs.writeFileSync(
      path.join(vaultPath, MEMRY_DIR, 'config.json'),
      JSON.stringify(config, null, 2)
    )
  })

  afterEach(() => {
    fs.rmSync(vaultPath, { recursive: true, force: true })
  })

  it('#given partial update #then merges into existing config without clobbering vault fields', () => {
    writePreferences(vaultPath, { theme: 'dark' })

    const raw = JSON.parse(fs.readFileSync(path.join(vaultPath, MEMRY_DIR, 'config.json'), 'utf-8'))
    expect(raw.excludePatterns).toEqual(['.git'])
    expect(raw.defaultNoteFolder).toBe('notes')
    expect(raw.preferences.theme).toBe('dark')
    expect(raw.preferences.fontSize).toBe(VAULT_PREFERENCES_DEFAULTS.fontSize)
  })

  it('#given editor update #then merges editor fields only', () => {
    writePreferences(vaultPath, { editor: { width: 'wide' } })

    const raw = JSON.parse(fs.readFileSync(path.join(vaultPath, MEMRY_DIR, 'config.json'), 'utf-8'))
    expect(raw.preferences.editor.width).toBe('wide')
    expect(raw.preferences.editor.spellCheck).toBe(VAULT_PREFERENCES_DEFAULTS.editor.spellCheck)
  })

  it('#given write then read #then round-trips correctly', () => {
    writePreferences(vaultPath, { theme: 'dark', language: 'tr' })

    const prefs = readPreferences(vaultPath)
    expect(prefs.theme).toBe('dark')
    expect(prefs.language).toBe('tr')
    expect(prefs.fontSize).toBe(VAULT_PREFERENCES_DEFAULTS.fontSize)
  })

  it('#given no existing config.json #then creates it with preferences', () => {
    fs.unlinkSync(path.join(vaultPath, MEMRY_DIR, 'config.json'))

    writePreferences(vaultPath, { theme: 'dark' })

    const raw = JSON.parse(fs.readFileSync(path.join(vaultPath, MEMRY_DIR, 'config.json'), 'utf-8'))
    expect(raw.preferences.theme).toBe('dark')
  })

  it('#given multiple sequential writes #then accumulates changes', () => {
    writePreferences(vaultPath, { theme: 'dark' })
    writePreferences(vaultPath, { language: 'tr' })
    writePreferences(vaultPath, { editor: { width: 'narrow' } })

    const prefs = readPreferences(vaultPath)
    expect(prefs.theme).toBe('dark')
    expect(prefs.language).toBe('tr')
    expect(prefs.editor.width).toBe('narrow')
    expect(prefs.editor.spellCheck).toBe(true)
  })
})
