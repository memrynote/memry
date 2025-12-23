/**
 * Notes IPC handlers.
 * Handles all note-related IPC communication from renderer.
 *
 * @module ipc/notes-handlers
 */

import { ipcMain } from 'electron'
import { z } from 'zod'
import {
  NotesChannels,
  NoteCreateSchema,
  NoteUpdateSchema,
  NoteRenameSchema,
  NoteMoveSchema,
  NoteListSchema
} from '@shared/contracts/notes-api'
import { PropertyTypes } from '@shared/db/schema/notes-cache'
import { RenameFolderSchema } from '@shared/contracts/tasks-api'
import { createValidatedHandler, createHandler, createStringHandler } from './validate'
import {
  createNote,
  getNoteById,
  getNoteByPath,
  updateNote,
  renameNote,
  moveNote,
  deleteNote,
  listNotes,
  getTagsWithCounts,
  getNoteLinks,
  getFolders,
  createFolder,
  renameFolder,
  deleteFolder,
  noteExists,
  openExternal,
  revealInFinder
} from '../vault/notes'
import {
  getNoteProperties,
  getAllPropertyDefinitions,
  insertPropertyDefinition,
  updatePropertyDefinition
} from '@shared/db/queries/notes'
import { getIndexDatabase } from '../database'

// ============================================================================
// Zod Schemas for Properties (T015-T018)
// ============================================================================

const SetPropertiesSchema = z.object({
  noteId: z.string().min(1),
  properties: z.record(z.string(), z.unknown())
})

const CreatePropertyDefinitionSchema = z.object({
  name: z.string().min(1),
  type: z.enum([
    PropertyTypes.TEXT,
    PropertyTypes.NUMBER,
    PropertyTypes.CHECKBOX,
    PropertyTypes.DATE,
    PropertyTypes.SELECT,
    PropertyTypes.MULTISELECT,
    PropertyTypes.URL,
    PropertyTypes.RATING
  ]),
  options: z.array(z.string()).optional(),
  defaultValue: z.unknown().optional(),
  color: z.string().optional()
})

const UpdatePropertyDefinitionSchema = z.object({
  name: z.string().min(1),
  type: z
    .enum([
      PropertyTypes.TEXT,
      PropertyTypes.NUMBER,
      PropertyTypes.CHECKBOX,
      PropertyTypes.DATE,
      PropertyTypes.SELECT,
      PropertyTypes.MULTISELECT,
      PropertyTypes.URL,
      PropertyTypes.RATING
    ])
    .optional(),
  options: z.array(z.string()).optional(),
  defaultValue: z.unknown().optional(),
  color: z.string().optional()
})

/**
 * Register all note-related IPC handlers.
 * Call this once during app initialization.
 */
export function registerNotesHandlers(): void {
  // notes:create - Create a new note
  ipcMain.handle(
    NotesChannels.invoke.CREATE,
    createValidatedHandler(NoteCreateSchema, async (input) => {
      try {
        const note = await createNote(input)
        return { success: true, note }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to create note'
        return { success: false, note: null, error: message }
      }
    })
  )

  // notes:get - Get a note by ID
  ipcMain.handle(
    NotesChannels.invoke.GET,
    createStringHandler(async (id) => {
      return getNoteById(id)
    })
  )

  // notes:get-by-path - Get a note by path
  ipcMain.handle(
    NotesChannels.invoke.GET_BY_PATH,
    createStringHandler(async (path) => {
      return getNoteByPath(path)
    })
  )

  // notes:update - Update note content/metadata
  ipcMain.handle(
    NotesChannels.invoke.UPDATE,
    createValidatedHandler(NoteUpdateSchema, async (input) => {
      try {
        const note = await updateNote(input)
        return { success: true, note }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to update note'
        return { success: false, note: null, error: message }
      }
    })
  )

  // notes:rename - Rename a note
  ipcMain.handle(
    NotesChannels.invoke.RENAME,
    createValidatedHandler(NoteRenameSchema, async (input) => {
      try {
        const note = await renameNote(input.id, input.newTitle)
        return { success: true, note }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to rename note'
        return { success: false, note: null, error: message }
      }
    })
  )

  // notes:move - Move note to different folder
  ipcMain.handle(
    NotesChannels.invoke.MOVE,
    createValidatedHandler(NoteMoveSchema, async (input) => {
      try {
        const note = await moveNote(input.id, input.newFolder)
        return { success: true, note }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to move note'
        return { success: false, note: null, error: message }
      }
    })
  )

  // notes:delete - Delete a note
  ipcMain.handle(
    NotesChannels.invoke.DELETE,
    createStringHandler(async (id) => {
      try {
        await deleteNote(id)
        return { success: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to delete note'
        return { success: false, error: message }
      }
    })
  )

  // notes:list - List notes with filtering
  ipcMain.handle(
    NotesChannels.invoke.LIST,
    createValidatedHandler(NoteListSchema, async (input) => {
      return listNotes(input)
    })
  )

  // notes:get-tags - Get all tags with counts
  ipcMain.handle(
    NotesChannels.invoke.GET_TAGS,
    createHandler(async () => {
      return getTagsWithCounts()
    })
  )

  // notes:get-links - Get note links (outgoing and incoming)
  ipcMain.handle(
    NotesChannels.invoke.GET_LINKS,
    createStringHandler(async (id) => {
      return getNoteLinks(id)
    })
  )

  // notes:get-folders - Get folder structure
  ipcMain.handle(
    NotesChannels.invoke.GET_FOLDERS,
    createHandler(async () => {
      return getFolders()
    })
  )

  // notes:create-folder - Create a new folder
  ipcMain.handle(
    NotesChannels.invoke.CREATE_FOLDER,
    createStringHandler(async (path) => {
      try {
        await createFolder(path)
        return { success: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to create folder'
        return { success: false, error: message }
      }
    })
  )

  // notes:rename-folder - Rename a folder
  ipcMain.handle(
    NotesChannels.invoke.RENAME_FOLDER,
    createValidatedHandler(RenameFolderSchema, async (input) => {
      try {
        await renameFolder(input.oldPath, input.newPath)
        return { success: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to rename folder'
        return { success: false, error: message }
      }
    })
  )

  // notes:delete-folder - Delete a folder and all its contents
  ipcMain.handle(
    NotesChannels.invoke.DELETE_FOLDER,
    createStringHandler(async (folderPath) => {
      try {
        await deleteFolder(folderPath)
        return { success: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to delete folder'
        return { success: false, error: message }
      }
    })
  )

  // notes:exists - Check if note exists
  ipcMain.handle(
    NotesChannels.invoke.EXISTS,
    createStringHandler(async (titleOrPath) => {
      return noteExists(titleOrPath)
    })
  )

  // notes:open-external - Open note in external editor
  ipcMain.handle(
    NotesChannels.invoke.OPEN_EXTERNAL,
    createStringHandler(async (id) => {
      await openExternal(id)
    })
  )

  // notes:reveal-in-finder - Reveal note in file explorer
  ipcMain.handle(
    NotesChannels.invoke.REVEAL_IN_FINDER,
    createStringHandler(async (id) => {
      await revealInFinder(id)
    })
  )

  // =========================================================================
  // T015-T018: Properties IPC Handlers
  // =========================================================================

  // T015: notes:get-properties - Get properties for a note
  ipcMain.handle(
    NotesChannels.invoke.GET_PROPERTIES,
    createStringHandler(async (noteId) => {
      const db = getIndexDatabase()
      return getNoteProperties(db, noteId)
    })
  )

  // T016: notes:set-properties - Set properties for a note
  // IMPORTANT: Must save to frontmatter file (source of truth), not just DB cache
  ipcMain.handle(
    NotesChannels.invoke.SET_PROPERTIES,
    createValidatedHandler(SetPropertiesSchema, async (input) => {
      try {
        // Use updateNote to save properties to frontmatter (source of truth)
        // The updateNote function handles both file write and DB cache update
        await updateNote({
          id: input.noteId,
          properties: input.properties
        })
        return { success: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to set properties'
        return { success: false, error: message }
      }
    })
  )

  // T017: notes:get-property-definitions - Get all property definitions
  ipcMain.handle(
    NotesChannels.invoke.GET_PROPERTY_DEFINITIONS,
    createHandler(async () => {
      const db = getIndexDatabase()
      return getAllPropertyDefinitions(db)
    })
  )

  // T018: notes:create-property-definition - Create a new property definition
  ipcMain.handle(
    NotesChannels.invoke.CREATE_PROPERTY_DEFINITION,
    createValidatedHandler(CreatePropertyDefinitionSchema, async (input) => {
      try {
        const db = getIndexDatabase()
        const definition = insertPropertyDefinition(db, {
          name: input.name,
          type: input.type,
          options: input.options ? JSON.stringify(input.options) : null,
          defaultValue: input.defaultValue ? JSON.stringify(input.defaultValue) : null,
          color: input.color ?? null
        })
        return { success: true, definition }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Failed to create property definition'
        return { success: false, definition: null, error: message }
      }
    })
  )

  // notes:update-property-definition - Update a property definition
  ipcMain.handle(
    NotesChannels.invoke.UPDATE_PROPERTY_DEFINITION,
    createValidatedHandler(UpdatePropertyDefinitionSchema, async (input) => {
      try {
        const db = getIndexDatabase()
        const { name, ...updates } = input
        const definition = updatePropertyDefinition(db, name, {
          type: updates.type,
          options: updates.options ? JSON.stringify(updates.options) : undefined,
          defaultValue: updates.defaultValue ? JSON.stringify(updates.defaultValue) : undefined,
          color: updates.color
        })
        return { success: true, definition }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Failed to update property definition'
        return { success: false, definition: null, error: message }
      }
    })
  )
}

/**
 * Unregister all note-related IPC handlers.
 * Useful for cleanup or testing.
 */
export function unregisterNotesHandlers(): void {
  Object.values(NotesChannels.invoke).forEach((channel) => {
    ipcMain.removeHandler(channel)
  })
}
