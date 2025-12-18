import { registerVaultHandlers, unregisterVaultHandlers } from './vault-handlers'
import { registerNotesHandlers, unregisterNotesHandlers } from './notes-handlers'

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

  // Future handler registrations:
  // registerTasksHandlers()
  // registerSearchHandlers()

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
  // Future: unregisterTasksHandlers(), etc.

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
