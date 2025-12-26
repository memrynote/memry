/**
 * Settings IPC Handlers
 *
 * Handles IPC requests for app settings, including journal settings.
 *
 * @module main/ipc/settings-handlers
 */

import { ipcMain, BrowserWindow } from 'electron'
import { SettingsChannels } from '@shared/ipc-channels'
import { getDatabase } from '../database'
import { getSetting, setSetting, deleteSetting } from '@shared/db/queries/settings'

// ============================================================================
// Settings Keys
// ============================================================================

const SETTINGS_KEYS = {
  JOURNAL_DEFAULT_TEMPLATE: 'journal.defaultTemplate'
} as const

// ============================================================================
// Journal Settings Interface
// ============================================================================

export interface JournalSettings {
  defaultTemplate: string | null
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get database if available, returning null otherwise.
 */
function getDbOrNull() {
  try {
    return getDatabase()
  } catch {
    return null
  }
}

// ============================================================================
// Handler Registration
// ============================================================================

/**
 * Register all settings-related IPC handlers.
 */
export function registerSettingsHandlers(): void {
  // Get a setting by key
  ipcMain.handle(SettingsChannels.invoke.GET, async (_event, key: string) => {
    const db = getDbOrNull()
    if (!db) {
      return null
    }
    return getSetting(db, key)
  })

  // Set a setting value
  ipcMain.handle(
    SettingsChannels.invoke.SET,
    async (_event, { key, value }: { key: string; value: string }) => {
      const db = getDbOrNull()
      if (!db) {
        return { success: false, error: 'No vault open' }
      }
      setSetting(db, key, value)

      // Emit settings changed event
      BrowserWindow.getAllWindows().forEach((win) => {
        win.webContents.send(SettingsChannels.events.CHANGED, { key, value })
      })

      return { success: true }
    }
  )

  // Get journal settings
  ipcMain.handle(SettingsChannels.invoke.GET_JOURNAL_SETTINGS, async () => {
    const db = getDbOrNull()
    if (!db) {
      return { defaultTemplate: null }
    }

    const defaultTemplate = getSetting(db, SETTINGS_KEYS.JOURNAL_DEFAULT_TEMPLATE)
    return { defaultTemplate }
  })

  // Set journal settings
  ipcMain.handle(
    SettingsChannels.invoke.SET_JOURNAL_SETTINGS,
    async (_event, settings: Partial<JournalSettings>) => {
      const db = getDbOrNull()
      if (!db) {
        return { success: false, error: 'No vault open' }
      }

      if (settings.defaultTemplate !== undefined) {
        if (settings.defaultTemplate === null) {
          // Clear the setting
          deleteSetting(db, SETTINGS_KEYS.JOURNAL_DEFAULT_TEMPLATE)
        } else {
          setSetting(db, SETTINGS_KEYS.JOURNAL_DEFAULT_TEMPLATE, settings.defaultTemplate)
        }
      }

      // Emit settings changed event
      BrowserWindow.getAllWindows().forEach((win) => {
        win.webContents.send(SettingsChannels.events.CHANGED, {
          key: 'journal',
          value: settings
        })
      })

      return { success: true }
    }
  )

  console.log('Settings IPC handlers registered')
}

/**
 * Unregister all settings-related IPC handlers.
 */
export function unregisterSettingsHandlers(): void {
  ipcMain.removeHandler(SettingsChannels.invoke.GET)
  ipcMain.removeHandler(SettingsChannels.invoke.SET)
  ipcMain.removeHandler(SettingsChannels.invoke.GET_JOURNAL_SETTINGS)
  ipcMain.removeHandler(SettingsChannels.invoke.SET_JOURNAL_SETTINGS)

  console.log('Settings IPC handlers unregistered')
}
