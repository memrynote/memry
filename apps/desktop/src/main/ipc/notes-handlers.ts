/**
 * Notes IPC handlers.
 *
 * Property definition and export handlers are split into focused modules:
 * - property-definition-handlers.ts — property definition CRUD
 * - export-handlers.ts — PDF/HTML export with shared logic
 *
 * @module ipc/notes-handlers
 */

import { ipcMain, dialog } from 'electron'
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
import { ImportFilesSchema, UploadAttachmentSchema, DeleteAttachmentSchema } from './notes-schemas'
import { RenameFolderSchema } from '@memry/contracts/tasks-api'
import { createValidatedHandler, createHandler, createStringHandler } from './validate'
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
  getVersionHistory,
  getVersion,
  restoreVersion,
  importFiles
} from '../vault/notes'
import { getAllSupportedExtensions } from '@memry/shared/file-types'
import { deleteNoteSnapshot } from '@main/database/queries/notes'
import { saveAttachment, deleteAttachment, listNoteAttachments } from '../vault/attachments'
import { fromMemryFileUrl } from '../lib/paths'
import { attachmentEvents } from '../sync/attachment-events'
import { readFolderConfig, writeFolderConfig, getFolderTemplate } from '../vault/folders'
import { SetFolderConfigSchema } from '@memry/contracts/templates-api'
import {
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
import { extractError } from './handler-utils'
import { registerPropertyDefinitionHandlers } from './property-definition-handlers'
import { registerExportHandlers } from './export-handlers'

export function registerNotesHandlers(): void {
  // =========================================================================
  // Note CRUD
  // =========================================================================

  ipcMain.handle(
    NotesChannels.invoke.CREATE,
    createValidatedHandler(NoteCreateSchema, async (input) => {
      try {
        const note = await createNote(input)
        getNoteSyncService()?.enqueueCreate(note.id)
        getCrdtProvider()
          .initForNote(note.id, { title: note.title }, note.tags)
          .catch(() => {})
        return { success: true, note }
      } catch (error) {
        return { success: false, note: null, error: extractError(error, 'Failed to create note') }
      }
    })
  )

  ipcMain.handle(
    NotesChannels.invoke.GET,
    createStringHandler(async (id) => getNoteById(id))
  )

  ipcMain.handle(
    NotesChannels.invoke.GET_BY_PATH,
    createStringHandler(async (path) => getNoteByPath(path))
  )

  ipcMain.handle(
    NotesChannels.invoke.GET_FILE,
    createStringHandler(async (id) => getFileById(id))
  )

  ipcMain.handle(
    NotesChannels.invoke.RESOLVE_BY_TITLE,
    createStringHandler((title) => {
      const db = getIndexDatabase()
      const result = resolveNoteByTitle(db, title)
      if (!result) return null
      return {
        id: result.id,
        path: result.path,
        title: result.title,
        fileType: result.fileType ?? 'markdown'
      }
    })
  )

  ipcMain.handle(
    NotesChannels.invoke.PREVIEW_BY_TITLE,
    createStringHandler((title) => {
      const indexDb = getIndexDatabase()
      const result = resolveNoteByTitle(indexDb, title)
      if (!result || result.fileType !== 'markdown') return null

      const tags = getNoteTags(indexDb, result.id)
      const dataDb = getDatabase()
      const definitions = getAllTagDefinitions(dataDb)
      const colorMap = new Map(
        definitions.map((d: { name: string; color: string }) => [d.name, d.color])
      )

      return {
        id: result.id,
        title: result.title,
        emoji: result.emoji ?? null,
        snippet: result.snippet ?? null,
        tags: tags.map((t: string) => ({ name: t, color: colorMap.get(t) ?? 'stone' })),
        createdAt: result.createdAt
      }
    })
  )

  ipcMain.handle(
    NotesChannels.invoke.UPDATE,
    createValidatedHandler(NoteUpdateSchema, async (input) => {
      try {
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
      } catch (error) {
        return { success: false, note: null, error: extractError(error, 'Failed to update note') }
      }
    })
  )

  ipcMain.handle(
    NotesChannels.invoke.RENAME,
    createValidatedHandler(NoteRenameSchema, async (input) => {
      try {
        const note = await renameNote(input.id, input.newTitle)
        getNoteSyncService()?.enqueueUpdate(input.id)
        getCrdtProvider()?.updateMeta(input.id, { title: input.newTitle })
        return { success: true, note }
      } catch (error) {
        return { success: false, note: null, error: extractError(error, 'Failed to rename note') }
      }
    })
  )

  ipcMain.handle(
    NotesChannels.invoke.MOVE,
    createValidatedHandler(NoteMoveSchema, async (input) => {
      try {
        const note = await moveNote(input.id, input.newFolder)
        getNoteSyncService()?.enqueueUpdate(input.id)
        return { success: true, note }
      } catch (error) {
        return { success: false, note: null, error: extractError(error, 'Failed to move note') }
      }
    })
  )

  ipcMain.handle(
    NotesChannels.invoke.DELETE,
    createStringHandler(async (id) => {
      try {
        getNoteSyncService()?.enqueueDelete(id)
        await deleteNote(id)
        return { success: true }
      } catch (error) {
        return { success: false, error: extractError(error, 'Failed to delete note') }
      }
    })
  )

  // =========================================================================
  // Note Queries
  // =========================================================================

  ipcMain.handle(
    NotesChannels.invoke.LIST,
    createValidatedHandler(NoteListSchema, async (input) => listNotes(input))
  )

  ipcMain.handle(
    NotesChannels.invoke.GET_TAGS,
    createHandler(() => getTagsWithCounts())
  )

  ipcMain.handle(
    NotesChannels.invoke.GET_LINKS,
    createStringHandler(async (id) => getNoteLinks(id))
  )

  ipcMain.handle(
    NotesChannels.invoke.EXISTS,
    createStringHandler(async (titleOrPath) => noteExists(titleOrPath))
  )

  // =========================================================================
  // Folders
  // =========================================================================

  ipcMain.handle(
    NotesChannels.invoke.GET_FOLDERS,
    createHandler(async () => getFolders())
  )

  ipcMain.handle(
    NotesChannels.invoke.CREATE_FOLDER,
    createStringHandler(async (path) => {
      try {
        await createFolder(path)
        return { success: true }
      } catch (error) {
        return { success: false, error: extractError(error, 'Failed to create folder') }
      }
    })
  )

  ipcMain.handle(
    NotesChannels.invoke.RENAME_FOLDER,
    createValidatedHandler(RenameFolderSchema, async (input) => {
      try {
        await renameFolder(input.oldPath, input.newPath)
        return { success: true }
      } catch (error) {
        return { success: false, error: extractError(error, 'Failed to rename folder') }
      }
    })
  )

  ipcMain.handle(
    NotesChannels.invoke.DELETE_FOLDER,
    createStringHandler(async (folderPath) => {
      try {
        await deleteFolder(folderPath)
        return { success: true }
      } catch (error) {
        return { success: false, error: extractError(error, 'Failed to delete folder') }
      }
    })
  )

  // =========================================================================
  // External Actions
  // =========================================================================

  ipcMain.handle(
    NotesChannels.invoke.OPEN_EXTERNAL,
    createStringHandler(async (id) => openExternal(id))
  )

  ipcMain.handle(
    NotesChannels.invoke.REVEAL_IN_FINDER,
    createStringHandler(async (id) => revealInFinder(id))
  )

  // =========================================================================
  // Attachments
  // =========================================================================

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

  ipcMain.handle(
    NotesChannels.invoke.LIST_ATTACHMENTS,
    createStringHandler(async (noteId) => listNoteAttachments(noteId))
  )

  ipcMain.handle(
    NotesChannels.invoke.DELETE_ATTACHMENT,
    createValidatedHandler(DeleteAttachmentSchema, async (input) => {
      try {
        await deleteAttachment(input.noteId, input.filename)
        return { success: true }
      } catch (error) {
        return { success: false, error: extractError(error, 'Failed to delete attachment') }
      }
    })
  )

  // =========================================================================
  // Folder Config
  // =========================================================================

  ipcMain.handle(
    NotesChannels.invoke.GET_FOLDER_CONFIG,
    createStringHandler(async (folderPath) => readFolderConfig(folderPath))
  )

  ipcMain.handle(
    NotesChannels.invoke.SET_FOLDER_CONFIG,
    createValidatedHandler(SetFolderConfigSchema, async (input) => {
      try {
        await writeFolderConfig(input.folderPath, input.config)
        return { success: true }
      } catch (error) {
        return { success: false, error: extractError(error, 'Failed to set folder config') }
      }
    })
  )

  ipcMain.handle(
    NotesChannels.invoke.GET_FOLDER_TEMPLATE,
    createStringHandler(async (folderPath) => getFolderTemplate(folderPath))
  )

  // =========================================================================
  // Version History
  // =========================================================================

  ipcMain.handle(
    NotesChannels.invoke.GET_VERSIONS,
    createStringHandler((noteId) => getVersionHistory(noteId))
  )

  ipcMain.handle(
    NotesChannels.invoke.GET_VERSION,
    createStringHandler((snapshotId) => getVersion(snapshotId))
  )

  ipcMain.handle(
    NotesChannels.invoke.RESTORE_VERSION,
    createStringHandler(async (snapshotId) => {
      try {
        const note = await restoreVersion(snapshotId)
        return { success: true, note }
      } catch (error) {
        return {
          success: false,
          note: null,
          error: extractError(error, 'Failed to restore version')
        }
      }
    })
  )

  ipcMain.handle(
    NotesChannels.invoke.DELETE_VERSION,
    createStringHandler((snapshotId) => {
      try {
        const db = getIndexDatabase()
        deleteNoteSnapshot(db, snapshotId)
        return { success: true }
      } catch (error) {
        return { success: false, error: extractError(error, 'Failed to delete version') }
      }
    })
  )

  // =========================================================================
  // Note Positioning
  // =========================================================================

  ipcMain.handle(
    NotesChannels.invoke.GET_POSITIONS,
    createValidatedHandler(NoteGetPositionsSchema, (input) => {
      try {
        const db = getDatabase()
        const positions = getNotesInFolder(db, input.folderPath)
        return { success: true, positions }
      } catch (error) {
        return {
          success: false,
          positions: [],
          error: extractError(error, 'Failed to get positions')
        }
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
        return {
          success: false,
          positions: {},
          error: extractError(error, 'Failed to get all positions')
        }
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
        return { success: false, error: extractError(error, 'Failed to reorder notes') }
      }
    })
  )

  // =========================================================================
  // Import
  // =========================================================================

  ipcMain.handle(
    NotesChannels.invoke.IMPORT_FILES,
    createValidatedHandler(ImportFilesSchema, async (input) => {
      try {
        const result = await importFiles(input)
        for (const file of result.importedFiles) {
          if (file.fileType !== 'markdown') {
            attachmentEvents.emitSaved({ noteId: 'vault-import', diskPath: file.destPath })
          }
        }
        return result
      } catch (error) {
        return {
          success: false,
          imported: 0,
          failed: 0,
          errors: [extractError(error, 'Failed to import files')],
          importedFiles: []
        }
      }
    })
  )

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

  // =========================================================================
  // Local-Only
  // =========================================================================

  ipcMain.handle(
    NotesChannels.invoke.SET_LOCAL_ONLY,
    createValidatedHandler(SetLocalOnlySchema, async (input) => {
      try {
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
      } catch (error) {
        return {
          success: false,
          note: null,
          error: extractError(error, 'Failed to set local-only')
        }
      }
    })
  )

  ipcMain.handle(
    NotesChannels.invoke.GET_LOCAL_ONLY_COUNT,
    createHandler(() => {
      const indexDb = getIndexDatabase()
      return { count: getLocalOnlyCount(indexDb) }
    })
  )

  // Register sub-module handlers
  registerPropertyDefinitionHandlers()
  registerExportHandlers()
}

export function unregisterNotesHandlers(): void {
  Object.values(NotesChannels.invoke).forEach((channel) => {
    ipcMain.removeHandler(channel)
  })
}
