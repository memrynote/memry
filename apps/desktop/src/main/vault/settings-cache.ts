import { getSetting, setSetting } from '@main/database/queries/settings'
import {
  GENERAL_SETTINGS_DEFAULTS,
  EDITOR_SETTINGS_DEFAULTS
} from '@memry/contracts/settings-schemas'
import type { GeneralSettings, EditorSettings } from '@memry/contracts/settings-schemas'
import {
  readPreferences,
  writePreferences,
  VAULT_PREFERENCES_DEFAULTS,
  type VaultPreferences
} from './vault-preferences'
import { createLogger } from '../lib/logger'
import type { DataDb } from '../database'

const log = createLogger('SettingsCache')

export function populateSettingsCacheFromConfig(db: DataDb, vaultPath: string): void {
  const prefs = readPreferences(vaultPath)
  writeCacheFromPreferences(db, prefs)
}

export function migrateSettingsToConfig(db: DataDb, vaultPath: string): void {
  const prefs = readPreferences(vaultPath)

  const isDefault =
    prefs.theme === VAULT_PREFERENCES_DEFAULTS.theme &&
    prefs.fontSize === VAULT_PREFERENCES_DEFAULTS.fontSize &&
    prefs.fontFamily === VAULT_PREFERENCES_DEFAULTS.fontFamily &&
    prefs.accentColor === VAULT_PREFERENCES_DEFAULTS.accentColor &&
    prefs.language === VAULT_PREFERENCES_DEFAULTS.language

  if (!isDefault) {
    writeCacheFromPreferences(db, prefs)
    return
  }

  const rawGeneral = getSetting(db, 'general')
  const rawEditor = getSetting(db, 'editor')

  if (!rawGeneral && !rawEditor) {
    writeCacheFromPreferences(db, prefs)
    return
  }

  const seedPrefs: Partial<VaultPreferences> = {}

  if (rawGeneral) {
    try {
      const general = JSON.parse(rawGeneral) as Partial<GeneralSettings>
      if (general.theme) seedPrefs.theme = general.theme
      if (general.fontSize) seedPrefs.fontSize = general.fontSize
      if (general.fontFamily) seedPrefs.fontFamily = general.fontFamily
      if (general.accentColor) seedPrefs.accentColor = general.accentColor
      if (general.language) seedPrefs.language = general.language
      if (general.createInSelectedFolder !== undefined) {
        seedPrefs.createInSelectedFolder = general.createInSelectedFolder
      }
    } catch {
      log.warn('Failed to parse existing general settings for migration')
    }
  }

  if (rawEditor) {
    try {
      const editor = JSON.parse(rawEditor) as Partial<EditorSettings>
      const editorSeed: Partial<EditorSettings> = {}
      if (editor.width) editorSeed.width = editor.width
      if (editor.spellCheck !== undefined) editorSeed.spellCheck = editor.spellCheck
      if (editor.autoSaveDelay !== undefined) editorSeed.autoSaveDelay = editor.autoSaveDelay
      if (editor.showWordCount !== undefined) editorSeed.showWordCount = editor.showWordCount
      if (editor.toolbarMode) editorSeed.toolbarMode = editor.toolbarMode
      if (Object.keys(editorSeed).length > 0) {
        seedPrefs.editor = { ...EDITOR_SETTINGS_DEFAULTS, ...editorSeed }
      }
    } catch {
      log.warn('Failed to parse existing editor settings for migration')
    }
  }

  if (Object.keys(seedPrefs).length > 0) {
    log.info('Migrating settings from SQLite to config.json (one-time)')
    writePreferences(vaultPath, seedPrefs)
  }

  const finalPrefs = readPreferences(vaultPath)
  writeCacheFromPreferences(db, finalPrefs)
}

export function writeCacheFromPreferences(db: DataDb, prefs: VaultPreferences): void {
  const portableFields: Partial<GeneralSettings> = {
    theme: prefs.theme,
    fontSize: prefs.fontSize,
    fontFamily: prefs.fontFamily,
    accentColor: prefs.accentColor,
    language: prefs.language,
    createInSelectedFolder: prefs.createInSelectedFolder
  }

  const editorCache: EditorSettings = {
    ...EDITOR_SETTINGS_DEFAULTS,
    width: prefs.editor.width,
    spellCheck: prefs.editor.spellCheck,
    autoSaveDelay: prefs.editor.autoSaveDelay,
    showWordCount: prefs.editor.showWordCount,
    toolbarMode: prefs.editor.toolbarMode
  }

  const existingGeneral = getSetting(db, 'general')
  let mergedGeneral: GeneralSettings
  if (existingGeneral) {
    try {
      const existing = JSON.parse(existingGeneral) as GeneralSettings
      mergedGeneral = { ...existing, ...portableFields }
    } catch {
      mergedGeneral = { ...GENERAL_SETTINGS_DEFAULTS, ...portableFields }
    }
  } else {
    mergedGeneral = { ...GENERAL_SETTINGS_DEFAULTS, ...portableFields }
  }

  setSetting(db, 'general', JSON.stringify(mergedGeneral))
  setSetting(db, 'editor', JSON.stringify(editorCache))
}

export function hasPreferencesInConfig(vaultPath: string): boolean {
  const prefs = readPreferences(vaultPath)
  return prefs !== VAULT_PREFERENCES_DEFAULTS
}
