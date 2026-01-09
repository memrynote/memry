/**
 * Notes IPC handlers.
 * Handles all note-related IPC communication from renderer.
 *
 * @module ipc/notes-handlers
 */

import { ipcMain, dialog, BrowserWindow } from 'electron'
import * as fs from 'fs/promises'
import { z } from 'zod'
import {
  NotesChannels,
  NoteCreateSchema,
  NoteUpdateSchema,
  NoteRenameSchema,
  NoteMoveSchema,
  NoteListSchema,
  NoteReorderSchema,
  NoteGetPositionsSchema
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
  revealInFinder,
  // Version history (T114)
  getVersionHistory,
  getVersion,
  restoreVersion
} from '../vault/notes'
import { deleteNoteSnapshot } from '@shared/db/queries/notes'
import { saveAttachment, deleteAttachment, listNoteAttachments } from '../vault/attachments'
import { readFolderConfig, writeFolderConfig, getFolderTemplate } from '../vault/folders'
import { renderNoteAsHtml, sanitizeFilename } from '../lib/export-utils'
import { SetFolderConfigSchema } from '@shared/contracts/templates-api'
import {
  getNoteProperties,
  getAllPropertyDefinitions,
  insertPropertyDefinition,
  updatePropertyDefinition
} from '@shared/db/queries/notes'
import { getIndexDatabase, getDatabase } from '../database'
import {
  getNotesInFolder,
  reorderNotesInFolder,
  getAllNotePositions
} from '@shared/db/queries/note-positions'

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

// ============================================================================
// Zod Schemas for Attachments (T070)
// ============================================================================

const UploadAttachmentSchema = z.object({
  noteId: z.string().min(1),
  filename: z.string().min(1),
  data: z.instanceof(ArrayBuffer).or(z.array(z.number()))
})

const DeleteAttachmentSchema = z.object({
  noteId: z.string().min(1),
  filename: z.string().min(1)
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

// ============================================================================
// Zod Schemas for Export (T106, T108)
// ============================================================================

const ExportNoteSchema = z.object({
  noteId: z.string().min(1),
  includeMetadata: z.boolean().default(true),
  pageSize: z.enum(['A4', 'Letter', 'Legal']).default('A4')
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
    createHandler(() => {
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
    createStringHandler((noteId) => {
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
    createHandler(() => {
      const db = getIndexDatabase()
      return getAllPropertyDefinitions(db)
    })
  )

  // T018: notes:create-property-definition - Create a new property definition
  ipcMain.handle(
    NotesChannels.invoke.CREATE_PROPERTY_DEFINITION,
    createValidatedHandler(CreatePropertyDefinitionSchema, (input) => {
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
    createValidatedHandler(UpdatePropertyDefinitionSchema, (input) => {
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

  // =========================================================================
  // T070: Attachment IPC Handlers
  // =========================================================================

  // notes:upload-attachment - Upload an attachment to a note
  ipcMain.handle(
    NotesChannels.invoke.UPLOAD_ATTACHMENT,
    createValidatedHandler(UploadAttachmentSchema, async (input) => {
      // Convert ArrayBuffer or number[] to Buffer
      const data = Array.isArray(input.data)
        ? Buffer.from(input.data)
        : Buffer.from(new Uint8Array(input.data))
      return saveAttachment(input.noteId, data, input.filename)
    })
  )

  // notes:list-attachments - List attachments for a note
  ipcMain.handle(
    NotesChannels.invoke.LIST_ATTACHMENTS,
    createStringHandler(async (noteId) => {
      return listNoteAttachments(noteId)
    })
  )

  // notes:delete-attachment - Delete an attachment
  ipcMain.handle(
    NotesChannels.invoke.DELETE_ATTACHMENT,
    createValidatedHandler(DeleteAttachmentSchema, async (input) => {
      try {
        await deleteAttachment(input.noteId, input.filename)
        return { success: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to delete attachment'
        return { success: false, error: message }
      }
    })
  )

  // =========================================================================
  // Folder Config IPC Handlers (T096.5)
  // =========================================================================

  // notes:get-folder-config - Get folder config
  ipcMain.handle(
    NotesChannels.invoke.GET_FOLDER_CONFIG,
    createStringHandler(async (folderPath) => {
      return readFolderConfig(folderPath)
    })
  )

  // notes:set-folder-config - Set folder config
  ipcMain.handle(
    NotesChannels.invoke.SET_FOLDER_CONFIG,
    createValidatedHandler(SetFolderConfigSchema, async (input) => {
      try {
        await writeFolderConfig(input.folderPath, input.config)
        return { success: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to set folder config'
        return { success: false, error: message }
      }
    })
  )

  // notes:get-folder-template - Get resolved folder template (with inheritance)
  ipcMain.handle(
    NotesChannels.invoke.GET_FOLDER_TEMPLATE,
    createStringHandler(async (folderPath) => {
      return getFolderTemplate(folderPath)
    })
  )

  // =========================================================================
  // T106: PDF Export Handler
  // =========================================================================

  ipcMain.handle(
    NotesChannels.invoke.EXPORT_PDF,
    createValidatedHandler(ExportNoteSchema, async (input) => {
      try {
        // Get the note
        const note = await getNoteById(input.noteId)
        if (!note) {
          return { success: false, error: 'Note not found' }
        }

        // Show save dialog
        const defaultFilename = `${sanitizeFilename(note.title)}.pdf`
        const result = await dialog.showSaveDialog({
          title: 'Export as PDF',
          defaultPath: defaultFilename,
          filters: [{ name: 'PDF Document', extensions: ['pdf'] }]
        })

        if (result.canceled || !result.filePath) {
          return { success: false, error: 'Export cancelled' }
        }

        // Generate HTML for the note
        const html = renderNoteAsHtml(
          {
            id: note.id,
            title: note.title,
            content: note.content,
            emoji: note.emoji,
            tags: note.tags,
            created: note.created,
            modified: note.modified
          },
          { includeMetadata: input.includeMetadata }
        )

        // Create a hidden browser window to render the HTML
        const win = new BrowserWindow({
          show: false,
          width: 800,
          height: 600,
          webPreferences: {
            javascript: false // Security: disable JS for export
          }
        })

        // Load the HTML content
        await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)

        // Wait a moment for content to render
        await new Promise((resolve) => setTimeout(resolve, 100))

        // Map page size to Electron format
        const pageSizeMap: Record<string, Electron.PrintToPDFOptions['pageSize']> = {
          A4: 'A4',
          Letter: 'Letter',
          Legal: 'Legal'
        }

        // Generate PDF
        const pdfData = await win.webContents.printToPDF({
          printBackground: true,
          pageSize: pageSizeMap[input.pageSize] || 'A4',
          margins: {
            top: 0.5,
            bottom: 0.5,
            left: 0.5,
            right: 0.5
          }
        })

        // Clean up the window
        win.destroy()

        // Write the PDF file
        await fs.writeFile(result.filePath, pdfData)

        return { success: true, path: result.filePath }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to export PDF'
        return { success: false, error: message }
      }
    })
  )

  // =========================================================================
  // T108: HTML Export Handler
  // =========================================================================

  ipcMain.handle(
    NotesChannels.invoke.EXPORT_HTML,
    createValidatedHandler(ExportNoteSchema, async (input) => {
      try {
        // Get the note
        const note = await getNoteById(input.noteId)
        if (!note) {
          return { success: false, error: 'Note not found' }
        }

        // Show save dialog
        const defaultFilename = `${sanitizeFilename(note.title)}.html`
        const result = await dialog.showSaveDialog({
          title: 'Export as HTML',
          defaultPath: defaultFilename,
          filters: [{ name: 'HTML Document', extensions: ['html', 'htm'] }]
        })

        if (result.canceled || !result.filePath) {
          return { success: false, error: 'Export cancelled' }
        }

        // Generate HTML for the note
        const html = renderNoteAsHtml(
          {
            id: note.id,
            title: note.title,
            content: note.content,
            emoji: note.emoji,
            tags: note.tags,
            created: note.created,
            modified: note.modified
          },
          { includeMetadata: input.includeMetadata }
        )

        // Write the HTML file
        await fs.writeFile(result.filePath, html, 'utf-8')

        return { success: true, path: result.filePath }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to export HTML'
        return { success: false, error: message }
      }
    })
  )

  // =========================================================================
  // T114: Version History IPC Handlers
  // =========================================================================

  // notes:get-versions - Get version history for a note
  ipcMain.handle(
    NotesChannels.invoke.GET_VERSIONS,
    createStringHandler((noteId) => {
      return getVersionHistory(noteId)
    })
  )

  // notes:get-version - Get a specific version with content
  ipcMain.handle(
    NotesChannels.invoke.GET_VERSION,
    createStringHandler((snapshotId) => {
      return getVersion(snapshotId)
    })
  )

  // notes:restore-version - Restore note from a previous version
  ipcMain.handle(
    NotesChannels.invoke.RESTORE_VERSION,
    createStringHandler(async (snapshotId) => {
      try {
        const note = await restoreVersion(snapshotId)
        return { success: true, note }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to restore version'
        return { success: false, note: null, error: message }
      }
    })
  )

  // notes:delete-version - Delete a specific version
  ipcMain.handle(
    NotesChannels.invoke.DELETE_VERSION,
    createStringHandler((snapshotId) => {
      try {
        const db = getIndexDatabase()
        deleteNoteSnapshot(db, snapshotId)
        return { success: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to delete version'
        return { success: false, error: message }
      }
    })
  )

  ipcMain.handle(
    NotesChannels.invoke.GET_POSITIONS,
    createValidatedHandler(NoteGetPositionsSchema, (input) => {
      try {
        const db = getDatabase()
        const positions = getNotesInFolder(db, input.folderPath)
        return { success: true, positions }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to get positions'
        return { success: false, positions: [], error: message }
      }
    })
  )

  ipcMain.handle(
    NotesChannels.invoke.GET_ALL_POSITIONS,
    createHandler(() => {
      try {
        const db = getDatabase()
        const positions = getAllNotePositions(db)
        const positionMap: Record<string, number> = {}
        for (const p of positions) {
          positionMap[p.path] = p.position
        }
        return { success: true, positions: positionMap }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to get all positions'
        return { success: false, positions: {}, error: message }
      }
    })
  )

  ipcMain.handle(
    NotesChannels.invoke.REORDER,
    createValidatedHandler(NoteReorderSchema, (input) => {
      try {
        const db = getDatabase()
        reorderNotesInFolder(db, input.folderPath, input.notePaths)
        return { success: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to reorder notes'
        return { success: false, error: message }
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
