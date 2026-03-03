/**
 * Tab Persistence - Barrel Export
 */

// Types
export type { PersistedTabState, PersistedTabGroup, PersistedTab, TabStorage } from './types'
export { STORAGE_VERSION, STORAGE_KEY } from './types'

// Serialization
export { serializeTabState, deserializeTabState, extractPinnedTabs } from './serialization'

// Storage adapters
export { localStorageAdapter, indexedDBAdapter, getDefaultStorage, saveSync } from './storage'

// Migrations
export { migratePersistedState, needsMigration, getMigrationDescription } from './migrations'

// Hooks
export { useTabPersistence, useSessionRestore, useManualPersistence } from './hooks'
