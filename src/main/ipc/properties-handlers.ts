/**
 * Unified Properties IPC Handlers
 *
 * Handles property get/set operations for both notes and journal entries.
 * Routes to appropriate update logic based on entity type (determined by
 * checking if the entity has a date field in the cache).
 *
 * @module ipc/properties-handlers
 */

import { ipcMain } from 'electron'
import {
  PropertiesChannels,
  GetPropertiesSchema,
  SetPropertiesSchema,
  RenamePropertySchema,
  type SetPropertiesResponse,
  type RenamePropertyResponse
} from '@shared/contracts/properties-api'
import type { PropertyValue } from '@shared/db/queries/notes'
import { createLogger } from '../lib/logger'
import { createValidatedHandler } from './validate'
import { getNoteCacheById, getNoteProperties } from '@shared/db/queries/notes'
import { getIndexDatabase } from '../database'
import { updateNote } from '../vault/notes'
import { getNoteSyncService } from '../sync/note-sync'
import { getJournalSyncService } from '../sync/journal-sync'
import {
  readJournalEntry,
  writeJournalEntryWithContent,
  getJournalRelativePath
} from '../vault/journal'
import { syncNoteToCache } from '../vault/note-sync'
import { getJournalEntryByDate } from '@shared/db/queries/notes'

const logger = createLogger('IPC:Properties')

// ============================================================================
// Handler Registration
// ============================================================================

/**
 * Register all properties-related IPC handlers.
 * Call this once during app initialization.
 */
export function registerPropertiesHandlers(): void {
  // -------------------------------------------------------------------------
  // properties:get - Get properties for any entity by ID
  // -------------------------------------------------------------------------
  ipcMain.handle(
    PropertiesChannels.invoke.GET,
    createValidatedHandler(GetPropertiesSchema, async (input): Promise<PropertyValue[]> => {
      const db = getIndexDatabase()
      return getNoteProperties(db, input.entityId)
    })
  )

  // -------------------------------------------------------------------------
  // properties:set - Set properties for any entity by ID
  // -------------------------------------------------------------------------
  ipcMain.handle(
    PropertiesChannels.invoke.SET,
    createValidatedHandler(SetPropertiesSchema, async (input): Promise<SetPropertiesResponse> => {
      const db = getIndexDatabase()
      const entity = getNoteCacheById(db, input.entityId)

      if (!entity) {
        return { success: false, error: 'Entity not found' }
      }

      logger.debug('properties:set', {
        entityId: input.entityId,
        propertyKeys: Object.keys(input.properties)
      })

      try {
        if (entity.date) {
          await updateJournalProperties(entity.date, input.properties)
          getJournalSyncService()?.enqueueUpdate(input.entityId)
        } else {
          await updateNote({ id: input.entityId, properties: input.properties })
          getNoteSyncService()?.enqueueUpdate(input.entityId)
        }
        return { success: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to set properties'
        logger.error('properties:set error:', error)
        return { success: false, error: message }
      }
    })
  )

  // -------------------------------------------------------------------------
  // properties:rename - Rename a property for any entity by ID (note-only scope)
  // -------------------------------------------------------------------------
  ipcMain.handle(
    PropertiesChannels.invoke.RENAME,
    createValidatedHandler(RenamePropertySchema, async (input): Promise<RenamePropertyResponse> => {
      const db = getIndexDatabase()
      const entity = getNoteCacheById(db, input.entityId)

      if (!entity) {
        return { success: false, error: 'Entity not found' }
      }

      try {
        // Get existing properties
        const existingProps = getNoteProperties(db, input.entityId)
        const propToRename = existingProps.find((p) => p.name === input.oldName)

        if (!propToRename) {
          return { success: false, error: `Property "${input.oldName}" not found` }
        }

        // Check if new name already exists
        if (existingProps.some((p) => p.name === input.newName)) {
          return { success: false, error: `Property "${input.newName}" already exists` }
        }

        // Build new properties object with renamed property
        const newProperties: Record<string, unknown> = {}
        for (const prop of existingProps) {
          if (prop.name === input.oldName) {
            newProperties[input.newName] = prop.value
          } else {
            newProperties[prop.name] = prop.value
          }
        }

        // Update based on entity type
        if (entity.date) {
          await updateJournalProperties(entity.date, newProperties)
          getJournalSyncService()?.enqueueUpdate(input.entityId)
        } else {
          await updateNote({ id: input.entityId, properties: newProperties })
          getNoteSyncService()?.enqueueUpdate(input.entityId)
        }

        return { success: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to rename property'
        logger.error('properties:rename error:', error)
        return { success: false, error: message }
      }
    })
  )
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Unregister all properties-related IPC handlers.
 * Useful for cleanup or testing.
 */
export function unregisterPropertiesHandlers(): void {
  ipcMain.removeHandler(PropertiesChannels.invoke.GET)
  ipcMain.removeHandler(PropertiesChannels.invoke.SET)
  ipcMain.removeHandler(PropertiesChannels.invoke.RENAME)
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Update properties for a journal entry.
 * Reads the existing entry, updates only the properties, and syncs to cache.
 *
 * @param date - Journal entry date (YYYY-MM-DD)
 * @param properties - Properties to set
 */
async function updateJournalProperties(
  date: string,
  properties: Record<string, unknown>
): Promise<void> {
  const existing = await readJournalEntry(date)
  if (!existing) {
    throw new Error(`Journal entry not found: ${date}`)
  }

  // Write entry with updated properties (preserving content and tags)
  const { entry, fileContent, frontmatter } = await writeJournalEntryWithContent(
    date,
    existing.content,
    existing.tags,
    existing,
    properties
  )

  // Sync to cache
  const db = getIndexDatabase()
  const journalPath = getJournalRelativePath(date)
  const cached = getJournalEntryByDate(db, date)

  syncNoteToCache(
    db,
    {
      id: cached?.id ?? entry.id,
      path: journalPath,
      fileContent,
      frontmatter,
      parsedContent: entry.content
    },
    { isNew: false }
  )
}
