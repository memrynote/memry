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
  NoteGetPositionsSchema,
  SetLocalOnlySchema
} from '@memry/contracts/notes-api'
import { PropertyTypes } from '@memry/contracts/property-types'
import { RenameFolderSchema } from '@memry/contracts/tasks-api'
import {
  createValidatedHandler,
  createHandler,
  createStringHandler,
  withErrorHandler
} from './validate'
import { getNoteSyncService } from '../sync/note-sync'
import { getCrdtProvider } from '../sync/crdt-provider'
import {
  createNote,
  getNoteById,
  getNoteByPath,
  getFileById,
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
  restoreVersion,
  // File import
  importFiles
} from '../vault/notes'
import { getAllSupportedExtensions } from '@memry/shared/file-types'
import { deleteNoteSnapshot } from '@main/database/queries/notes'
import { saveAttachment, deleteAttachment, listNoteAttachments } from '../vault/attachments'
import { fromMemryFileUrl } from '../lib/paths'
import { attachmentEvents } from '../sync/attachment-events'
import { readFolderConfig, writeFolderConfig, getFolderTemplate } from '../vault/folders'
import { renderNoteAsHtml, sanitizeFilename } from '../lib/export-utils'
import { SetFolderConfigSchema } from '@memry/contracts/templates-api'
import {
  getAllPropertyDefinitions,
  insertPropertyDefinition,
  updatePropertyDefinition,
  resolveNoteByTitle,
  updateNoteCache,
  getLocalOnlyCount,
  getNoteTags,
  getAllTagDefinitions
} from '@main/database/queries/notes'
import { getIndexDatabase, getDatabase } from '../database'
import {
  getNotesInFolder,
  reorderNotesInFolder,
  getAllNotePositions
} from '@main/database/queries/note-positions'

// ============================================================================
// Zod Schemas for Property Definitions (T017-T018)
// Note: T015-T016 (get/set properties) moved to properties-handlers.ts
// ============================================================================

const CreatePropertyDefinitionSchema = z.object({
  name: z.string().min(1),
  type: z.enum([
    PropertyTypes.TEXT,
    PropertyTypes.NUMBER,
    PropertyTypes.CHECKBOX,
    PropertyTypes.DATE,
    PropertyTypes.URL,
    PropertyTypes.STATUS,
    PropertyTypes.SELECT,
    PropertyTypes.MULTISELECT
  ]),
  options: z
    .array(z.object({ value: z.string(), color: z.string(), default: z.boolean().optional() }))
    .optional(),
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
      PropertyTypes.URL,
      PropertyTypes.STATUS,
      PropertyTypes.SELECT,
      PropertyTypes.MULTISELECT
    ])
    .optional(),
  options: z
    .array(z.object({ value: z.string(), color: z.string(), default: z.boolean().optional() }))
    .optional(),
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
    createValidatedHandler(
      NoteCreateSchema,
      withErrorHandler(async (input) => {
        const note = await createNote(input)
        getNoteSyncService()?.enqueueCreate(note.id)
        getCrdtProvider()
          .initForNote(note.id, { title: note.title }, note.tags)
          .catch(() => {})
        return { success: true, note }
      }, 'Failed to create note')
    )
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

  // notes:get-file - Get file metadata by ID (for non-markdown files)
  ipcMain.handle(
    NotesChannels.invoke.GET_FILE,
    createStringHandler(async (id) => {
      return getFileById(id)
    })
  )

  // notes:resolve-by-title - Resolve a WikiLink target by title
  // Returns note/file metadata for format-aware WikiLink handling
  ipcMain.handle(
    NotesChannels.invoke.RESOLVE_BY_TITLE,
    createStringHandler((title) => {
      const db = getIndexDatabase()
      const result = resolveNoteByTitle(db, title)
      if (!result) {
        return null
      }
      // Return the essential fields for WikiLink resolution
      return {
        id: result.id,
        path: result.path,
        title: result.title,
        fileType: result.fileType ?? 'markdown'
      }
    })
  )

  // notes:preview-by-title - Get hover preview data for a WikiLink target
  ipcMain.handle(
    NotesChannels.invoke.PREVIEW_BY_TITLE,
    createStringHandler((title) => {
      const indexDb = getIndexDatabase()
      const result = resolveNoteByTitle(indexDb, title)
      if (!result || result.fileType !== 'markdown') return null

      const tags = getNoteTags(indexDb, result.id)
      const dataDb = getDatabase()
      const definitions = getAllTagDefinitions(dataDb)
      const colorMap = new Map(definitions.map((d) => [d.name, d.color]))

      return {
        id: result.id,
        title: result.title,
        emoji: result.emoji ?? null,
        snippet: result.snippet ?? null,
        tags: tags.map((t) => ({ name: t, color: colorMap.get(t) ?? 'stone' })),
        createdAt: result.createdAt
      }
    })
  )

  // notes:update - Update note content/metadata
  ipcMain.handle(
    NotesChannels.invoke.UPDATE,
    createValidatedHandler(
      NoteUpdateSchema,
      withErrorHandler(async (input) => {
        const note = await updateNote(input)
        const hasMetadataChanges =
          input.title !== undefined ||
          input.tags !== undefined ||
          input.frontmatter !== undefined ||
          input.emoji !== undefined
        if (hasMetadataChanges) {
          getNoteSyncService()?.enqueueUpdate(input.id)
        }
        if (input.title) getCrdtProvider()?.updateMeta(input.id, { title: input.title })
        return { success: true, note }
      }, 'Failed to update note')
    )
  )

  // notes:rename - Rename a note
  ipcMain.handle(
    NotesChannels.invoke.RENAME,
    createValidatedHandler(
      NoteRenameSchema,
      withErrorHandler(async (input) => {
        const note = await renameNote(input.id, input.newTitle)
        getNoteSyncService()?.enqueueUpdate(input.id)
        getCrdtProvider()?.updateMeta(input.id, { title: input.newTitle })
        return { success: true, note }
      }, 'Failed to rename note')
    )
  )

  // notes:move - Move note to different folder
  ipcMain.handle(
    NotesChannels.invoke.MOVE,
    createValidatedHandler(
      NoteMoveSchema,
      withErrorHandler(async (input) => {
        const note = await moveNote(input.id, input.newFolder)
        getNoteSyncService()?.enqueueUpdate(input.id)
        return { success: true, note }
      }, 'Failed to move note')
    )
  )

  // notes:delete - Delete a note
  ipcMain.handle(
    NotesChannels.invoke.DELETE,
    createStringHandler(
      withErrorHandler(async (id) => {
        getNoteSyncService()?.enqueueDelete(id)
        await deleteNote(id)
        return { success: true }
      }, 'Failed to delete note')
    )
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
    createStringHandler(
      withErrorHandler(async (path) => {
        await createFolder(path)
        return { success: true }
      }, 'Failed to create folder')
    )
  )

  // notes:rename-folder - Rename a folder
  ipcMain.handle(
    NotesChannels.invoke.RENAME_FOLDER,
    createValidatedHandler(
      RenameFolderSchema,
      withErrorHandler(async (input) => {
        await renameFolder(input.oldPath, input.newPath)
        return { success: true }
      }, 'Failed to rename folder')
    )
  )

  // notes:delete-folder - Delete a folder and all its contents
  ipcMain.handle(
    NotesChannels.invoke.DELETE_FOLDER,
    createStringHandler(
      withErrorHandler(async (folderPath) => {
        await deleteFolder(folderPath)
        return { success: true }
      }, 'Failed to delete folder')
    )
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
  // T017-T018: Property Definitions IPC Handlers
  // Note: T015-T016 (get/set properties) moved to properties-handlers.ts
  // =========================================================================

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
    createValidatedHandler(
      CreatePropertyDefinitionSchema,
      withErrorHandler(async (input) => {
        const isSelectType =
          input.type === 'status' || input.type === 'select' || input.type === 'multiselect'

        if (isSelectType) {
          const { PropertyDefinitionsService } = await import('../vault/property-definitions')
          const service = PropertyDefinitionsService.get()
          await service.upsert({
            name: input.name,
            type: input.type,
            options: input.type !== 'status' ? input.options : undefined,
            defaultValue: input.defaultValue != null ? String(input.defaultValue) : undefined
          })
          return { success: true, definition: service.get(input.name) }
        }

        const db = getIndexDatabase()
        const definition = insertPropertyDefinition(db, {
          name: input.name,
          type: input.type,
          options: input.options ? JSON.stringify(input.options) : null,
          defaultValue: input.defaultValue ? JSON.stringify(input.defaultValue) : null,
          color: input.color ?? null
        })
        return { success: true, definition }
      }, 'Failed to create property definition')
    )
  )

  // notes:update-property-definition - Update a property definition
  ipcMain.handle(
    NotesChannels.invoke.UPDATE_PROPERTY_DEFINITION,
    createValidatedHandler(
      UpdatePropertyDefinitionSchema,
      withErrorHandler(async (input) => {
        const isSelectType =
          input.type === 'status' || input.type === 'select' || input.type === 'multiselect'

        if (isSelectType) {
          const { PropertyDefinitionsService } = await import('../vault/property-definitions')
          const service = PropertyDefinitionsService.get()
          const existing = service.get(input.name)
          if (!existing) return { success: false, definition: null, error: 'Definition not found' }

          await service.upsert({
            ...existing,
            name: input.name,
            type: input.type ?? existing.type,
            options: input.options ?? existing.options,
            defaultValue:
              input.defaultValue != null ? String(input.defaultValue) : existing.defaultValue
          })
          return { success: true, definition: service.get(input.name) }
        }

        const db = getIndexDatabase()
        const { name, ...updates } = input
        const definition = updatePropertyDefinition(db, name, {
          type: updates.type,
          options: updates.options ? JSON.stringify(updates.options) : undefined,
          defaultValue: updates.defaultValue ? JSON.stringify(updates.defaultValue) : undefined,
          color: updates.color
        })
        return { success: true, definition }
      }, 'Failed to update property definition')
    )
  )

  // =========================================================================
  // Property Option Mutations (select/multiselect/status)
  // =========================================================================

  ipcMain.handle(
    NotesChannels.invoke.ENSURE_PROPERTY_DEFINITION,
    createValidatedHandler(
      z.object({
        name: z.string().min(1),
        type: z.enum(['status', 'select', 'multiselect'])
      }),
      async (input) => {
        const { PropertyDefinitionsService, DEFAULT_STATUS_DEFINITION } =
          await import('../vault/property-definitions')
        const service = PropertyDefinitionsService.get()
        if (service.get(input.name)) return { success: true }

        if (input.type === 'status') {
          await service.upsert({ ...DEFAULT_STATUS_DEFINITION, name: input.name })
        } else {
          await service.upsert({ name: input.name, type: input.type, options: [] })
        }
        return { success: true }
      }
    )
  )

  ipcMain.handle(
    NotesChannels.invoke.ADD_PROPERTY_OPTION,
    createValidatedHandler(
      z.object({
        propertyName: z.string().min(1),
        option: z.object({ value: z.string().min(1), color: z.string().min(1) })
      }),
      async (input) => {
        const { PropertyDefinitionsService } = await import('../vault/property-definitions')
        const service = PropertyDefinitionsService.get()
        const existing = service.get(input.propertyName)
        if (!existing) {
          await service.upsert({
            name: input.propertyName,
            type: 'select',
            options: [input.option]
          })
        } else {
          await service.addOption(input.propertyName, input.option)
        }
        return { success: true }
      }
    )
  )

  ipcMain.handle(
    NotesChannels.invoke.ADD_STATUS_OPTION,
    createValidatedHandler(
      z.object({
        propertyName: z.string().min(1),
        categoryKey: z.enum(['todo', 'in_progress', 'done']),
        option: z.object({ value: z.string().min(1), color: z.string().min(1) })
      }),
      async (input) => {
        const { PropertyDefinitionsService, DEFAULT_STATUS_DEFINITION } =
          await import('../vault/property-definitions')
        const service = PropertyDefinitionsService.get()
        const existing = service.get(input.propertyName)
        if (!existing) {
          const def = {
            ...DEFAULT_STATUS_DEFINITION,
            name: input.propertyName
          }
          await service.upsert(def)
          await service.addStatusOption(input.propertyName, input.categoryKey, input.option)
        } else {
          await service.addStatusOption(input.propertyName, input.categoryKey, input.option)
        }
        return { success: true }
      }
    )
  )

  ipcMain.handle(
    NotesChannels.invoke.REMOVE_PROPERTY_OPTION,
    createValidatedHandler(
      z.object({
        propertyName: z.string().min(1),
        optionValue: z.string().min(1)
      }),
      async (input) => {
        const { PropertyDefinitionsService } = await import('../vault/property-definitions')
        const service = PropertyDefinitionsService.get()
        await service.removeOption(input.propertyName, input.optionValue)
        return { success: true }
      }
    )
  )

  ipcMain.handle(
    NotesChannels.invoke.RENAME_PROPERTY_OPTION,
    createValidatedHandler(
      z.object({
        propertyName: z.string().min(1),
        oldValue: z.string().min(1),
        newValue: z.string().min(1)
      }),
      async (input) => {
        const { PropertyDefinitionsService } = await import('../vault/property-definitions')
        const service = PropertyDefinitionsService.get()
        await service.renameOption(input.propertyName, input.oldValue, input.newValue)
        return { success: true }
      }
    )
  )

  ipcMain.handle(
    NotesChannels.invoke.UPDATE_OPTION_COLOR,
    createValidatedHandler(
      z.object({
        propertyName: z.string().min(1),
        optionValue: z.string().min(1),
        newColor: z.string().min(1)
      }),
      async (input) => {
        const { PropertyDefinitionsService } = await import('../vault/property-definitions')
        const service = PropertyDefinitionsService.get()
        await service.updateOptionColor(input.propertyName, input.optionValue, input.newColor)
        return { success: true }
      }
    )
  )

  ipcMain.handle(
    NotesChannels.invoke.DELETE_PROPERTY_DEFINITION,
    createValidatedHandler(z.object({ name: z.string().min(1) }), async (input) => {
      const { PropertyDefinitionsService } = await import('../vault/property-definitions')
      const service = PropertyDefinitionsService.get()
      await service.remove(input.name)
      return { success: true }
    })
  )

  // =========================================================================
  // T070: Attachment IPC Handlers
  // =========================================================================

  // notes:upload-attachment - Upload an attachment to a note
  ipcMain.handle(
    NotesChannels.invoke.UPLOAD_ATTACHMENT,
    createValidatedHandler(UploadAttachmentSchema, async (input) => {
      const data = Array.isArray(input.data)
        ? Buffer.from(input.data)
        : Buffer.from(new Uint8Array(input.data))
      const result = await saveAttachment(input.noteId, data, input.filename)
      if (result.success && result.path) {
        try {
          const diskPath = fromMemryFileUrl(result.path)
          attachmentEvents.emitSaved({ noteId: input.noteId, diskPath })
        } catch {
          // Don't block local save if sync event fails
        }
      }
      return result
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
    createValidatedHandler(
      DeleteAttachmentSchema,
      withErrorHandler(async (input) => {
        await deleteAttachment(input.noteId, input.filename)
        return { success: true }
      }, 'Failed to delete attachment')
    )
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
    createValidatedHandler(
      SetFolderConfigSchema,
      withErrorHandler(async (input) => {
        await writeFolderConfig(input.folderPath, input.config)
        return { success: true }
      }, 'Failed to set folder config')
    )
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
    createValidatedHandler(
      ExportNoteSchema,
      withErrorHandler(async (input) => {
        const note = await getNoteById(input.noteId)
        if (!note) {
          return { success: false, error: 'Note not found' }
        }

        const defaultFilename = `${sanitizeFilename(note.title)}.pdf`
        const result = await dialog.showSaveDialog({
          title: 'Export as PDF',
          defaultPath: defaultFilename,
          filters: [{ name: 'PDF Document', extensions: ['pdf'] }]
        })

        if (result.canceled || !result.filePath) {
          return { success: false, error: 'Export cancelled' }
        }

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

        const win = new BrowserWindow({
          show: false,
          width: 800,
          height: 600,
          webPreferences: {
            javascript: false
          }
        })

        await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
        await new Promise((resolve) => setTimeout(resolve, 100))

        const pageSizeMap: Record<string, Electron.PrintToPDFOptions['pageSize']> = {
          A4: 'A4',
          Letter: 'Letter',
          Legal: 'Legal'
        }

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

        win.destroy()
        await fs.writeFile(result.filePath, pdfData)

        return { success: true, path: result.filePath }
      }, 'Failed to export PDF')
    )
  )

  // =========================================================================
  // T108: HTML Export Handler
  // =========================================================================

  ipcMain.handle(
    NotesChannels.invoke.EXPORT_HTML,
    createValidatedHandler(
      ExportNoteSchema,
      withErrorHandler(async (input) => {
        const note = await getNoteById(input.noteId)
        if (!note) {
          return { success: false, error: 'Note not found' }
        }

        const defaultFilename = `${sanitizeFilename(note.title)}.html`
        const result = await dialog.showSaveDialog({
          title: 'Export as HTML',
          defaultPath: defaultFilename,
          filters: [{ name: 'HTML Document', extensions: ['html', 'htm'] }]
        })

        if (result.canceled || !result.filePath) {
          return { success: false, error: 'Export cancelled' }
        }

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

        await fs.writeFile(result.filePath, html, 'utf-8')

        return { success: true, path: result.filePath }
      }, 'Failed to export HTML')
    )
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
    createStringHandler(
      withErrorHandler(async (snapshotId) => {
        const note = await restoreVersion(snapshotId)
        return { success: true, note }
      }, 'Failed to restore version')
    )
  )

  // notes:delete-version - Delete a specific version
  ipcMain.handle(
    NotesChannels.invoke.DELETE_VERSION,
    createStringHandler(
      withErrorHandler((snapshotId) => {
        const db = getIndexDatabase()
        deleteNoteSnapshot(db, snapshotId)
        return { success: true }
      }, 'Failed to delete version')
    )
  )

  ipcMain.handle(
    NotesChannels.invoke.GET_POSITIONS,
    createValidatedHandler(
      NoteGetPositionsSchema,
      withErrorHandler((input) => {
        const db = getDatabase()
        const positions = getNotesInFolder(db, input.folderPath)
        return { success: true, positions }
      }, 'Failed to get positions')
    )
  )

  ipcMain.handle(
    NotesChannels.invoke.GET_ALL_POSITIONS,
    createHandler(
      withErrorHandler(() => {
        const db = getDatabase()
        const positions = getAllNotePositions(db)
        const positionMap: Record<string, number> = {}
        for (const p of positions) {
          positionMap[p.path] = p.position
        }
        return { success: true, positions: positionMap }
      }, 'Failed to get all positions')
    )
  )

  ipcMain.handle(
    NotesChannels.invoke.REORDER,
    createValidatedHandler(
      NoteReorderSchema,
      withErrorHandler((input) => {
        const db = getDatabase()
        reorderNotesInFolder(db, input.folderPath, input.notePaths)
        return { success: true }
      }, 'Failed to reorder notes')
    )
  )

  // notes:import-files - Import files from external paths into the vault
  ipcMain.handle(
    NotesChannels.invoke.IMPORT_FILES,
    createValidatedHandler(
      z.object({
        sourcePaths: z.array(z.string()),
        targetFolder: z.string().optional()
      }),
      withErrorHandler(async (input) => {
        const result = await importFiles(input)
        for (const file of result.importedFiles) {
          if (file.fileType !== 'markdown') {
            attachmentEvents.emitSaved({ noteId: 'vault-import', diskPath: file.destPath })
          }
        }
        return result
      }, 'Failed to import files')
    )
  )

  // notes:show-import-dialog - Open a file dialog to select files for import
  ipcMain.handle(
    NotesChannels.invoke.SHOW_IMPORT_DIALOG,
    createHandler(async () => {
      const extensions = getAllSupportedExtensions()
      const result = await dialog.showOpenDialog({
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: 'Supported Files', extensions },
          { name: 'All Files', extensions: ['*'] }
        ]
      })

      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true, filePaths: [] }
      }

      return { canceled: false, filePaths: result.filePaths }
    })
  )

  // notes:set-local-only — Toggle local-only flag (excludes from sync)
  ipcMain.handle(
    NotesChannels.invoke.SET_LOCAL_ONLY,
    createValidatedHandler(
      SetLocalOnlySchema,
      withErrorHandler(async (input) => {
        const note = await updateNote({ id: input.id, frontmatter: { localOnly: input.localOnly } })
        const indexDb = getIndexDatabase()
        updateNoteCache(indexDb, input.id, { localOnly: input.localOnly })
        const syncService = getNoteSyncService()
        if (input.localOnly) {
          syncService?.removeQueueItems(input.id)
        } else {
          syncService?.enqueueUpdate(input.id)
        }
        return { success: true, note }
      }, 'Failed to set local-only')
    )
  )

  // notes:get-local-only-count — Count of local-only notes
  ipcMain.handle(
    NotesChannels.invoke.GET_LOCAL_ONLY_COUNT,
    createHandler(() => {
      const indexDb = getIndexDatabase()
      return { count: getLocalOnlyCount(indexDb) }
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
