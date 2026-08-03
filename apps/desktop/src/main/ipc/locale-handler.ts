import { ipcMain } from 'electron'
import { LocaleChannels } from '@memry/contracts/ipc-channels'
import { LocaleSchema, SUPPORTED_LOCALES, type Locale } from '@memry/contracts/locale-api'
import { GENERAL_SETTINGS_DEFAULTS, type GeneralSettings } from '@memry/contracts/settings-schemas'
import type { I18nInstance } from '@memry/i18n/main'
import { getDatabase, type DataDb } from '../database'
import { createLogger } from '../lib/logger'
import { broadcastToAllWindows } from '../lib/window-broadcast'
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

export function registerLocaleHandlers(i18n: I18nInstance, rebuildMenu: RebuildMenuFn): void {
  const initialLocale = LocaleSchema.safeParse(i18n.language)
  activeLocale = initialLocale.success ? initialLocale.data : 'en'

  ipcMain.handle(LocaleChannels.Get, () => activeLocale)

  ipcMain.handle(LocaleChannels.List, () => SUPPORTED_LOCALES)

  ipcMain.handle(LocaleChannels.Set, async (_event, candidate: unknown): Promise<void> => {
    const locale = LocaleSchema.parse(candidate)
    if (locale === activeLocale) return

    logger.info('Changing locale', { from: activeLocale, to: locale })

    try {
      persistLocale(locale)
      await i18n.changeLanguage(locale)
      rebuildMenu(locale)

      broadcastToAllWindows(LocaleChannels.Changed, locale)

      activeLocale = locale
      logger.info('Locale changed', { locale })
    } catch (err) {
      logger.error('Locale change failed', { locale, error: err })
      throw err
    }
  })
}
