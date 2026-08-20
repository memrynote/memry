/**
 * Settings IPC Handlers
 *
 * Handles IPC requests for app settings, including journal settings and AI settings.
 * AI uses local embeddings with all-MiniLM-L6-v2 model (no API key required).
 *
 * @module main/ipc/settings-handlers
 */

import { ipcMain, app, globalShortcut, systemPreferences, shell } from 'electron'
import { broadcastToAllWindows } from '../lib/window-broadcast'
import { SettingsChannels } from '@memry/contracts/ipc-channels'
import {
  GENERAL_SETTINGS_DEFAULTS,
  EDITOR_SETTINGS_DEFAULTS,
  TASK_SETTINGS_DEFAULTS,
  KEYBOARD_SHORTCUTS_DEFAULTS,
  SYNC_SETTINGS_DEFAULTS,
  BACKUP_SETTINGS_DEFAULTS,
  VOICE_TRANSCRIPTION_SETTINGS_DEFAULTS,
  CALENDAR_GOOGLE_SETTINGS_DEFAULTS,
  CALENDAR_SETTINGS_DEFAULTS,
  FEATURES_SETTINGS_DEFAULTS,
  INBOX_SETTINGS_DEFAULTS
} from '@memry/contracts/settings-schemas'
import type {
  GeneralSettings,
  EditorSettings,
  TaskSettings,
  KeyboardShortcuts,
  SyncSettings,
  BackupSettings,
  VoiceTranscriptionSettings,
  CalendarGoogleSettings,
  CalendarSettings,
  FeaturesSettings,
  InboxSettings
} from '@memry/contracts/settings-schemas'
import { GRAPH_SETTINGS_DEFAULTS } from '@memry/contracts/graph-api'
import type { GraphSettings } from '@memry/contracts/graph-api'
import { createLogger } from '../lib/logger'
import { getDatabase } from '../database'
import { getSetting, setSetting, deleteSetting } from '../settings/settings-store'
import { withErrorHandler } from './validate'
import {
  initEmbeddingModel,
  getModelInfo,
  isModelLoaded,
  isModelLoading,
  resetEmbeddingModelFailure
} from '../lib/embeddings'
import { rebuildProjections } from '../projections'
import { writePreferences, PORTABLE_GENERAL_FIELDS } from '../vault/vault-preferences'
import { getCurrentVaultPath, getDefaultVaultPath, getVaults, setDefaultVaultPath } from '../store'
import { downloadVoiceModel, getVoiceModelStatus } from '../inbox/voice-model'
import { getVoiceRecordingReadiness } from '../inbox/voice-transcription-settings'
import {
  hasVoiceTranscriptionOpenAIApiKey,
  setVoiceTranscriptionOpenAIApiKey
} from '../inbox/voice-transcription-keychain'
import {
  syncSettingsUpdates,
  syncSettingsMapEntryUpdates,
  syncSettingsFieldUpdate
} from '../settings/runtime-effects'
import {
  JOURNAL_DEFAULT_TEMPLATE_KEY,
  JOURNAL_WEEKDAY_TEMPLATES_KEY,
  isWeekdayKey,
  parseWeekdayTemplateMap,
  sanitizeWeekdayTemplateMap,
  type WeekdayTemplateMap
} from '../settings/journal-template-keys'
import {
  SIDEBAR_SORT_SETTINGS_KEY,
  readResolvedSidebarSortModes,
  writeSidebarSortMode
} from '../settings/sidebar-sort-store'
import {
  SIDEBAR_SECTION_ORDER_SETTINGS_KEY,
  readSidebarSectionOrder,
  writeSidebarSectionOrder
} from '../settings/sidebar-section-order-store'
import {
  SIDEBAR_SORT_DEFAULTS,
  SidebarSortModeSchema,
  SidebarSortSurfaceSchema,
  type SidebarSortMode,
  type SidebarSortSurface
} from '@memry/contracts/sidebar-sort'
import { INBOX_REVIEW_LAST_NOTIFIED_KEY } from '../inbox/review-reminder-constants'
import { sendTestReviewNotification } from '../inbox/review-notification'
import { trackMainEvent } from '../telemetry/track'
import { trackMainError, trackMainLog } from '../telemetry/diagnostics'
import { SafeDimensionValueSchema } from '@memry/contracts/telemetry-api'
import {
  getTerminalCommandStatus,
  installTerminalCommand,
  uninstallTerminalCommand,
  type TerminalCommandOptions,
  type TerminalCommandStatus as BaseTerminalCommandStatus
} from '../cli/terminal-command'
import { getMainI18n } from '../lib/main-i18n'

// ============================================================================
// Settings Keys
// ============================================================================

const logger = createLogger('IPC:Settings')

const GENERAL_SYNCABLE_FIELDS: (keyof GeneralSettings)[] = [
  'theme',
  'fontSize',
  'fontFamily',
  'accentColor',
  'language',
  'createInSelectedFolder',
  'openPagesInNewTab'
]

const INBOX_SYNCABLE_FIELDS: (keyof InboxSettings)[] = [
  'reviewReminderEnabled',
  'reviewReminderTime'
]

const SETTINGS_KEYS = {
  JOURNAL_DEFAULT_TEMPLATE: JOURNAL_DEFAULT_TEMPLATE_KEY,
  JOURNAL_WEEKDAY_TEMPLATES: JOURNAL_WEEKDAY_TEMPLATES_KEY,
  JOURNAL_SHOW_SCHEDULE: 'journal.showSchedule',
  JOURNAL_SHOW_TASKS: 'journal.showTasks',
  JOURNAL_SHOW_AI_CONNECTIONS: 'journal.showAIConnections',
  JOURNAL_SHOW_STATS_FOOTER: 'journal.showStatsFooter',
  AI_ENABLED: 'ai.enabled',
  // Tab settings
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
  /**
   * Per-weekday template overrides keyed by JS `getDay()` ("0" = Sunday).
   * A day with no entry — or a `null` entry — falls back to `defaultTemplate`.
   */
  weekdayTemplates: WeekdayTemplateMap
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

export interface VoiceTranscriptionOpenAIKeyStatus {
  hasApiKey: boolean
}

export interface TerminalCommandVault {
  path: string
  name: string
  isDefault: boolean
}

export interface TerminalCommandStatus extends BaseTerminalCommandStatus {
  defaultVaultPath: string | null
  vaults: TerminalCommandVault[]
}

export type TerminalCommandMutationResult =
  | { success: true; status: TerminalCommandStatus }
  | { success: false; error: string; status?: TerminalCommandStatus }

// ============================================================================
// Tab Settings Interface
// ============================================================================

export interface TabSettings {
  /** Restore tabs from last session on app start */
  restoreSessionOnStart: boolean
  /** When to show close button: always, on hover, or only on active tab */
  tabCloseButton: 'always' | 'hover' | 'active'
}

/** Default tab settings values */
const DEFAULT_TAB_SETTINGS: TabSettings = {
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
    trackMainLog('warn', {
      scope: 'Settings',
      action: 'group_corrupted_reset',
      errorCode: `settings_group_corrupted_${groupKey}`
    })
    deleteSetting(db, groupKey)
    return { ...defaults }
  }
}

/**
 * Emit setting_changed per updated field. Field NAMES only (never values) —
 * `${groupKey}.${field}` is a closed set of code identifiers, gated by the
 * safe-dimension schema as a backstop.
 */
function trackGroupSettingChanges(groupKey: string, updates: Record<string, unknown>): void {
  for (const field of Object.keys(updates)) {
    const setting = `${groupKey}.${field}`
    if (SafeDimensionValueSchema.safeParse(setting).success) {
      trackMainEvent('setting_changed', {
        surface: 'settings',
        action: 'changed',
        dimensions: { setting }
      })
    }
  }
}

/** Synchronous read of calendar settings for non-IPC callers (e.g. projection). */
export function getCalendarSettings(): CalendarSettings {
  return readGroupSettings('calendar', CALENDAR_SETTINGS_DEFAULTS)
}

/** Synchronous read of inbox review settings for the scheduler (non-IPC caller). */
export function getInboxReviewSettings(): InboxSettings {
  return readGroupSettings('inbox', INBOX_SETTINGS_DEFAULTS)
}

/** Write inbox settings + push changed fields to sync. Test seam + used by the SET handler. */
export function writeInboxReviewSettings(updates: Partial<InboxSettings>): {
  success: boolean
  error?: string
} {
  const result = writeGroupSettings('inbox', INBOX_SETTINGS_DEFAULTS, updates)
  if (result.success) {
    syncSettingsUpdates('inbox', updates, INBOX_SYNCABLE_FIELDS)

    // The schedule changed: re-arm the once-per-day guard so the new time
    // (or newly-enabled reminder) can fire again today instead of waiting
    // until tomorrow.
    if ('reviewReminderTime' in updates || 'reviewReminderEnabled' in updates) {
      const db = getDbOrNull()
      if (db) deleteSetting(db, INBOX_REVIEW_LAST_NOTIFIED_KEY)
    }
  }
  return result
}

function getStartupTheme(): { theme: GeneralSettings['theme']; accentColor?: string } {
  const settings = readGroupSettings('general', GENERAL_SETTINGS_DEFAULTS)
  const result: { theme: GeneralSettings['theme']; accentColor?: string } = {
    theme: settings.theme
  }
  if (settings.accentColor) {
    result.accentColor = settings.accentColor
  }
  return result
}

function getTerminalCommandVaults(): TerminalCommandVault[] {
  return getVaults().map((vault) => ({
    path: vault.path,
    name: vault.name,
    isDefault: vault.isDefault
  }))
}

function getTerminalCommandOptions(): TerminalCommandOptions {
  return {
    executablePath: process.execPath,
    appPath: app.isPackaged ? null : app.getAppPath()
  }
}

async function getTerminalStatus(): Promise<TerminalCommandStatus> {
  const status = await getTerminalCommandStatus(getTerminalCommandOptions())
  const vaults = getTerminalCommandVaults()
  const defaultVaultPath = getDefaultVaultPath() ?? (vaults.length === 1 ? vaults[0].path : null)

  return {
    ...status,
    defaultVaultPath,
    vaults
  }
}

async function getTerminalStatusSafely(): Promise<TerminalCommandStatus | undefined> {
  try {
    return await getTerminalStatus()
  } catch (error) {
    logger.warn('Terminal status probe failed:', error)
    return undefined
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
  if (!db) return { success: false, error: getMainI18n().t('errors:ipc.noVaultOpen') }

  const current = readGroupSettings(groupKey, defaults)
  const updated = { ...current, ...updates }
  setSetting(db, groupKey, JSON.stringify(updated))

  broadcastToAllWindows(SettingsChannels.events.CHANGED, {
    key: groupKey,
    value: updates
  })

  trackGroupSettingChanges(groupKey, updates)

  return { success: true }
}

// ============================================================================
// Handler Registration
// ============================================================================

/**
 * Register all settings-related IPC handlers.
 */
/**
 * Read journal settings from the open vault, falling back to defaults when no
 * vault is open. Exported alongside the IPC registration so tests exercise the
 * real settings table instead of reaching through a handler closure.
 */
export function getJournalSettings(): JournalSettings {
  const db = getDbOrNull()
  if (!db) {
    return {
      defaultTemplate: null,
      weekdayTemplates: {},
      showSchedule: true,
      showTasks: true,
      showAIConnections: true,
      showStatsFooter: false
    }
  }

  const defaultTemplate = getSetting(db, SETTINGS_KEYS.JOURNAL_DEFAULT_TEMPLATE)
  const weekdayTemplates = parseWeekdayTemplateMap(
    getSetting(db, SETTINGS_KEYS.JOURNAL_WEEKDAY_TEMPLATES)
  )
  const showScheduleStr = getSetting(db, SETTINGS_KEYS.JOURNAL_SHOW_SCHEDULE)
  const showTasksStr = getSetting(db, SETTINGS_KEYS.JOURNAL_SHOW_TASKS)
  const showAIConnectionsStr = getSetting(db, SETTINGS_KEYS.JOURNAL_SHOW_AI_CONNECTIONS)
  const showStatsFooterStr = getSetting(db, SETTINGS_KEYS.JOURNAL_SHOW_STATS_FOOTER)

  return {
    defaultTemplate,
    weekdayTemplates,
    showSchedule: showScheduleStr !== 'false', // Default true
    showTasks: showTasksStr !== 'false', // Default true
    showAIConnections: showAIConnectionsStr !== 'false', // Default true
    showStatsFooter: showStatsFooterStr === 'true' // Default false
  }
}

/** Persist a partial journal settings update, then sync and broadcast it. */
export function writeJournalSettings(settings: Partial<JournalSettings>): {
  success: boolean
  error?: string
} {
  const db = getDbOrNull()
  if (!db) {
    return { success: false, error: getMainI18n().t('errors:ipc.noVaultOpen') }
  }

  if (settings.defaultTemplate !== undefined) {
    if (settings.defaultTemplate === null) {
      // Clear the setting
      deleteSetting(db, SETTINGS_KEYS.JOURNAL_DEFAULT_TEMPLATE)
    } else {
      setSetting(db, SETTINGS_KEYS.JOURNAL_DEFAULT_TEMPLATE, settings.defaultTemplate)
    }
    syncSettingsFieldUpdate(SETTINGS_KEYS.JOURNAL_DEFAULT_TEMPLATE, settings.defaultTemplate)
  }

  // The renderer sends only the day it changed. Merging here rather than
  // there keeps two windows from clobbering each other with a stale
  // read-modify-write, and keeps the write symmetric with the per-day field
  // clocks below.
  let mergedWeekdayTemplates: WeekdayTemplateMap | undefined
  if (settings.weekdayTemplates !== undefined) {
    const patch = sanitizeWeekdayTemplateMap(settings.weekdayTemplates)
    const current = parseWeekdayTemplateMap(getSetting(db, SETTINGS_KEYS.JOURNAL_WEEKDAY_TEMPLATES))
    mergedWeekdayTemplates = { ...current, ...patch }
    setSetting(db, SETTINGS_KEYS.JOURNAL_WEEKDAY_TEMPLATES, JSON.stringify(mergedWeekdayTemplates))
    // One clock per day, not one for the map: see syncSettingsMapEntryUpdates.
    syncSettingsMapEntryUpdates('journal', 'weekdayTemplates', patch, isWeekdayKey)
  }

  // Handle sidebar visibility settings
  if (settings.showSchedule !== undefined) {
    setSetting(db, SETTINGS_KEYS.JOURNAL_SHOW_SCHEDULE, settings.showSchedule ? 'true' : 'false')
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

  // Emit settings changed event. The weekday map goes out whole: the
  // renderer merges settings patches shallowly, so a one-day patch would
  // replace every subscriber's map with just that day.
  broadcastToAllWindows(SettingsChannels.events.CHANGED, {
    key: 'journal',
    value: mergedWeekdayTemplates
      ? { ...settings, weekdayTemplates: mergedWeekdayTemplates }
      : settings
  })

  trackGroupSettingChanges('journal', settings)

  return { success: true }
}

export function registerSettingsHandlers(): void {
  ipcMain.on(SettingsChannels.sync.GET_STARTUP_THEME, (event) => {
    event.returnValue = getStartupTheme()
  })

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
        return { success: false, error: getMainI18n().t('errors:ipc.noVaultOpen') }
      }
      setSetting(db, key, value)

      // Emit settings changed event
      broadcastToAllWindows(SettingsChannels.events.CHANGED, { key, value })

      if (SafeDimensionValueSchema.safeParse(key).success) {
        trackMainEvent('setting_changed', {
          surface: 'settings',
          action: 'changed',
          dimensions: { setting: key }
        })
      }

      return { success: true }
    }
  )

  // Get journal settings
  ipcMain.handle(SettingsChannels.invoke.GET_JOURNAL_SETTINGS, () => getJournalSettings())

  ipcMain.handle(SettingsChannels.invoke.GET_SIDEBAR_SORT_MODES, () => {
    const db = getDbOrNull()
    // No vault open yet: hand back the defaults rather than an error, so the
    // sidebar renders its pre-existing order instead of an empty section.
    if (!db) return { ...SIDEBAR_SORT_DEFAULTS }
    return readResolvedSidebarSortModes(db)
  })

  ipcMain.handle(
    SettingsChannels.invoke.SET_SIDEBAR_SORT_MODE,
    (_event, { surface, mode }: { surface: SidebarSortSurface; mode: SidebarSortMode }) => {
      const db = getDbOrNull()
      if (!db) {
        return { success: false, error: getMainI18n().t('errors:ipc.noVaultOpen') }
      }

      const parsedSurface = SidebarSortSurfaceSchema.safeParse(surface)
      const parsedMode = SidebarSortModeSchema.safeParse(mode)
      if (!parsedSurface.success || !parsedMode.success) {
        return { success: false, error: 'Invalid sidebar sort surface or mode' }
      }

      try {
        const next = writeSidebarSortMode(db, parsedSurface.data, parsedMode.data)
        broadcastToAllWindows(SettingsChannels.events.CHANGED, {
          key: SIDEBAR_SORT_SETTINGS_KEY,
          value: next
        })
        trackMainEvent('setting_changed', {
          surface: 'settings',
          action: 'changed',
          dimensions: { setting: `sidebarSort.${parsedSurface.data}` }
        })
        return { success: true }
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle(SettingsChannels.invoke.GET_SIDEBAR_SECTION_ORDER, () => {
    const db = getDbOrNull()
    // No vault open yet: an empty order means "never reordered", which is what
    // the sidebar already renders, so this is the honest answer and not an error.
    if (!db) return []
    return readSidebarSectionOrder(db)
  })

  ipcMain.handle(SettingsChannels.invoke.SET_SIDEBAR_SECTION_ORDER, (_event, order: string[]) => {
    const db = getDbOrNull()
    if (!db) {
      return { success: false, error: getMainI18n().t('errors:ipc.noVaultOpen') }
    }

    if (!Array.isArray(order) || order.some((id) => typeof id !== 'string')) {
      return { success: false, error: 'Invalid sidebar section order' }
    }

    try {
      const next = writeSidebarSectionOrder(db, order)
      broadcastToAllWindows(SettingsChannels.events.CHANGED, {
        key: SIDEBAR_SECTION_ORDER_SETTINGS_KEY,
        value: next
      })
      trackMainEvent('setting_changed', {
        surface: 'settings',
        action: 'changed',
        dimensions: { setting: 'sidebarSectionOrder' }
      })
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Set journal settings
  ipcMain.handle(
    SettingsChannels.invoke.SET_JOURNAL_SETTINGS,
    (_event, settings: Partial<JournalSettings>) => writeJournalSettings(settings)
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
        return { success: false, error: getMainI18n().t('errors:ipc.noVaultOpen') }
      }

      if (settings.enabled !== undefined) {
        setSetting(db, SETTINGS_KEYS.AI_ENABLED, settings.enabled ? 'true' : 'false')
        // Re-enabling AI is an explicit retry: clear the model-load circuit
        // breaker so a previously failed/stalled load is attempted again (#803).
        if (settings.enabled) {
          resetEmbeddingModelFailure()
        }
      }

      // Emit settings changed event
      broadcastToAllWindows(SettingsChannels.events.CHANGED, {
        key: 'ai',
        value: settings
      })

      trackGroupSettingChanges('ai', settings)

      return { success: true }
    }
  )

  ipcMain.handle(SettingsChannels.invoke.GET_VOICE_TRANSCRIPTION_SETTINGS, () => {
    return readGroupSettings('voiceTranscription', VOICE_TRANSCRIPTION_SETTINGS_DEFAULTS)
  })

  ipcMain.handle(
    SettingsChannels.invoke.SET_VOICE_TRANSCRIPTION_SETTINGS,
    (_event, settings: Partial<VoiceTranscriptionSettings>) => {
      return writeGroupSettings(
        'voiceTranscription',
        VOICE_TRANSCRIPTION_SETTINGS_DEFAULTS,
        settings
      )
    }
  )

  ipcMain.handle(SettingsChannels.invoke.GET_VOICE_MODEL_STATUS, () => {
    return getVoiceModelStatus()
  })

  ipcMain.handle(SettingsChannels.invoke.DOWNLOAD_VOICE_MODEL, async () => {
    try {
      const success = await downloadVoiceModel()
      if (success) {
        return { success: true }
      }

      const status = getVoiceModelStatus()
      trackMainLog('warn', {
        scope: 'Voice',
        action: 'model_download_failed',
        errorCode: 'voice_model_download_failed'
      })
      return {
        success: false,
        error: status.error ?? getMainI18n().t('errors:settings.voiceModelDownloadFailed')
      }
    } catch (error) {
      trackMainError('voice', 'model_download', error)
      const message =
        error instanceof Error ? error.message : getMainI18n().t('errors:generic.unknown')
      return { success: false, error: message }
    }
  })

  ipcMain.handle(SettingsChannels.invoke.GET_TERMINAL_COMMAND_STATUS, async () => {
    return getTerminalStatus()
  })

  ipcMain.handle(
    SettingsChannels.invoke.INSTALL_TERMINAL_COMMAND,
    async (): Promise<TerminalCommandMutationResult> => {
      try {
        await installTerminalCommand(getTerminalCommandOptions())
        return {
          success: true,
          status: await getTerminalStatus()
        }
      } catch (error) {
        trackMainError('settings', 'terminal_command_install', error)
        return {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : getMainI18n().t('errors:settings.terminalCommandInstallFailed'),
          status: await getTerminalStatusSafely()
        }
      }
    }
  )

  ipcMain.handle(
    SettingsChannels.invoke.UNINSTALL_TERMINAL_COMMAND,
    async (): Promise<TerminalCommandMutationResult> => {
      try {
        await uninstallTerminalCommand(getTerminalCommandOptions())
        return {
          success: true,
          status: await getTerminalStatus()
        }
      } catch (error) {
        trackMainError('settings', 'terminal_command_uninstall', error)
        return {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : getMainI18n().t('errors:settings.terminalCommandUninstallFailed'),
          status: await getTerminalStatusSafely()
        }
      }
    }
  )

  ipcMain.handle(
    SettingsChannels.invoke.SET_TERMINAL_COMMAND_DEFAULT_VAULT,
    async (_event, vaultPath: string): Promise<TerminalCommandMutationResult> => {
      const vault = setDefaultVaultPath(vaultPath)
      if (!vault) {
        return {
          success: false,
          error: getMainI18n().t('errors:settings.unknownVault'),
          status: await getTerminalStatusSafely()
        }
      }

      return {
        success: true,
        status: await getTerminalStatus()
      }
    }
  )

  ipcMain.handle(SettingsChannels.invoke.GET_VOICE_RECORDING_READINESS, async () => {
    return getVoiceRecordingReadiness()
  })

  ipcMain.handle(SettingsChannels.invoke.OPEN_OS_MICROPHONE_SETTINGS, async () => {
    // Fixed deep links (never user input), so this deliberately bypasses the
    // https/http openExternal allowlist in lib/external-url.ts.
    const target =
      process.platform === 'darwin'
        ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
        : process.platform === 'win32'
          ? 'ms-settings:privacy-microphone'
          : null
    if (!target) return { success: false }
    await shell.openExternal(target)
    return { success: true }
  })

  ipcMain.handle(
    SettingsChannels.invoke.GET_VOICE_TRANSCRIPTION_OPENAI_KEY_STATUS,
    async (): Promise<VoiceTranscriptionOpenAIKeyStatus> => {
      return {
        hasApiKey: await hasVoiceTranscriptionOpenAIApiKey()
      }
    }
  )

  ipcMain.handle(
    SettingsChannels.invoke.SET_VOICE_TRANSCRIPTION_OPENAI_KEY,
    async (_event, { apiKey }: { apiKey: string }) => {
      try {
        await setVoiceTranscriptionOpenAIApiKey(apiKey)
        return { success: true }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : getMainI18n().t('errors:generic.unknown')
        return { success: false, error: message }
      }
    }
  )

  // Get AI model status
  ipcMain.handle(SettingsChannels.invoke.GET_AI_MODEL_STATUS, async (): Promise<AIModelStatus> => {
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
  ipcMain.handle(
    SettingsChannels.invoke.LOAD_AI_MODEL,
    withErrorHandler(async () => {
      if (isModelLoaded()) {
        return { success: true, message: 'Model already loaded' }
      }

      if (isModelLoading()) {
        return { success: false, error: getMainI18n().t('errors:settings.modelAlreadyLoading') }
      }

      // Manual load is an explicit retry — clear the circuit breaker first (#803).
      resetEmbeddingModelFailure()
      const success = await initEmbeddingModel()
      if (success) {
        return { success: true }
      } else {
        const info = getModelInfo()
        return {
          success: false,
          error: info.error || getMainI18n().t('errors:settings.modelLoadFailed')
        }
      }
    }, 'errors:generic.unknown')
  )

  // Reindex embeddings
  ipcMain.handle(
    SettingsChannels.invoke.REINDEX_EMBEDDINGS,
    withErrorHandler(async () => {
      // Reindex is an explicit retry — clear the circuit breaker first (#803).
      resetEmbeddingModelFailure()
      const result = await rebuildProjections(['embedding'])
      return result.embedding as {
        success: boolean
        computed: number
        skipped: number
        error?: string
      }
    }, 'errors:generic.unknown')
  )

  // Get tab settings
  ipcMain.handle(SettingsChannels.invoke.GET_TAB_SETTINGS, () => {
    const db = getDbOrNull()
    if (!db) {
      return DEFAULT_TAB_SETTINGS
    }

    const restoreSessionStr = getSetting(db, SETTINGS_KEYS.TAB_RESTORE_SESSION)
    const closeButtonStr = getSetting(db, SETTINGS_KEYS.TAB_CLOSE_BUTTON)

    return {
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
        return { success: false, error: getMainI18n().t('errors:ipc.noVaultOpen') }
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
      broadcastToAllWindows(SettingsChannels.events.CHANGED, {
        key: 'tabs',
        value: settings
      })

      trackGroupSettingChanges('tabs', settings)

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
        return { success: false, error: getMainI18n().t('errors:ipc.noVaultOpen') }
      }

      if (settings.toolbarMode !== undefined) {
        setSetting(db, SETTINGS_KEYS.NOTE_EDITOR_TOOLBAR_MODE, settings.toolbarMode)
      }

      // Emit settings changed event
      broadcastToAllWindows(SettingsChannels.events.CHANGED, {
        key: 'noteEditor',
        value: settings
      })

      trackGroupSettingChanges('noteEditor', settings)

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
      writePortableGeneralToConfig(updates)

      const result = writeGroupSettings('general', GENERAL_SETTINGS_DEFAULTS, updates)
      if (result.success) {
        if (updates.startOnBoot !== undefined) {
          try {
            app.setLoginItemSettings({ openAtLogin: updates.startOnBoot })
            logger.info(`Start on boot ${updates.startOnBoot ? 'enabled' : 'disabled'}`)
          } catch (err) {
            logger.warn('Failed to set login item:', err)
          }
        }

        syncSettingsUpdates('general', updates, GENERAL_SYNCABLE_FIELDS)
      }
      return result
    }
  )

  ipcMain.handle(SettingsChannels.invoke.GET_EDITOR_SETTINGS, () => {
    const settings = readGroupSettings('editor', EDITOR_SETTINGS_DEFAULTS)
    // Coerce legacy widths (narrow/medium/wide) written by older versions to 'normal'.
    return { ...settings, width: settings.width === 'full' ? 'full' : 'normal' }
  })
  ipcMain.handle(
    SettingsChannels.invoke.SET_EDITOR_SETTINGS,
    (_event, updates: Partial<EditorSettings>) => {
      writeEditorToConfig(updates)
      return writeGroupSettings('editor', EDITOR_SETTINGS_DEFAULTS, updates)
    }
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
    (_event, updates: Partial<KeyboardShortcuts>) => {
      const result = writeGroupSettings('keyboard', KEYBOARD_SHORTCUTS_DEFAULTS, updates)
      if ('globalCapture' in updates) {
        applyGlobalCaptureShortcut()
      }
      return result
    }
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

  ipcMain.handle(SettingsChannels.invoke.GET_GRAPH_SETTINGS, () =>
    readGroupSettings('graph', GRAPH_SETTINGS_DEFAULTS)
  )
  ipcMain.handle(
    SettingsChannels.invoke.SET_GRAPH_SETTINGS,
    (_event, updates: Partial<GraphSettings>) =>
      writeGroupSettings('graph', GRAPH_SETTINGS_DEFAULTS, updates)
  )

  ipcMain.handle(SettingsChannels.invoke.GET_CALENDAR_GOOGLE_SETTINGS, () =>
    readGroupSettings('calendar.google', CALENDAR_GOOGLE_SETTINGS_DEFAULTS)
  )
  ipcMain.handle(
    SettingsChannels.invoke.SET_CALENDAR_GOOGLE_SETTINGS,
    (_event, updates: Partial<CalendarGoogleSettings>) =>
      writeGroupSettings('calendar.google', CALENDAR_GOOGLE_SETTINGS_DEFAULTS, updates)
  )

  ipcMain.handle(SettingsChannels.invoke.GET_CALENDAR_SETTINGS, () =>
    readGroupSettings('calendar', CALENDAR_SETTINGS_DEFAULTS)
  )
  ipcMain.handle(
    SettingsChannels.invoke.SET_CALENDAR_SETTINGS,
    (_event, updates: Partial<CalendarSettings>) =>
      writeGroupSettings('calendar', CALENDAR_SETTINGS_DEFAULTS, updates)
  )

  ipcMain.handle(SettingsChannels.invoke.GET_FEATURES_SETTINGS, () =>
    readGroupSettings('features', FEATURES_SETTINGS_DEFAULTS)
  )
  ipcMain.handle(
    SettingsChannels.invoke.SET_FEATURES_SETTINGS,
    (_event, updates: Partial<FeaturesSettings>) =>
      writeGroupSettings('features', FEATURES_SETTINGS_DEFAULTS, updates)
  )

  ipcMain.handle(SettingsChannels.invoke.GET_INBOX_SETTINGS, () =>
    readGroupSettings('inbox', INBOX_SETTINGS_DEFAULTS)
  )
  ipcMain.handle(
    SettingsChannels.invoke.SET_INBOX_SETTINGS,
    (_event, updates: Partial<InboxSettings>) => writeInboxReviewSettings(updates)
  )
  ipcMain.handle(SettingsChannels.invoke.SEND_TEST_INBOX_REVIEW_NOTIFICATION, () =>
    sendTestReviewNotification()
  )

  // Keyboard shortcuts: reset to defaults
  ipcMain.handle(SettingsChannels.invoke.RESET_KEYBOARD_SETTINGS, () => {
    const db = getDbOrNull()
    if (!db) {
      return { success: false, error: getMainI18n().t('errors:ipc.noVaultOpen') }
    }

    deleteSetting(db, 'keyboard')

    broadcastToAllWindows(SettingsChannels.events.CHANGED, {
      key: 'keyboard',
      value: KEYBOARD_SHORTCUTS_DEFAULTS
    })

    return { success: true }
  })

  ipcMain.handle(SettingsChannels.invoke.REGISTER_GLOBAL_CAPTURE, async () => {
    return applyGlobalCaptureShortcut()
  })
}

// ============================================================================
// Global Capture Shortcut
// ============================================================================

function toElectronAccelerator(binding: {
  key: string
  modifiers: { meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean }
}): string {
  const parts: string[] = []
  if (binding.modifiers.meta) parts.push('CommandOrControl')
  if (binding.modifiers.ctrl && !binding.modifiers.meta) parts.push('Control')
  if (binding.modifiers.alt) parts.push('Alt')
  if (binding.modifiers.shift) parts.push('Shift')
  parts.push(binding.key)
  return parts.join('+')
}

export interface GlobalCaptureResult {
  success: boolean
  registered: boolean
  permissionRequired?: boolean
  error?: string
}

/**
 * Accelerator currently held by the configured global capture shortcut. Only
 * this one is released on re-apply: `globalShortcut.unregisterAll()` would also
 * drop the quick capture fallback shortcut owned by `main/index.ts`.
 */
let registeredGlobalCaptureAccelerator: string | null = null

/** Notified after every apply so the quick capture fallback stays in step. */
let globalCaptureAppliedHandler: ((configuredRegistered: boolean) => void) | null = null

/**
 * Let `main/index.ts` keep its hardcoded quick capture fallback in step with the
 * configured accelerator without this module importing the entrypoint.
 */
export function setGlobalCaptureAppliedHandler(
  handler: ((configuredRegistered: boolean) => void) | null
): void {
  globalCaptureAppliedHandler = handler
}

/**
 * Read keyboard.globalCapture from settings and register/unregister OS shortcut.
 * Safe to call at startup and on settings change.
 */
export function applyGlobalCaptureShortcut(): GlobalCaptureResult {
  const result = registerConfiguredGlobalCapture()
  globalCaptureAppliedHandler?.(result.registered)
  return result
}

function registerConfiguredGlobalCapture(): GlobalCaptureResult {
  if (registeredGlobalCaptureAccelerator) {
    globalShortcut.unregister(registeredGlobalCaptureAccelerator)
    registeredGlobalCaptureAccelerator = null
  }

  const settings = readGroupSettings('keyboard', KEYBOARD_SHORTCUTS_DEFAULTS)
  const binding = settings.globalCapture
  if (!binding) {
    return { success: true, registered: false }
  }

  if (process.platform === 'darwin') {
    const hasPerm = systemPreferences.isTrustedAccessibilityClient(false)
    if (!hasPerm) {
      logger.warn('Global capture: accessibility permission not granted on macOS')
      return { success: false, registered: false, permissionRequired: true }
    }
  }

  const accelerator = toElectronAccelerator(binding)
  const registered = globalShortcut.register(accelerator, () => {
    broadcastToAllWindows('quick-capture:open')
  })

  if (!registered) {
    logger.warn(`Global capture: failed to register ${accelerator} (may be in use)`)
    trackMainLog('warn', {
      scope: 'Settings',
      action: 'global_capture_register_failed',
      errorCode: 'shortcut_in_use'
    })
    return {
      success: false,
      registered: false,
      error: getMainI18n().t('errors:settings.shortcutInUse', { shortcut: accelerator })
    }
  }

  registeredGlobalCaptureAccelerator = accelerator
  logger.info(`Global capture: registered ${accelerator}`)
  return { success: true, registered: true }
}

function writePortableGeneralToConfig(updates: Partial<GeneralSettings>): void {
  const vaultPath = getCurrentVaultPath()
  if (!vaultPath) return

  const portable: Record<string, unknown> = {}
  for (const field of PORTABLE_GENERAL_FIELDS) {
    if (updates[field] !== undefined) {
      portable[field] = updates[field]
    }
  }

  if (Object.keys(portable).length > 0) {
    try {
      writePreferences(vaultPath, portable)
    } catch (err) {
      logger.warn('Failed to write preferences to config.json:', err)
      trackMainLog('warn', {
        scope: 'Settings',
        action: 'config_write_failed',
        errorCode: 'config_json_write_failed'
      })
    }
  }
}

function writeEditorToConfig(updates: Partial<EditorSettings>): void {
  const vaultPath = getCurrentVaultPath()
  if (!vaultPath) return

  try {
    writePreferences(vaultPath, { editor: updates })
  } catch (err) {
    logger.warn('Failed to write editor preferences to config.json:', err)
    trackMainLog('warn', {
      scope: 'Settings',
      action: 'config_write_failed',
      errorCode: 'config_json_write_failed'
    })
  }
}

/**
 * Unregister all settings-related IPC handlers.
 */
export function unregisterSettingsHandlers(): void {
  ipcMain.removeAllListeners(SettingsChannels.sync.GET_STARTUP_THEME)
  ipcMain.removeHandler(SettingsChannels.invoke.GET)
  ipcMain.removeHandler(SettingsChannels.invoke.SET)
  ipcMain.removeHandler(SettingsChannels.invoke.GET_JOURNAL_SETTINGS)
  ipcMain.removeHandler(SettingsChannels.invoke.SET_JOURNAL_SETTINGS)
  ipcMain.removeHandler(SettingsChannels.invoke.GET_AI_SETTINGS)
  ipcMain.removeHandler(SettingsChannels.invoke.SET_AI_SETTINGS)
  ipcMain.removeHandler(SettingsChannels.invoke.GET_VOICE_TRANSCRIPTION_SETTINGS)
  ipcMain.removeHandler(SettingsChannels.invoke.SET_VOICE_TRANSCRIPTION_SETTINGS)
  ipcMain.removeHandler(SettingsChannels.invoke.GET_VOICE_MODEL_STATUS)
  ipcMain.removeHandler(SettingsChannels.invoke.DOWNLOAD_VOICE_MODEL)
  ipcMain.removeHandler(SettingsChannels.invoke.GET_VOICE_RECORDING_READINESS)
  ipcMain.removeHandler(SettingsChannels.invoke.OPEN_OS_MICROPHONE_SETTINGS)
  ipcMain.removeHandler(SettingsChannels.invoke.GET_VOICE_TRANSCRIPTION_OPENAI_KEY_STATUS)
  ipcMain.removeHandler(SettingsChannels.invoke.SET_VOICE_TRANSCRIPTION_OPENAI_KEY)
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
  ipcMain.removeHandler(SettingsChannels.invoke.GET_GRAPH_SETTINGS)
  ipcMain.removeHandler(SettingsChannels.invoke.SET_GRAPH_SETTINGS)
  ipcMain.removeHandler(SettingsChannels.invoke.GET_CALENDAR_GOOGLE_SETTINGS)
  ipcMain.removeHandler(SettingsChannels.invoke.SET_CALENDAR_GOOGLE_SETTINGS)
  ipcMain.removeHandler(SettingsChannels.invoke.GET_CALENDAR_SETTINGS)
  ipcMain.removeHandler(SettingsChannels.invoke.SET_CALENDAR_SETTINGS)
  ipcMain.removeHandler(SettingsChannels.invoke.GET_FEATURES_SETTINGS)
  ipcMain.removeHandler(SettingsChannels.invoke.SET_FEATURES_SETTINGS)
  ipcMain.removeHandler(SettingsChannels.invoke.GET_INBOX_SETTINGS)
  ipcMain.removeHandler(SettingsChannels.invoke.SET_INBOX_SETTINGS)
  ipcMain.removeHandler(SettingsChannels.invoke.REGISTER_GLOBAL_CAPTURE)

  logger.info('Settings handlers unregistered')
}
