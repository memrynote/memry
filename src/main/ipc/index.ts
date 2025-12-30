import { registerVaultHandlers, unregisterVaultHandlers } from './vault-handlers'
import { registerNotesHandlers, unregisterNotesHandlers } from './notes-handlers'
import { registerSearchHandlers, unregisterSearchHandlers } from './search-handlers'
import { registerTasksHandlers, unregisterTasksHandlers } from './tasks-handlers'
import {
  registerSavedFiltersHandlers,
  unregisterSavedFiltersHandlers
} from './saved-filters-handlers'
import { registerTemplatesHandlers, unregisterTemplatesHandlers } from './templates-handlers'
import { registerJournalHandlers, unregisterJournalHandlers } from './journal-handlers'
import { registerSettingsHandlers, unregisterSettingsHandlers } from './settings-handlers'
import { registerBookmarksHandlers, unregisterBookmarksHandlers } from './bookmarks-handlers'
import { registerTagsHandlers } from './tags-handlers'
import { registerInboxHandlers, unregisterInboxHandlers } from './inbox-handlers'
import { registerReminderHandlers, unregisterReminderHandlers } from './reminder-handlers'

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
    console.warn('IPC handlers already registered, skipping duplicate registration')
    return
  }

  // Register vault handlers
  registerVaultHandlers()

  // Register notes handlers
  registerNotesHandlers()

  // Register search handlers
  registerSearchHandlers()

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

  handlersRegistered = true
  console.log('All IPC handlers registered')
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
  unregisterSearchHandlers()
  unregisterTasksHandlers()
  unregisterSavedFiltersHandlers()
  unregisterTemplatesHandlers()
  unregisterJournalHandlers()
  unregisterSettingsHandlers()
  unregisterBookmarksHandlers()
  unregisterInboxHandlers()
  unregisterReminderHandlers()

  handlersRegistered = false
  console.log('All IPC handlers unregistered')
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
export { registerSearchHandlers, unregisterSearchHandlers } from './search-handlers'
export { registerTasksHandlers, unregisterTasksHandlers } from './tasks-handlers'
export {
  registerSavedFiltersHandlers,
  unregisterSavedFiltersHandlers
} from './saved-filters-handlers'
export { registerTemplatesHandlers, unregisterTemplatesHandlers } from './templates-handlers'
export { registerJournalHandlers, unregisterJournalHandlers } from './journal-handlers'
export { registerSettingsHandlers, unregisterSettingsHandlers } from './settings-handlers'
export { registerBookmarksHandlers, unregisterBookmarksHandlers } from './bookmarks-handlers'
export { registerTagsHandlers } from './tags-handlers'
export { registerInboxHandlers, unregisterInboxHandlers } from './inbox-handlers'
export { registerReminderHandlers, unregisterReminderHandlers } from './reminder-handlers'
