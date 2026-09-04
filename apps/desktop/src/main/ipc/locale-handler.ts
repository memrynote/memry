import { ipcMain } from 'electron'
import { broadcastToAllWindows } from '../lib/window-broadcast'
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
    // Persist only once the runtime switch has actually succeeded. Writing
    // first meant a rejected changeLanguage (a locale bundle that fails to
    // load) left config.json and the store holding a language the app never
    // switched to, and `activeLocale` disagreeing with both — the same drift
    // this path exists to prevent, just on the error branch.
    await runtime.i18n.changeLanguage(locale)
    runtime.rebuildMenu(locale)

    broadcastToAllWindows(LocaleChannels.Changed, locale)

    activeLocale = locale
    persistLocale(locale)
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

  // Registered here rather than lazily: the preload calls this synchronously
  // during window load, which happens after registerAllHandlers() but while the
  // rest of the whenReady chain (vault open) is still running.
  ipcMain.on(LocaleChannels.GetStartupSync, (event) => {
    event.returnValue = activeLocale
  })

  ipcMain.handle(LocaleChannels.List, () => SUPPORTED_LOCALES)

  ipcMain.handle(LocaleChannels.Set, async (_event, candidate: unknown): Promise<void> => {
    await applyLocale(LocaleSchema.parse(candidate))
  })
}
