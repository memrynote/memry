import { BrowserWindow, ipcMain } from 'electron'
import { LocaleChannels } from '@memry/contracts/ipc-channels'
import { LocaleSchema, SUPPORTED_LOCALES, type Locale } from '@memry/contracts/locale-api'
import { GENERAL_SETTINGS_DEFAULTS, type GeneralSettings } from '@memry/contracts/settings-schemas'
import type { I18nInstance } from '@memry/i18n/main'
import { getDatabase, type DataDb } from '../database'
import { createLogger } from '../lib/logger'
import { getSetting, setSetting } from '../settings/settings-store'
import { getCurrentVaultPath, setStoredLocale } from '../store'
import { writePreferences } from '../vault/vault-preferences'

const logger = createLogger('Locale')
const GENERAL_SETTINGS_KEY = 'general'

export type RebuildMenuFn = (locale: Locale) => void

let activeLocale: Locale = 'en'

export function getActiveLocale(): Locale {
  return activeLocale
}

function readGeneralSettings(db: DataDb): GeneralSettings {
  const raw = getSetting(db, GENERAL_SETTINGS_KEY)
  if (!raw) return { ...GENERAL_SETTINGS_DEFAULTS }

  try {
    return { ...GENERAL_SETTINGS_DEFAULTS, ...JSON.parse(raw) }
  } catch {
    logger.warn('Corrupted general settings, falling back to defaults')
    return { ...GENERAL_SETTINGS_DEFAULTS }
  }
}

function getOptionalDatabase(): DataDb | null {
  try {
    return getDatabase()
  } catch (err) {
    if (err instanceof Error && err.message === 'Database not initialized') {
      return null
    }
    throw err
  }
}

function persistLocale(locale: Locale): void {
  const db = getOptionalDatabase()
  if (db) {
    const settings = readGeneralSettings(db)
    setSetting(db, GENERAL_SETTINGS_KEY, JSON.stringify({ ...settings, language: locale }))
  }

  setStoredLocale(locale)

  const vaultPath = getCurrentVaultPath()
  if (!vaultPath) return

  try {
    writePreferences(vaultPath, { language: locale })
  } catch (err) {
    logger.warn('Failed to write locale to vault preferences', { locale, error: err })
  }
}

let runtime: { i18n: I18nInstance; rebuildMenu: RebuildMenuFn } | null = null

/**
 * The one place a locale becomes live: persist it, swap the main-process i18n
 * language, rebuild the native menu, notify every renderer, and update
 * `activeLocale` so LocaleChannels.Get keeps agreeing with what is persisted.
 *
 * Used by the LocaleChannels.Set IPC (local switch) and by the settings sync
 * handler (a language changed on another device). Deliberately free of any sync
 * enqueue: SettingsSyncManager.updateField() is the only thing that ever pushes
 * a settings item, and nothing reachable from here touches that manager — so
 * applying an inbound locale cannot echo a new write back out.
 *
 * The flip side, and a real gap: a *local* switch does not push either. The
 * language UI (settings/general-section.tsx, vault-onboarding.tsx) calls
 * window.api.locale.set() and never SET_GENERAL_SETTINGS, so nothing in this
 * build populates `general.language` in the synced settings payload. This
 * function is the receiving half only; until the local path enqueues
 * `general.language`, the sync handler's applySyncedLocale() never sees a value.
 */
export async function applyLocale(locale: Locale): Promise<void> {
  if (locale === activeLocale) return

  if (!runtime) {
    logger.warn('Locale apply requested before handlers were registered', { locale })
    return
  }

  logger.info('Changing locale', { from: activeLocale, to: locale })

  try {
    persistLocale(locale)
    await runtime.i18n.changeLanguage(locale)
    runtime.rebuildMenu(locale)

    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(LocaleChannels.Changed, locale)
    }

    activeLocale = locale
    logger.info('Locale changed', { locale })
  } catch (err) {
    logger.error('Locale change failed', { locale, error: err })
    throw err
  }
}

export function registerLocaleHandlers(i18n: I18nInstance, rebuildMenu: RebuildMenuFn): void {
  runtime = { i18n, rebuildMenu }

  const initialLocale = LocaleSchema.safeParse(i18n.language)
  activeLocale = initialLocale.success ? initialLocale.data : 'en'

  ipcMain.handle(LocaleChannels.Get, () => activeLocale)

  ipcMain.handle(LocaleChannels.List, () => SUPPORTED_LOCALES)

  ipcMain.handle(LocaleChannels.Set, async (_event, candidate: unknown): Promise<void> => {
    await applyLocale(LocaleSchema.parse(candidate))
  })
}
