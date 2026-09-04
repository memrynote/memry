import { getSetting, setSetting } from '@main/database/queries/settings'
import {
  GENERAL_SETTINGS_DEFAULTS,
  EDITOR_SETTINGS_DEFAULTS
} from '@memry/contracts/settings-schemas'
import type { GeneralSettings, EditorSettings } from '@memry/contracts/settings-schemas'
import { LocaleSchema } from '@memry/contracts/locale-api'
import {
  readPreferences,
  writePreferences,
  hasStoredPreferences,
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

/**
 * Seed config.json from the pre-config.json SQLite settings, once per vault.
 *
 * The marker is config.json's own preferences block. Nothing but this function
 * writes the first one — `writePreferences` and this migration shipped in the
 * same commit, and vault open runs the migration before any other writer can
 * reach the file — so its presence is an exact record that the seeding is done.
 *
 * That has to be the guard because `writeCacheFromPreferences` below refills the
 * SQLite rows from config.json on every launch. Reading them back as a migration
 * source is reading this function's own output, which is why the previous
 * "is config.json still at its defaults" test re-fired on launch after launch.
 * It also under-reported: it compared five of the eleven portable fields, so a
 * vault customised only through, say, `minimizeToTray` looked untouched and the
 * stale SQLite row overwrote a value the user had chosen.
 */
export function migrateSettingsToConfig(db: DataDb, vaultPath: string): void {
  if (hasStoredPreferences(vaultPath)) {
    writeCacheFromPreferences(db, readPreferences(vaultPath))
    return
  }

  const rawGeneral = getSetting(db, 'general')
  const rawEditor = getSetting(db, 'editor')

  if (!rawGeneral && !rawEditor) {
    writeCacheFromPreferences(db, readPreferences(vaultPath))
    return
  }

  const seedPrefs: Partial<VaultPreferences> = {}

  if (rawGeneral) {
    try {
      const general = JSON.parse(rawGeneral) as Partial<GeneralSettings>
      if (general.theme) seedPrefs.theme = general.theme
      if (general.fontSize) seedPrefs.fontSize = general.fontSize
      if (general.fontSizePx !== undefined) {
        seedPrefs.fontSizePx = general.fontSizePx
      }
      if (general.fontFamily) seedPrefs.fontFamily = general.fontFamily
      // Empty string is a real value here ("no custom font"), so this checks for
      // undefined rather than truthiness like the enum fields above.
      if (general.customFontFamily !== undefined) {
        seedPrefs.customFontFamily = general.customFontFamily
      }
      if (general.accentColor) seedPrefs.accentColor = general.accentColor
      if (general.language) seedPrefs.language = general.language
      if (general.createInSelectedFolder !== undefined) {
        seedPrefs.createInSelectedFolder = general.createInSelectedFolder
      }
      if (general.openPagesInNewTab !== undefined) {
        seedPrefs.openPagesInNewTab = general.openPagesInNewTab
      }
      if (general.minimizeToTray !== undefined) {
        seedPrefs.minimizeToTray = general.minimizeToTray
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
      if (editor.toolbarMode) editorSeed.toolbarMode = editor.toolbarMode
      if (editor.spellCheck !== undefined) editorSeed.spellCheck = editor.spellCheck
      if (editor.pdfAdaptToTheme !== undefined) {
        editorSeed.pdfAdaptToTheme = editor.pdfAdaptToTheme
      }
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
  const language = LocaleSchema.safeParse(prefs.language)
  const portableFields: Partial<GeneralSettings> = {
    theme: prefs.theme,
    fontSize: prefs.fontSize,
    fontSizePx: prefs.fontSizePx,
    fontFamily: prefs.fontFamily,
    customFontFamily: prefs.customFontFamily,
    accentColor: prefs.accentColor,
    language: language.success ? language.data : GENERAL_SETTINGS_DEFAULTS.language,
    createInSelectedFolder: prefs.createInSelectedFolder,
    openPagesInNewTab: prefs.openPagesInNewTab,
    minimizeToTray: prefs.minimizeToTray
  }

  const editorCache: EditorSettings = {
    ...EDITOR_SETTINGS_DEFAULTS,
    width: prefs.editor.width,
    toolbarMode: prefs.editor.toolbarMode,
    spellCheck: prefs.editor.spellCheck,
    pdfAdaptToTheme: prefs.editor.pdfAdaptToTheme
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
