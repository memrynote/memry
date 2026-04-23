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
import { registerFolderViewHandlers, unregisterFolderViewHandlers } from './folder-view-handlers'
import { registerPropertiesHandlers, unregisterPropertiesHandlers } from './properties-handlers'
import {
  registerSyncHandlers,
  unregisterSyncHandlers,
  checkSyncIntegrity
} from './sync-core-handlers'
import { registerCryptoHandlers, unregisterCryptoHandlers } from './crypto-handlers'
import { registerSearchHandlers, unregisterSearchHandlers } from './search-handlers'
import { registerGraphHandlers, unregisterGraphHandlers } from './graph-handlers'
import { registerAIInlineHandlers, unregisterAIInlineHandlers } from './ai-inline-handlers'
import { registerAccountHandlers, unregisterAccountHandlers } from './account-handlers'
import { registerCrdtIpcHandlers } from './crdt-handlers'
import { registerUpdaterHandlers, unregisterUpdaterHandlers } from './updater-handlers'
import { createLogger } from '../lib/logger'

const ipcLog = createLogger('IPC')

/**
 * Flag to prevent duplicate handler registration
 */
let handlersRegistered = false

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
export function registerAllHandlers(): void {
  if (handlersRegistered) {
    ipcLog.warn('handlers already registered, skipping')
    return
  }

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

  // Register folder view handlers
  registerFolderViewHandlers()

  // Register properties handlers (unified for notes + journal)
  registerPropertiesHandlers()

  // Register sync handlers
  registerSyncHandlers()
  checkSyncIntegrity().catch((err) => ipcLog.error('Sync integrity check failed', err))

  // Register crypto handlers
  registerCryptoHandlers()

  // Register search handlers
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
  unregisterFolderViewHandlers()
  unregisterPropertiesHandlers()
  unregisterSyncHandlers()
  unregisterCryptoHandlers()
  unregisterSearchHandlers()
  unregisterGraphHandlers()
  unregisterAIInlineHandlers()
  unregisterAccountHandlers()
  unregisterUpdaterHandlers()

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
export { registerFolderViewHandlers, unregisterFolderViewHandlers } from './folder-view-handlers'
export { registerPropertiesHandlers, unregisterPropertiesHandlers } from './properties-handlers'
export { registerSyncHandlers, unregisterSyncHandlers } from './sync-core-handlers'
export { registerCryptoHandlers, unregisterCryptoHandlers } from './crypto-handlers'
export { registerSearchHandlers, unregisterSearchHandlers } from './search-handlers'
export { registerGraphHandlers, unregisterGraphHandlers } from './graph-handlers'
export { registerAIInlineHandlers, unregisterAIInlineHandlers } from './ai-inline-handlers'
export { registerUpdaterHandlers, unregisterUpdaterHandlers } from './updater-handlers'
