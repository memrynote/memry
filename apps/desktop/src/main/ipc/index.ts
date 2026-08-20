import { registerVaultHandlers, unregisterVaultHandlers } from './vault-handlers'
import { registerNotesHandlers, unregisterNotesHandlers } from './notes-handlers'
import { registerTasksHandlers, unregisterTasksHandlers } from './tasks-handlers'
import {
  registerSavedFiltersHandlers,
  unregisterSavedFiltersHandlers
} from './saved-filters-handlers'
import { registerTemplatesHandlers, unregisterTemplatesHandlers } from './templates-handlers'
import { registerJournalHandlers, unregisterJournalHandlers } from './journal-handlers'
import { registerSettingsHandlers, unregisterSettingsHandlers } from './settings-handlers'
import { registerBookmarksHandlers, unregisterBookmarksHandlers } from './bookmarks-handlers'
import { registerTagsHandlers, unregisterTagsHandlers } from './tags-handlers'
import { registerInboxHandlers, unregisterInboxHandlers } from './inbox-handlers'
import { registerReminderHandlers, unregisterReminderHandlers } from './reminder-handlers'
import { registerCalendarHandlers, unregisterCalendarHandlers } from './calendar-handlers'
import { registerCanvasHandlers, unregisterCanvasHandlers } from './canvas-handlers'
import {
  registerCanvasFolderHandlers,
  unregisterCanvasFolderHandlers
} from './canvas-folder-handlers'
import { registerFolderViewHandlers, unregisterFolderViewHandlers } from './folder-view-handlers'
import { registerPropertiesHandlers, unregisterPropertiesHandlers } from './properties-handlers'
import { registerRelationHandlers, unregisterRelationHandlers } from './relation-handlers'
import {
  registerSyncHandlers,
  unregisterSyncHandlers,
  checkSyncIntegrity
} from './sync-core-handlers'
import { registerCryptoHandlers, unregisterCryptoHandlers } from './crypto-handlers'
import { registerRecentsHandlers, unregisterRecentsHandlers } from './recents-handlers'
import { registerSearchHandlers, unregisterSearchHandlers } from './search-handlers'
import { registerGraphHandlers, unregisterGraphHandlers } from './graph-handlers'
import { registerAIInlineHandlers, unregisterAIInlineHandlers } from './ai-inline-handlers'
import { registerAccountHandlers, unregisterAccountHandlers } from './account-handlers'
import { registerCrdtIpcHandlers } from './crdt-handlers'
import { registerTelemetryHandlers, unregisterTelemetryHandlers } from './telemetry-handlers'
import { registerFeedbackHandlers, unregisterFeedbackHandlers } from './feedback-handlers'
import { registerDiagnosticsHandlers, unregisterDiagnosticsHandlers } from './diagnostics-handlers'
import { registerUpdaterHandlers, unregisterUpdaterHandlers } from './updater-handlers'
import { registerAgentMcpHandlers, unregisterAgentMcpHandlers } from './agent-mcp-handlers'
import { registerImportHandlers, unregisterImportHandlers } from './import-handlers'
import { registerHomePageHandlers, unregisterHomePageHandlers } from './home-page-handlers'
import { registerLocaleHandlers, type RebuildMenuFn } from './locale-handler'
import { installIpcChannelLabels } from './lib/ipc-channel-labels'
import type { I18nInstance } from '@memry/i18n/main'
import { createLogger } from '../lib/logger'

const ipcLog = createLogger('IPC')

/**
 * Flag to prevent duplicate handler registration
 */
let handlersRegistered = false

interface IpcDeps {
  i18n: I18nInstance
  rebuildMenu: RebuildMenuFn
}

/**
 * Register all IPC handlers.
 * Call this once during app initialization in main process.
 *
 * @example
 * ```typescript
 * app.whenReady().then(() => {
 *   registerAllHandlers()
 *   createWindow()
 * })
 * ```
 */
export function registerAllHandlers(deps?: IpcDeps): void {
  if (handlersRegistered) {
    ipcLog.warn('handlers already registered, skipping')
    return
  }

  // Must run before the first registration: it labels each handler with the
  // channel it is registered on, which is what lets an IPC failure name a
  // channel instead of the generic `validated_handler`.
  installIpcChannelLabels()

  // Register vault handlers
  registerVaultHandlers()

  // Register notes handlers
  registerNotesHandlers()

  // Register tasks handlers
  registerTasksHandlers()

  // Register saved filters handlers
  registerSavedFiltersHandlers()

  // Register templates handlers
  registerTemplatesHandlers()

  // Register journal handlers
  registerJournalHandlers()

  // Register settings handlers
  registerSettingsHandlers()

  // Register locale handlers once main-process i18n is wired in
  if (deps) {
    registerLocaleHandlers(deps.i18n, deps.rebuildMenu)
  }

  // Register bookmarks handlers
  registerBookmarksHandlers()

  // Register tags handlers
  registerTagsHandlers()

  // Register inbox handlers
  registerInboxHandlers()

  // Register reminder handlers
  registerReminderHandlers()

  // Register calendar handlers
  registerCalendarHandlers()

  // Register canvas handlers (spatial canvas)
  registerCanvasHandlers()

  // Register canvas folder handlers (directories under <vault>/canvases)
  registerCanvasFolderHandlers()

  // Register folder view handlers
  registerFolderViewHandlers()

  // Register properties handlers (unified for notes + journal)
  registerPropertiesHandlers()

  // Register relation property resolution handlers
  registerRelationHandlers()

  // Register sync handlers
  registerSyncHandlers()
  checkSyncIntegrity().catch((err) => ipcLog.error('Sync integrity check failed', err))

  // Register crypto handlers
  registerCryptoHandlers()

  // Register search handlers
  registerRecentsHandlers()
  registerSearchHandlers()

  // Register graph handlers
  registerGraphHandlers()

  // Register AI inline editing handlers
  registerAIInlineHandlers()

  // Register account handlers
  registerAccountHandlers()

  // Register updater handlers
  registerUpdaterHandlers()

  // Register CRDT IPC handlers (app-scoped, survive sign-out/sign-in)
  registerCrdtIpcHandlers()

  // Register telemetry handlers (anonymous-safe, no auth required)
  registerTelemetryHandlers()

  // Register feedback handlers (anonymous-safe, no auth required)
  registerFeedbackHandlers()

  // Register diagnostics handlers (anonymous-safe, no auth required)
  registerDiagnosticsHandlers()

  // Register Agent MCP settings/status handlers
  registerAgentMcpHandlers()

  // Register generic import handlers
  registerImportHandlers()

  // Register home page handlers
  registerHomePageHandlers()

  handlersRegistered = true
}

/**
 * Unregister all IPC handlers.
 * Useful for cleanup or testing.
 */
export function unregisterAllHandlers(): void {
  if (!handlersRegistered) {
    return
  }

  unregisterVaultHandlers()
  unregisterNotesHandlers()
  unregisterTasksHandlers()
  unregisterSavedFiltersHandlers()
  unregisterTemplatesHandlers()
  unregisterJournalHandlers()
  unregisterSettingsHandlers()
  unregisterBookmarksHandlers()
  unregisterTagsHandlers()
  unregisterInboxHandlers()
  unregisterReminderHandlers()
  unregisterCalendarHandlers()
  unregisterCanvasHandlers()
  unregisterCanvasFolderHandlers()
  unregisterFolderViewHandlers()
  unregisterPropertiesHandlers()
  unregisterRelationHandlers()
  unregisterSyncHandlers()
  unregisterCryptoHandlers()
  unregisterRecentsHandlers()
  unregisterSearchHandlers()
  unregisterGraphHandlers()
  unregisterAIInlineHandlers()
  unregisterAccountHandlers()
  unregisterUpdaterHandlers()
  unregisterTelemetryHandlers()
  unregisterFeedbackHandlers()
  unregisterDiagnosticsHandlers()
  unregisterAgentMcpHandlers()
  unregisterImportHandlers()
  unregisterHomePageHandlers()

  handlersRegistered = false
  ipcLog.info('all handlers unregistered')
}

/**
 * Check if handlers are registered
 */
export function areHandlersRegistered(): boolean {
  return handlersRegistered
}

// Re-export individual handler modules for direct access if needed
export { registerVaultHandlers, unregisterVaultHandlers } from './vault-handlers'
export { registerNotesHandlers, unregisterNotesHandlers } from './notes-handlers'
export { registerTasksHandlers, unregisterTasksHandlers } from './tasks-handlers'
export {
  registerSavedFiltersHandlers,
  unregisterSavedFiltersHandlers
} from './saved-filters-handlers'
export { registerTemplatesHandlers, unregisterTemplatesHandlers } from './templates-handlers'
export { registerJournalHandlers, unregisterJournalHandlers } from './journal-handlers'
export { registerSettingsHandlers, unregisterSettingsHandlers } from './settings-handlers'
export { registerBookmarksHandlers, unregisterBookmarksHandlers } from './bookmarks-handlers'
export { registerTagsHandlers, unregisterTagsHandlers } from './tags-handlers'
export { registerInboxHandlers, unregisterInboxHandlers } from './inbox-handlers'
export { registerReminderHandlers, unregisterReminderHandlers } from './reminder-handlers'
export { registerCalendarHandlers, unregisterCalendarHandlers } from './calendar-handlers'
export { registerCanvasHandlers, unregisterCanvasHandlers } from './canvas-handlers'
export {
  registerCanvasFolderHandlers,
  unregisterCanvasFolderHandlers
} from './canvas-folder-handlers'
export { registerFolderViewHandlers, unregisterFolderViewHandlers } from './folder-view-handlers'
export { registerPropertiesHandlers, unregisterPropertiesHandlers } from './properties-handlers'
export { registerRelationHandlers, unregisterRelationHandlers } from './relation-handlers'
export { registerSyncHandlers, unregisterSyncHandlers } from './sync-core-handlers'
export { registerCryptoHandlers, unregisterCryptoHandlers } from './crypto-handlers'
export { registerRecentsHandlers, unregisterRecentsHandlers } from './recents-handlers'
export { registerSearchHandlers, unregisterSearchHandlers } from './search-handlers'
export { registerGraphHandlers, unregisterGraphHandlers } from './graph-handlers'
export { registerAIInlineHandlers, unregisterAIInlineHandlers } from './ai-inline-handlers'
export { registerUpdaterHandlers, unregisterUpdaterHandlers } from './updater-handlers'
export { registerTelemetryHandlers, unregisterTelemetryHandlers } from './telemetry-handlers'
export { registerFeedbackHandlers, unregisterFeedbackHandlers } from './feedback-handlers'
export { registerDiagnosticsHandlers, unregisterDiagnosticsHandlers } from './diagnostics-handlers'
export { registerAgentMcpHandlers, unregisterAgentMcpHandlers } from './agent-mcp-handlers'
export { registerImportHandlers, unregisterImportHandlers } from './import-handlers'
export { registerHomePageHandlers, unregisterHomePageHandlers } from './home-page-handlers'
export { registerLocaleHandlers, type RebuildMenuFn } from './locale-handler'
