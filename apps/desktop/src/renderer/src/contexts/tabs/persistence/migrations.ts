/**
 * Schema Migrations
 * Handle schema changes between versions
 */

import type { SplitLayout } from '@/contexts/tabs/types'
import type { PersistedTabState } from './types'
import { STORAGE_VERSION } from './types'

/**
 * Recursively migrate layout from old format to new format.
 * Old: { type: 'horizontal' | 'vertical', ratio, first, second }
 * New: { type: 'split', direction: 'horizontal' | 'vertical', ratio, first, second }
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const migrateLayout = (layout: any): SplitLayout => {
  if (!layout || typeof layout !== 'object') {
    return layout
  }

  if (layout.type === 'leaf') return layout

  if (layout.type === 'horizontal' || layout.type === 'vertical') {
    return {
      type: 'split',
      direction: layout.type,
      ratio: layout.ratio ?? 0.5,
      first: migrateLayout(layout.first),
      second: migrateLayout(layout.second)
    }
  }

  if (layout.type === 'split') {
    return {
      ...layout,
      first: migrateLayout(layout.first),
      second: migrateLayout(layout.second)
    }
  }

  return layout
}

/**
 * Migrate persisted state to current schema version
 */
export const migratePersistedState = (persisted: PersistedTabState): PersistedTabState => {
  const migrated = { ...persisted }

  if (migrated.version >= STORAGE_VERSION) {
    return migrated
  }

  // Version 0 to 1: Add viewState to tabs
  if (migrated.version < 1) {
    for (const group of Object.values(migrated.tabGroups)) {
      for (const tab of group.tabs) {
        if (!tab.viewState) {
          tab.viewState = {}
        }
      }
    }
    migrated.version = 1
  }

  // Version 1 to 2: Migrate layout format (horizontal/vertical → split+direction)
  if (migrated.version < 2) {
    migrated.layout = migrateLayout(migrated.layout)
    migrated.version = 2
  }

  return migrated
}

/**
 * Check if persisted state needs migration
 */
export const needsMigration = (persisted: PersistedTabState): boolean => {
  return persisted.version < STORAGE_VERSION
}

/**
 * Get migration description for logging
 */
export const getMigrationDescription = (fromVersion: number, toVersion: number): string => {
  const descriptions: string[] = []

  if (fromVersion < 1 && toVersion >= 1) {
    descriptions.push('Added viewState to tabs')
  }

  if (fromVersion < 2 && toVersion >= 2) {
    descriptions.push('Migrated layout format (horizontal/vertical → split+direction)')
  }

  return descriptions.join(', ') || 'No migrations needed'
}
