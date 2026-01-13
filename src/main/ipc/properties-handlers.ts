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
  type SetPropertiesResponse
} from '@shared/contracts/properties-api'
import type { PropertyValue } from '@shared/db/queries/notes'
import { createValidatedHandler } from './validate'
import { getNoteCacheById, getNoteProperties } from '@shared/db/queries/notes'
import { getIndexDatabase } from '../database'
import { updateNote } from '../vault/notes'
import {
  readJournalEntry,
  writeJournalEntryWithContent,
  getJournalRelativePath
} from '../vault/journal'
import { syncNoteToCache } from '../vault/note-sync'
import { getJournalEntryByDate } from '@shared/db/queries/notes'

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

      try {
        // Determine entity type by checking the date field
        // Non-null date = journal entry, null date = regular note
        if (entity.date) {
          // Journal entry - update via journal file operations
          await updateJournalProperties(entity.date, input.properties)
        } else {
          // Regular note - update via note file operations
          await updateNote({ id: input.entityId, properties: input.properties })
        }
        return { success: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to set properties'
        console.error('[properties:set] Error:', error)
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
