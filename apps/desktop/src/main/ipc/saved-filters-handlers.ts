/**
 * Saved Filters IPC handlers.
 * Handles all saved filter-related IPC communication from renderer.
 *
 * @module ipc/saved-filters-handlers
 */

import { ipcMain, BrowserWindow } from 'electron'
import { SavedFiltersChannels } from '@memry/contracts/ipc-channels'
import {
  SavedFilterCreateSchema,
  SavedFilterUpdateSchema,
  SavedFilterDeleteSchema,
  SavedFilterReorderSchema,
  type SavedFilter
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

/**
 * Emit saved filter event to all windows
 */
function emitSavedFilterEvent(channel: string, data: unknown): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send(channel, data)
  })
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
    config: dbFilter.config as SavedFilter['config'],
    position: dbFilter.position,
    createdAt: dbFilter.createdAt
  }
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
        position
      })

      const apiFilter = toApiFilter(filter)!
      emitSavedFilterEvent(SavedFiltersChannels.events.CREATED, { savedFilter: apiFilter })
      syncFilterCreate(db, id)

      return { success: true, savedFilter: apiFilter }
    })
  )

  // saved-filters:update - Update a saved filter
  ipcMain.handle(
    SavedFiltersChannels.invoke.UPDATE,
    createValidatedHandler(SavedFilterUpdateSchema, (input) => {
      const db = requireDatabase()

      // Check if filter exists
      if (!savedFiltersStore.savedFilterExists(db, input.id)) {
        return { success: false, savedFilter: null, error: 'Saved filter not found' }
      }

      const updates: { name?: string; config?: unknown; position?: number } = {}
      if (input.name !== undefined) updates.name = input.name
      if (input.config !== undefined) updates.config = input.config
      if (input.position !== undefined) updates.position = input.position

      const filter = savedFiltersStore.updateSavedFilter(db, input.id, updates)
      const apiFilter = toApiFilter(filter)

      emitSavedFilterEvent(SavedFiltersChannels.events.UPDATED, {
        id: input.id,
        savedFilter: apiFilter
      })
      syncFilterUpdate(db, input.id)

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
        return { success: false, error: 'Saved filter not found' }
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
