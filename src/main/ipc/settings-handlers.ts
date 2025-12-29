/**
 * Settings IPC Handlers
 *
 * Handles IPC requests for app settings, including journal settings and AI settings.
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
  JOURNAL_DEFAULT_TEMPLATE: 'journal.defaultTemplate',
  AI_OPENAI_API_KEY: 'ai.openaiApiKey',
  AI_ENABLED: 'ai.enabled',
  AI_EMBEDDING_MODEL: 'ai.embeddingModel'
} as const

// ============================================================================
// Journal Settings Interface
// ============================================================================

export interface JournalSettings {
  defaultTemplate: string | null
}

// ============================================================================
// AI Settings Interface
// ============================================================================

export interface AISettings {
  openaiApiKey: string | null
  enabled: boolean
  embeddingModel: string
}

/** Default AI settings values */
const DEFAULT_AI_SETTINGS: AISettings = {
  openaiApiKey: null,
  enabled: true,
  embeddingModel: 'text-embedding-3-small'
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

  // Get AI settings
  ipcMain.handle(SettingsChannels.invoke.GET_AI_SETTINGS, async () => {
    const db = getDbOrNull()
    if (!db) {
      return DEFAULT_AI_SETTINGS
    }

    const openaiApiKey = getSetting(db, SETTINGS_KEYS.AI_OPENAI_API_KEY)
    const enabledStr = getSetting(db, SETTINGS_KEYS.AI_ENABLED)
    const embeddingModel = getSetting(db, SETTINGS_KEYS.AI_EMBEDDING_MODEL)

    return {
      openaiApiKey: openaiApiKey || null,
      enabled: enabledStr !== 'false', // Default to true
      embeddingModel: embeddingModel || DEFAULT_AI_SETTINGS.embeddingModel
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

      if (settings.openaiApiKey !== undefined) {
        if (settings.openaiApiKey === null || settings.openaiApiKey === '') {
          deleteSetting(db, SETTINGS_KEYS.AI_OPENAI_API_KEY)
        } else {
          setSetting(db, SETTINGS_KEYS.AI_OPENAI_API_KEY, settings.openaiApiKey)
        }
      }

      if (settings.enabled !== undefined) {
        setSetting(db, SETTINGS_KEYS.AI_ENABLED, settings.enabled ? 'true' : 'false')
      }

      if (settings.embeddingModel !== undefined) {
        setSetting(db, SETTINGS_KEYS.AI_EMBEDDING_MODEL, settings.embeddingModel)
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

  // Test AI connection
  ipcMain.handle(SettingsChannels.invoke.TEST_AI_CONNECTION, async () => {
    const db = getDbOrNull()
    if (!db) {
      return { success: false, error: 'No vault open' }
    }

    const apiKey = getSetting(db, SETTINGS_KEYS.AI_OPENAI_API_KEY)
    if (!apiKey) {
      return { success: false, error: 'No API key configured' }
    }

    try {
      // Dynamic import to avoid loading OpenAI when not needed
      const { default: OpenAI } = await import('openai')
      const openai = new OpenAI({ apiKey })

      // Test with a minimal embedding request
      await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: 'test',
        dimensions: 256 // Use smaller dimension for test
      })

      return { success: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      console.error('[AI] Connection test failed:', message)
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
  ipcMain.removeHandler(SettingsChannels.invoke.TEST_AI_CONNECTION)
  ipcMain.removeHandler(SettingsChannels.invoke.REINDEX_EMBEDDINGS)

  console.log('Settings IPC handlers unregistered')
}
