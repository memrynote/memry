/**
 * Saved Filters IPC handlers.
 * Handles all saved filter-related IPC communication from renderer.
 *
 * @module ipc/saved-filters-handlers
 */

import { ipcMain } from 'electron'
import { broadcastToAllWindows } from '../lib/window-broadcast'
import { SavedFiltersChannels } from '@memry/contracts/ipc-channels'
import {
  SavedFilterCreateSchema,
  SavedFilterUpdateSchema,
  SavedFilterDeleteSchema,
  SavedFilterReorderSchema,
  type SavedFilter,
  type SavedFilterUpdateInput
} from '@memry/contracts/saved-filters-api'
import { createValidatedHandler, createHandler } from './validate'
import { requireDatabase } from '../database'
import { generateId } from '../lib/id'
import * as savedFiltersStore from '../settings/saved-filters-store'
import {
  syncFilterCreate,
  syncFilterDelete,
  syncFilterUpdate
} from '../settings/saved-filters-sync'
import { getMainI18n } from '../lib/main-i18n'

/**
 * Emit saved filter event to all windows
 */
function emitSavedFilterEvent(channel: string, data: unknown): void {
  broadcastToAllWindows(channel, data)
}

/**
 * Convert DB saved filter to API format
 */
function toApiFilter(
  dbFilter: ReturnType<typeof savedFiltersStore.getSavedFilterById>
): SavedFilter | null {
  if (!dbFilter) return null
  return {
    id: dbFilter.id,
    name: dbFilter.name,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- value from an untyped boundary (database, parser or runtime); the asserted shape is what its producer writes
    config: dbFilter.config as SavedFilter['config'],
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- stored verbatim from this build's schema or a peer's payload; the evaluator skips what it does not know
    expression: (dbFilter.expression ?? null) as SavedFilter['expression'],
    position: dbFilter.position,
    createdAt: dbFilter.createdAt
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The stored config with an edit merged in, `config` and `config.filters` key
 * by key, so a key this build does not model (a newer build's) survives the
 * edit (docs/protocol §13.7.14). Writers send every key they mean to change,
 * cleared ones included (`folderPaths: []`), so a merge never revives a value.
 */
function mergeSavedFilterConfig(
  stored: unknown,
  edit: SavedFilterUpdateInput['config'],
  starred: boolean | undefined
): Record<string, unknown> {
  const base = isPlainObject(stored) ? stored : {}
  const merged: Record<string, unknown> = { ...base }
  if (edit) {
    Object.assign(merged, edit)
    merged.filters = {
      ...(isPlainObject(base.filters) ? base.filters : {}),
      ...edit.filters
    }
  }
  if (starred !== undefined) merged.starred = starred
  return merged
}

/**
 * Register all saved filter-related IPC handlers.
 * Call this once during app initialization.
 */
export function registerSavedFiltersHandlers(): void {
  // ============================================================================
  // Saved Filter CRUD
  // ============================================================================

  // saved-filters:list - List all saved filters
  ipcMain.handle(
    SavedFiltersChannels.invoke.LIST,
    createHandler(() => {
      const db = requireDatabase()
      const filters = savedFiltersStore.listSavedFilters(db)
      return {
        savedFilters: filters.map((f) => toApiFilter(f)!)
      }
    })
  )

  // saved-filters:create - Create a new saved filter
  ipcMain.handle(
    SavedFiltersChannels.invoke.CREATE,
    createValidatedHandler(SavedFilterCreateSchema, (input) => {
      const db = requireDatabase()
      const id = generateId()
      const position = savedFiltersStore.getNextSavedFilterPosition(db)

      const filter = savedFiltersStore.insertSavedFilter(db, {
        id,
        name: input.name,
        config: input.config,
        expression: input.expression ?? null,
        position
      })

      const apiFilter = toApiFilter(filter)!
      emitSavedFilterEvent(SavedFiltersChannels.events.CREATED, { savedFilter: apiFilter })
      syncFilterCreate(id)

      return { success: true, savedFilter: apiFilter }
    })
  )

  // saved-filters:update - Update a saved filter
  ipcMain.handle(
    SavedFiltersChannels.invoke.UPDATE,
    createValidatedHandler(SavedFilterUpdateSchema, (input) => {
      const db = requireDatabase()

      const existing = savedFiltersStore.getSavedFilterById(db, input.id)
      if (!existing) {
        return {
          success: false,
          savedFilter: null,
          error: getMainI18n().t('errors:savedFilter.notFound')
        }
      }

      const updates: { name?: string; config?: unknown; expression?: unknown; position?: number } =
        {}
      if (input.name !== undefined) updates.name = input.name
      if (input.config !== undefined || input.starred !== undefined) {
        updates.config = mergeSavedFilterConfig(existing.config, input.config, input.starred)
      }
      if (input.expression !== undefined) updates.expression = input.expression
      if (input.position !== undefined) updates.position = input.position

      const filter = savedFiltersStore.updateSavedFilter(db, input.id, updates)
      const apiFilter = toApiFilter(filter)

      emitSavedFilterEvent(SavedFiltersChannels.events.UPDATED, {
        id: input.id,
        savedFilter: apiFilter
      })
      syncFilterUpdate(input.id)

      return { success: true, savedFilter: apiFilter }
    })
  )

  // saved-filters:delete - Delete a saved filter
  ipcMain.handle(
    SavedFiltersChannels.invoke.DELETE,
    createValidatedHandler(SavedFilterDeleteSchema, (input) => {
      const db = requireDatabase()

      const existing = savedFiltersStore.getSavedFilterById(db, input.id)
      if (!existing) {
        return { success: false, error: getMainI18n().t('errors:savedFilter.notFound') }
      }

      const snapshot = JSON.stringify(existing)
      savedFiltersStore.deleteSavedFilter(db, input.id)
      emitSavedFilterEvent(SavedFiltersChannels.events.DELETED, { id: input.id })
      syncFilterDelete(input.id, snapshot)

      return { success: true }
    })
  )

  // saved-filters:reorder - Reorder saved filters
  ipcMain.handle(
    SavedFiltersChannels.invoke.REORDER,
    createValidatedHandler(SavedFilterReorderSchema, (input) => {
      const db = requireDatabase()
      savedFiltersStore.reorderSavedFilters(db, input.ids, input.positions)
      // Position is part of the synced record, so each moved filter pushes.
      for (const id of input.ids) syncFilterUpdate(id)
      return { success: true }
    })
  )
}

/**
 * Unregister all saved filter-related IPC handlers.
 */
export function unregisterSavedFiltersHandlers(): void {
  ipcMain.removeHandler(SavedFiltersChannels.invoke.LIST)
  ipcMain.removeHandler(SavedFiltersChannels.invoke.CREATE)
  ipcMain.removeHandler(SavedFiltersChannels.invoke.UPDATE)
  ipcMain.removeHandler(SavedFiltersChannels.invoke.DELETE)
  ipcMain.removeHandler(SavedFiltersChannels.invoke.REORDER)
}
