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

describe('editor spellCheck preference', () => {
  let vaultPath: string

  afterEach(() => {
    if (vaultPath) fs.rmSync(vaultPath, { recursive: true, force: true })
  })

  it('#given no stored preference #then spellCheck defaults to off', () => {
    vaultPath = createTempVault()

    expect(readPreferences(vaultPath).editor.spellCheck).toBe(false)
  })

  it('#given config.json written by an older version #then spellCheck reads as off', () => {
    vaultPath = createTempVault()
    fs.writeFileSync(
      path.join(vaultPath, MEMRY_DIR, 'config.json'),
      JSON.stringify({ preferences: { theme: 'dark', editor: { width: 'full' } } })
    )

    expect(readPreferences(vaultPath).editor.spellCheck).toBe(false)
  })

  it('#given spellCheck enabled #then it round-trips through config.json', () => {
    vaultPath = createTempVault()

    writePreferences(vaultPath, { editor: { spellCheck: true } })

    expect(readPreferences(vaultPath).editor.spellCheck).toBe(true)
  })

  it('#given spellCheck enabled #when an unrelated editor pref changes #then spellCheck survives', () => {
    vaultPath = createTempVault()
    writePreferences(vaultPath, { editor: { spellCheck: true } })

    writePreferences(vaultPath, { editor: { width: 'full' } })

    expect(readPreferences(vaultPath).editor.spellCheck).toBe(true)
  })
})

describe('minimizeToTray preference', () => {
  let vaultPath: string

  afterEach(() => {
    if (vaultPath) fs.rmSync(vaultPath, { recursive: true, force: true })
  })

  it('#given no stored preference #then minimizeToTray defaults to off', () => {
    vaultPath = createTempVault()

    expect(readPreferences(vaultPath).minimizeToTray).toBe(false)
  })

  it('#given config.json written by an older version #then minimizeToTray reads as off', () => {
    vaultPath = createTempVault()
    fs.writeFileSync(
      path.join(vaultPath, MEMRY_DIR, 'config.json'),
      JSON.stringify({ preferences: { theme: 'dark', editor: { width: 'full' } } })
    )

    expect(readPreferences(vaultPath).minimizeToTray).toBe(false)
  })

  // The whole point: `false` is a value the user chose, not an absence. A `||`
  // or a truthiness check anywhere on this path makes the setting impossible to
  // turn back off.
  it('#given minimizeToTray turned on then off again #then config.json reports off', () => {
    vaultPath = createTempVault()

    writePreferences(vaultPath, { minimizeToTray: true })
    expect(readPreferences(vaultPath).minimizeToTray).toBe(true)

    writePreferences(vaultPath, { minimizeToTray: false })

    expect(readPreferences(vaultPath).minimizeToTray).toBe(false)
    const raw = JSON.parse(fs.readFileSync(path.join(vaultPath, MEMRY_DIR, 'config.json'), 'utf-8'))
    expect(raw.preferences.minimizeToTray).toBe(false)
  })

  it('#given minimizeToTray enabled #when an unrelated preference changes #then it survives', () => {
    vaultPath = createTempVault()
    writePreferences(vaultPath, { minimizeToTray: true })

    writePreferences(vaultPath, { theme: 'dark' })

    expect(readPreferences(vaultPath).minimizeToTray).toBe(true)
  })
})

describe('VaultPreferencesSchema', () => {
  it('#given valid preferences #then parses successfully', () => {
    const input = {
      theme: 'dark' as const,
      fontSize: 'large' as const,
      fontFamily: 'gelasio' as const,
      customFontFamily: 'Iosevka Term',
      accentColor: '#ff0000',
      language: 'tr',
      createInSelectedFolder: false,
      openPagesInNewTab: false,
      minimizeToTray: false,
      editor: {
        width: 'full' as const,
        toolbarMode: 'sticky' as const,
        pdfAdaptToTheme: false,
        spellCheck: false
      }
    }

    const result = VaultPreferencesSchema.parse(input)
    expect(result).toEqual(input)
  })

  it('#given legacy editor width from an older version #then coerces to normal', () => {
    for (const legacy of ['narrow', 'medium', 'wide']) {
      const input = {
        ...VAULT_PREFERENCES_DEFAULTS,
        editor: {
          width: legacy,
          toolbarMode: 'floating' as const,
          spellCheck: false,
          pdfAdaptToTheme: false
        }
      }
      const result = VaultPreferencesSchema.parse(input)
      expect(result.editor.width).toBe('normal')
    }
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
          width: 'full',
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
    expect(prefs.editor.width).toBe('full')
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
        editor: { width: 'normal' }
      }
    }
    fs.writeFileSync(
      path.join(vaultPath, MEMRY_DIR, 'config.json'),
      JSON.stringify(config, null, 2)
    )

    const prefs = readPreferences(vaultPath)
    expect(prefs.editor.width).toBe('normal')
    expect(prefs.editor.toolbarMode).toBe(VAULT_PREFERENCES_DEFAULTS.editor.toolbarMode)
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
    writePreferences(vaultPath, { editor: { width: 'full' } })

    const raw = JSON.parse(fs.readFileSync(path.join(vaultPath, MEMRY_DIR, 'config.json'), 'utf-8'))
    expect(raw.preferences.editor.width).toBe('full')
    expect(raw.preferences.editor.toolbarMode).toBe(VAULT_PREFERENCES_DEFAULTS.editor.toolbarMode)
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
    writePreferences(vaultPath, { editor: { width: 'normal' } })

    const prefs = readPreferences(vaultPath)
    expect(prefs.theme).toBe('dark')
    expect(prefs.language).toBe('tr')
    expect(prefs.editor.width).toBe('normal')
    expect(prefs.editor.toolbarMode).toBe('floating')
  })
})
