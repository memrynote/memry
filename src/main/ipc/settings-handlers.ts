/**
 * Settings IPC Handlers
 *
 * Handles IPC requests for app settings, including journal settings and AI settings.
 * AI uses local embeddings with all-MiniLM-L6-v2 model (no API key required).
 *
 * @module main/ipc/settings-handlers
 */

import { ipcMain, BrowserWindow } from 'electron'
import { SettingsChannels } from '@shared/ipc-channels'
import { getDatabase } from '../database'
import { getSetting, setSetting, deleteSetting } from '@shared/db/queries/settings'
import { initEmbeddingModel, getModelInfo, isModelLoaded, isModelLoading } from '../lib/embeddings'

// ============================================================================
// Settings Keys
// ============================================================================

const SETTINGS_KEYS = {
  JOURNAL_DEFAULT_TEMPLATE: 'journal.defaultTemplate',
  AI_ENABLED: 'ai.enabled',
  // Tab settings
  TAB_PREVIEW_MODE: 'tabs.previewMode',
  TAB_RESTORE_SESSION: 'tabs.restoreSessionOnStart',
  TAB_CLOSE_BUTTON: 'tabs.tabCloseButton'
} as const

// ============================================================================
// Journal Settings Interface
// ============================================================================

export interface JournalSettings {
  defaultTemplate: string | null
}

// ============================================================================
// AI Settings Interface (Simplified - no API key needed)
// ============================================================================

export interface AISettings {
  enabled: boolean
}

export interface AIModelStatus {
  name: string
  dimension: number
  loaded: boolean
  loading: boolean
  error: string | null
  embeddingCount?: number
}

/** Default AI settings values */
const DEFAULT_AI_SETTINGS: AISettings = {
  enabled: true
}

// ============================================================================
// Tab Settings Interface
// ============================================================================

export interface TabSettings {
  /** Single-click opens preview, double-click opens permanent */
  previewMode: boolean
  /** Restore tabs from last session on app start */
  restoreSessionOnStart: boolean
  /** When to show close button: always, on hover, or only on active tab */
  tabCloseButton: 'always' | 'hover' | 'active'
}

/** Default tab settings values */
const DEFAULT_TAB_SETTINGS: TabSettings = {
  previewMode: false,
  restoreSessionOnStart: true,
  tabCloseButton: 'hover'
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

  // Get AI settings (simplified - just enabled flag)
  ipcMain.handle(SettingsChannels.invoke.GET_AI_SETTINGS, async () => {
    const db = getDbOrNull()
    if (!db) {
      return DEFAULT_AI_SETTINGS
    }

    const enabledStr = getSetting(db, SETTINGS_KEYS.AI_ENABLED)

    return {
      enabled: enabledStr !== 'false' // Default to true
    }
  })

  // Set AI settings
  ipcMain.handle(
    SettingsChannels.invoke.SET_AI_SETTINGS,
    async (_event, settings: Partial<AISettings>) => {
      const db = getDbOrNull()
      if (!db) {
        return { success: false, error: 'No vault open' }
      }

      if (settings.enabled !== undefined) {
        setSetting(db, SETTINGS_KEYS.AI_ENABLED, settings.enabled ? 'true' : 'false')
      }

      // Emit settings changed event
      BrowserWindow.getAllWindows().forEach((win) => {
        win.webContents.send(SettingsChannels.events.CHANGED, {
          key: 'ai',
          value: settings
        })
      })

      return { success: true }
    }
  )

  // Get AI model status
  ipcMain.handle(SettingsChannels.invoke.GET_AI_MODEL_STATUS, async () => {
    const modelInfo = getModelInfo()

    // Get embedding count if database is available
    let embeddingCount = 0
    try {
      const { getEmbeddingCount } = await import('../inbox/suggestions')
      embeddingCount = getEmbeddingCount()
    } catch {
      // Ignore - database might not be open
    }

    return {
      ...modelInfo,
      embeddingCount
    } as AIModelStatus
  })

  // Load AI model
  ipcMain.handle(SettingsChannels.invoke.LOAD_AI_MODEL, async () => {
    if (isModelLoaded()) {
      return { success: true, message: 'Model already loaded' }
    }

    if (isModelLoading()) {
      return { success: false, error: 'Model is already loading' }
    }

    try {
      const success = await initEmbeddingModel()
      if (success) {
        return { success: true }
      } else {
        const info = getModelInfo()
        return { success: false, error: info.error || 'Failed to load model' }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      return { success: false, error: message }
    }
  })

  // Reindex embeddings
  ipcMain.handle(SettingsChannels.invoke.REINDEX_EMBEDDINGS, async () => {
    try {
      // Import dynamically to avoid circular dependencies
      const { reindexAllEmbeddings } = await import('../inbox/suggestions')
      const result = await reindexAllEmbeddings()
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      console.error('[AI] Reindex failed:', message)
      return { success: false, error: message, computed: 0, skipped: 0 }
    }
  })

  // Get tab settings
  ipcMain.handle(SettingsChannels.invoke.GET_TAB_SETTINGS, async () => {
    const db = getDbOrNull()
    if (!db) {
      return DEFAULT_TAB_SETTINGS
    }

    const previewModeStr = getSetting(db, SETTINGS_KEYS.TAB_PREVIEW_MODE)
    const restoreSessionStr = getSetting(db, SETTINGS_KEYS.TAB_RESTORE_SESSION)
    const closeButtonStr = getSetting(db, SETTINGS_KEYS.TAB_CLOSE_BUTTON)

    return {
      previewMode:
        previewModeStr !== null ? previewModeStr === 'true' : DEFAULT_TAB_SETTINGS.previewMode,
      restoreSessionOnStart:
        restoreSessionStr !== null
          ? restoreSessionStr === 'true'
          : DEFAULT_TAB_SETTINGS.restoreSessionOnStart,
      tabCloseButton:
        (closeButtonStr as TabSettings['tabCloseButton']) ?? DEFAULT_TAB_SETTINGS.tabCloseButton
    }
  })

  // Set tab settings
  ipcMain.handle(
    SettingsChannels.invoke.SET_TAB_SETTINGS,
    async (_event, settings: Partial<TabSettings>) => {
      const db = getDbOrNull()
      if (!db) {
        return { success: false, error: 'No vault open' }
      }

      if (settings.previewMode !== undefined) {
        setSetting(db, SETTINGS_KEYS.TAB_PREVIEW_MODE, settings.previewMode ? 'true' : 'false')
      }
      if (settings.restoreSessionOnStart !== undefined) {
        setSetting(
          db,
          SETTINGS_KEYS.TAB_RESTORE_SESSION,
          settings.restoreSessionOnStart ? 'true' : 'false'
        )
      }
      if (settings.tabCloseButton !== undefined) {
        setSetting(db, SETTINGS_KEYS.TAB_CLOSE_BUTTON, settings.tabCloseButton)
      }

      // Emit settings changed event
      BrowserWindow.getAllWindows().forEach((win) => {
        win.webContents.send(SettingsChannels.events.CHANGED, {
          key: 'tabs',
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
  ipcMain.removeHandler(SettingsChannels.invoke.GET_AI_SETTINGS)
  ipcMain.removeHandler(SettingsChannels.invoke.SET_AI_SETTINGS)
  ipcMain.removeHandler(SettingsChannels.invoke.GET_AI_MODEL_STATUS)
  ipcMain.removeHandler(SettingsChannels.invoke.LOAD_AI_MODEL)
  ipcMain.removeHandler(SettingsChannels.invoke.REINDEX_EMBEDDINGS)
  ipcMain.removeHandler(SettingsChannels.invoke.GET_TAB_SETTINGS)
  ipcMain.removeHandler(SettingsChannels.invoke.SET_TAB_SETTINGS)

  console.log('Settings IPC handlers unregistered')
}
