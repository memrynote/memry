/**
 * Settings IPC Handlers
 *
 * Handles IPC requests for app settings, including journal settings and AI settings.
 * AI uses local embeddings with all-MiniLM-L6-v2 model (no API key required).
 *
 * @module main/ipc/settings-handlers
 */

import { ipcMain, BrowserWindow, app } from 'electron'
import { SettingsChannels } from '@memry/contracts/ipc-channels'
import {
  GENERAL_SETTINGS_DEFAULTS,
  EDITOR_SETTINGS_DEFAULTS,
  TASK_SETTINGS_DEFAULTS,
  KEYBOARD_SHORTCUTS_DEFAULTS,
  SYNC_SETTINGS_DEFAULTS,
  BACKUP_SETTINGS_DEFAULTS
} from '@memry/contracts/settings-schemas'
import type {
  GeneralSettings,
  EditorSettings,
  TaskSettings,
  KeyboardShortcuts,
  SyncSettings,
  BackupSettings
} from '@memry/contracts/settings-schemas'
import { createLogger } from '../lib/logger'
import { getDatabase } from '../database'
import { getSetting, setSetting, deleteSetting } from '@main/database/queries/settings'
import { initEmbeddingModel, getModelInfo, isModelLoaded, isModelLoading } from '../lib/embeddings'

// ============================================================================
// Settings Keys
// ============================================================================

const logger = createLogger('IPC:Settings')

const SETTINGS_KEYS = {
  JOURNAL_DEFAULT_TEMPLATE: 'journal.defaultTemplate',
  JOURNAL_SHOW_SCHEDULE: 'journal.showSchedule',
  JOURNAL_SHOW_TASKS: 'journal.showTasks',
  JOURNAL_SHOW_AI_CONNECTIONS: 'journal.showAIConnections',
  JOURNAL_SHOW_STATS_FOOTER: 'journal.showStatsFooter',
  AI_ENABLED: 'ai.enabled',
  // Tab settings
  TAB_PREVIEW_MODE: 'tabs.previewMode',
  TAB_RESTORE_SESSION: 'tabs.restoreSessionOnStart',
  TAB_CLOSE_BUTTON: 'tabs.tabCloseButton',
  // Note editor settings
  NOTE_EDITOR_TOOLBAR_MODE: 'noteEditor.toolbarMode'
} as const

// ============================================================================
// Journal Settings Interface
// ============================================================================

export interface JournalSettings {
  defaultTemplate: string | null
  showSchedule: boolean
  showTasks: boolean
  showAIConnections: boolean
  showStatsFooter: boolean
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
// Note Editor Settings Interface
// ============================================================================

export interface NoteEditorSettings {
  /** Toolbar display mode: floating (on selection) or sticky (always visible) */
  toolbarMode: 'floating' | 'sticky'
}

/** Default note editor settings values */
const DEFAULT_NOTE_EDITOR_SETTINGS: NoteEditorSettings = {
  toolbarMode: 'floating'
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

/**
 * Read a JSON-blob settings group with corruption recovery (T015).
 * If parse fails, deletes corrupted key and returns defaults.
 */
function readGroupSettings<T extends Record<string, unknown>>(groupKey: string, defaults: T): T {
  const db = getDbOrNull()
  if (!db) return { ...defaults }

  const raw = getSetting(db, groupKey)
  if (!raw) return { ...defaults }

  try {
    const parsed = JSON.parse(raw) as Partial<T>
    return { ...defaults, ...parsed }
  } catch {
    logger.warn(`Corrupted settings for "${groupKey}", resetting to defaults`)
    deleteSetting(db, groupKey)
    return { ...defaults }
  }
}

/**
 * Write a partial update to a JSON-blob settings group.
 * Merges with existing values and broadcasts change event.
 */
function writeGroupSettings<T extends Record<string, unknown>>(
  groupKey: string,
  defaults: T,
  updates: Partial<T>
): { success: boolean; error?: string } {
  const db = getDbOrNull()
  if (!db) return { success: false, error: 'No vault open' }

  const current = readGroupSettings(groupKey, defaults)
  const updated = { ...current, ...updates }
  setSetting(db, groupKey, JSON.stringify(updated))

  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send(SettingsChannels.events.CHANGED, {
      key: groupKey,
      value: updates
    })
  })

  return { success: true }
}

// ============================================================================
// Handler Registration
// ============================================================================

/**
 * Register all settings-related IPC handlers.
 */
export function registerSettingsHandlers(): void {
  // Get a setting by key
  ipcMain.handle(SettingsChannels.invoke.GET, (_event, key: string) => {
    const db = getDbOrNull()
    if (!db) {
      return null
    }
    return getSetting(db, key)
  })

  // Set a setting value
  ipcMain.handle(
    SettingsChannels.invoke.SET,
    (_event, { key, value }: { key: string; value: string }) => {
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
  ipcMain.handle(SettingsChannels.invoke.GET_JOURNAL_SETTINGS, () => {
    const db = getDbOrNull()
    if (!db) {
      return {
        defaultTemplate: null,
        showSchedule: true,
        showTasks: true,
        showAIConnections: true,
        showStatsFooter: false
      }
    }

    const defaultTemplate = getSetting(db, SETTINGS_KEYS.JOURNAL_DEFAULT_TEMPLATE)
    const showScheduleStr = getSetting(db, SETTINGS_KEYS.JOURNAL_SHOW_SCHEDULE)
    const showTasksStr = getSetting(db, SETTINGS_KEYS.JOURNAL_SHOW_TASKS)
    const showAIConnectionsStr = getSetting(db, SETTINGS_KEYS.JOURNAL_SHOW_AI_CONNECTIONS)
    const showStatsFooterStr = getSetting(db, SETTINGS_KEYS.JOURNAL_SHOW_STATS_FOOTER)

    return {
      defaultTemplate,
      showSchedule: showScheduleStr !== 'false', // Default true
      showTasks: showTasksStr !== 'false', // Default true
      showAIConnections: showAIConnectionsStr !== 'false', // Default true
      showStatsFooter: showStatsFooterStr === 'true' // Default false
    }
  })

  // Set journal settings
  ipcMain.handle(
    SettingsChannels.invoke.SET_JOURNAL_SETTINGS,
    (_event, settings: Partial<JournalSettings>) => {
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

      // Handle sidebar visibility settings
      if (settings.showSchedule !== undefined) {
        setSetting(
          db,
          SETTINGS_KEYS.JOURNAL_SHOW_SCHEDULE,
          settings.showSchedule ? 'true' : 'false'
        )
      }
      if (settings.showTasks !== undefined) {
        setSetting(db, SETTINGS_KEYS.JOURNAL_SHOW_TASKS, settings.showTasks ? 'true' : 'false')
      }
      if (settings.showAIConnections !== undefined) {
        setSetting(
          db,
          SETTINGS_KEYS.JOURNAL_SHOW_AI_CONNECTIONS,
          settings.showAIConnections ? 'true' : 'false'
        )
      }
      if (settings.showStatsFooter !== undefined) {
        setSetting(
          db,
          SETTINGS_KEYS.JOURNAL_SHOW_STATS_FOOTER,
          settings.showStatsFooter ? 'true' : 'false'
        )
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
  ipcMain.handle(SettingsChannels.invoke.GET_AI_SETTINGS, () => {
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
    (_event, settings: Partial<AISettings>) => {
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
      logger.error('Reindex failed:', message)
      return { success: false, error: message, computed: 0, skipped: 0 }
    }
  })

  // Get tab settings
  ipcMain.handle(SettingsChannels.invoke.GET_TAB_SETTINGS, () => {
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
    (_event, settings: Partial<TabSettings>) => {
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

  // Get note editor settings
  ipcMain.handle(SettingsChannels.invoke.GET_NOTE_EDITOR_SETTINGS, () => {
    const db = getDbOrNull()
    if (!db) {
      return DEFAULT_NOTE_EDITOR_SETTINGS
    }

    const toolbarModeStr = getSetting(db, SETTINGS_KEYS.NOTE_EDITOR_TOOLBAR_MODE)

    return {
      toolbarMode:
        (toolbarModeStr as NoteEditorSettings['toolbarMode']) ??
        DEFAULT_NOTE_EDITOR_SETTINGS.toolbarMode
    }
  })

  // Set note editor settings
  ipcMain.handle(
    SettingsChannels.invoke.SET_NOTE_EDITOR_SETTINGS,
    (_event, settings: Partial<NoteEditorSettings>) => {
      const db = getDbOrNull()
      if (!db) {
        return { success: false, error: 'No vault open' }
      }

      if (settings.toolbarMode !== undefined) {
        setSetting(db, SETTINGS_KEYS.NOTE_EDITOR_TOOLBAR_MODE, settings.toolbarMode)
      }

      // Emit settings changed event
      BrowserWindow.getAllWindows().forEach((win) => {
        win.webContents.send(SettingsChannels.events.CHANGED, {
          key: 'noteEditor',
          value: settings
        })
      })

      return { success: true }
    }
  )

  // ==========================================================================
  // New settings groups (JSON blob per group with corruption recovery)
  // ==========================================================================

  ipcMain.handle(SettingsChannels.invoke.GET_GENERAL_SETTINGS, () =>
    readGroupSettings('general', GENERAL_SETTINGS_DEFAULTS)
  )
  ipcMain.handle(
    SettingsChannels.invoke.SET_GENERAL_SETTINGS,
    (_event, updates: Partial<GeneralSettings>) => {
      const result = writeGroupSettings('general', GENERAL_SETTINGS_DEFAULTS, updates)
      if (result.success && updates.startOnBoot !== undefined) {
        try {
          app.setLoginItemSettings({ openAtLogin: updates.startOnBoot })
          logger.info(`Start on boot ${updates.startOnBoot ? 'enabled' : 'disabled'}`)
        } catch (err) {
          logger.warn('Failed to set login item:', err)
        }
      }
      return result
    }
  )

  ipcMain.handle(SettingsChannels.invoke.GET_EDITOR_SETTINGS, () =>
    readGroupSettings('editor', EDITOR_SETTINGS_DEFAULTS)
  )
  ipcMain.handle(
    SettingsChannels.invoke.SET_EDITOR_SETTINGS,
    (_event, updates: Partial<EditorSettings>) =>
      writeGroupSettings('editor', EDITOR_SETTINGS_DEFAULTS, updates)
  )

  ipcMain.handle(SettingsChannels.invoke.GET_TASK_SETTINGS, () =>
    readGroupSettings('tasks', TASK_SETTINGS_DEFAULTS)
  )
  ipcMain.handle(
    SettingsChannels.invoke.SET_TASK_SETTINGS,
    (_event, updates: Partial<TaskSettings>) =>
      writeGroupSettings('tasks', TASK_SETTINGS_DEFAULTS, updates)
  )

  ipcMain.handle(SettingsChannels.invoke.GET_KEYBOARD_SETTINGS, () =>
    readGroupSettings('keyboard', KEYBOARD_SHORTCUTS_DEFAULTS)
  )
  ipcMain.handle(
    SettingsChannels.invoke.SET_KEYBOARD_SETTINGS,
    (_event, updates: Partial<KeyboardShortcuts>) =>
      writeGroupSettings('keyboard', KEYBOARD_SHORTCUTS_DEFAULTS, updates)
  )

  ipcMain.handle(SettingsChannels.invoke.GET_SYNC_SETTINGS, () =>
    readGroupSettings('sync', SYNC_SETTINGS_DEFAULTS)
  )
  ipcMain.handle(
    SettingsChannels.invoke.SET_SYNC_SETTINGS,
    (_event, updates: Partial<SyncSettings>) =>
      writeGroupSettings('sync', SYNC_SETTINGS_DEFAULTS, updates)
  )

  ipcMain.handle(SettingsChannels.invoke.GET_BACKUP_SETTINGS, () =>
    readGroupSettings('backup', BACKUP_SETTINGS_DEFAULTS)
  )
  ipcMain.handle(
    SettingsChannels.invoke.SET_BACKUP_SETTINGS,
    (_event, updates: Partial<BackupSettings>) =>
      writeGroupSettings('backup', BACKUP_SETTINGS_DEFAULTS, updates)
  )

  // Keyboard shortcuts: reset to defaults
  ipcMain.handle(SettingsChannels.invoke.RESET_KEYBOARD_SETTINGS, () => {
    const db = getDbOrNull()
    if (!db) {
      return { success: false, error: 'No vault open' }
    }

    deleteSetting(db, 'keyboard')

    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send(SettingsChannels.events.CHANGED, {
        key: 'keyboard',
        value: KEYBOARD_SHORTCUTS_DEFAULTS
      })
    })

    return { success: true }
  })

  logger.info('Settings handlers registered')
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
  ipcMain.removeHandler(SettingsChannels.invoke.GET_NOTE_EDITOR_SETTINGS)
  ipcMain.removeHandler(SettingsChannels.invoke.SET_NOTE_EDITOR_SETTINGS)
  // New settings groups
  ipcMain.removeHandler(SettingsChannels.invoke.GET_GENERAL_SETTINGS)
  ipcMain.removeHandler(SettingsChannels.invoke.SET_GENERAL_SETTINGS)
  ipcMain.removeHandler(SettingsChannels.invoke.GET_EDITOR_SETTINGS)
  ipcMain.removeHandler(SettingsChannels.invoke.SET_EDITOR_SETTINGS)
  ipcMain.removeHandler(SettingsChannels.invoke.GET_TASK_SETTINGS)
  ipcMain.removeHandler(SettingsChannels.invoke.SET_TASK_SETTINGS)
  ipcMain.removeHandler(SettingsChannels.invoke.GET_KEYBOARD_SETTINGS)
  ipcMain.removeHandler(SettingsChannels.invoke.SET_KEYBOARD_SETTINGS)
  ipcMain.removeHandler(SettingsChannels.invoke.RESET_KEYBOARD_SETTINGS)
  ipcMain.removeHandler(SettingsChannels.invoke.GET_SYNC_SETTINGS)
  ipcMain.removeHandler(SettingsChannels.invoke.SET_SYNC_SETTINGS)
  ipcMain.removeHandler(SettingsChannels.invoke.GET_BACKUP_SETTINGS)
  ipcMain.removeHandler(SettingsChannels.invoke.SET_BACKUP_SETTINGS)

  logger.info('Settings handlers unregistered')
}
