/**
 * Tab Persistence - Barrel Export
 */

// Types
export type { PersistedTabState, PersistedTabGroup, PersistedTab, TabStorage } from './types'
export { STORAGE_VERSION, STORAGE_KEY, tabStateStorageKey } from './types'

// Serialization
export { serializeTabState, deserializeTabState, extractPinnedTabs } from './serialization'

// Storage adapters
export {
  localStorageAdapter,
  createLocalStorageAdapter,
  clearTabStateForVault,
  getDefaultStorage,
  saveSync
} from './storage'
export type { SyncSaveFailure, SyncSaveResult } from './storage'

// Migrations
export { migratePersistedState, needsMigration, getMigrationDescription } from './migrations'

// Hooks
export {
  useTabPersistence,
  useSessionRestore,
  useTabSessionPersistence,
  useManualPersistence
} from './hooks'
