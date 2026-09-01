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
  SetLocalOnlySchema,
  ApplyTemplateSchema,
  LargeFileReadLinesSchema,
  LargeFileSearchSchema,
  AttachmentActionSchema,
  AttachmentRenameSchema
} from '@memry/contracts/notes-api'
import {
  resolveAttachment,
  revealAttachmentInFinder,
  openAttachmentExternal
} from '../vault/attachment-actions'
import { renameAttachment } from '../vault/attachment-rename'
import {
  openLargeFileSession,
  readLargeFileLines,
  searchLargeFileSession,
  closeLargeFileSession,
  closeAllLargeFileSessions
} from '../vault/large-file-session'
import { PropertyTypes } from '@memry/contracts/property-types'
import { RenameFolderSchema } from '@memry/contracts/tasks-api'
import {
  createValidatedHandler,
  createHandler,
  createStringHandler,
  withErrorHandler
} from './validate'
import { registerCommand } from './lib/register-command'
import type { Note } from '../vault/notes'
import {
  getNoteById,
  getNoteByPath,
  getFileById,
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
import {
  createNoteCommand,
  updateNoteCommand,
  renameNoteCommand,
  moveNoteCommand,
  deleteNoteCommand,
  setNoteLocalOnlyCommand
} from '../notes/domain'
import { applyTemplateToNote } from '../notes/apply-template'
import { getAllSupportedExtensions } from '@memry/shared/file-types'
import { saveAttachment, deleteAttachment, listNoteAttachments } from '../vault/attachments'
import { getStatus as getVaultStatus } from '../vault/index'
import { inlineExportImages } from '../lib/export-image-inliner'
import { readFolderConfig, writeFolderConfig, getFolderTemplate } from '../vault/folders'
import {
  syncFolderConfigSet,
  syncFolderConfigRename,
  syncFolderConfigDelete
} from '../notes/folder-config-effects'
import { renderNoteAsHtml, sanitizeFilename } from '../lib/export-utils'
import { getMainI18n } from '../lib/main-i18n'
import { SetFolderConfigSchema } from '@memry/contracts/templates-api'
import {
  deleteNoteSnapshot,
  resolveNoteByTitle,
  resolveNotesByTitles,
  getNoteTags,
  getAllTagDefinitions
} from '../notes/store'
import { getIndexDatabase, getDatabase } from '../database'
import { resolveWikiTarget } from '@memry/shared/wiki-target'
import { countLocalOnlyNoteMetadata, listPropertyDefinitions } from '@memry/storage-data'
import { getNotesInFolder, reorderNotesInFolder, getAllNotePositions } from '../notes/store'
import { emitNoteAttachmentSaved } from '../notes/runtime-effects'
import {
  createPropertyDefinitionRecord,
  deletePropertyDefinitionRecord,
  updatePropertyDefinitionRecord
} from '../vault/property-definition-store'
import { trackMainEvent } from '../telemetry/track'
import { trackMainError } from '../telemetry/diagnostics'
import { shouldEmitThrottled } from '../telemetry/throttle'
import { createLogger } from '../lib/logger'

const logger = createLogger('NotesHandlers')

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

function stringifyDefaultValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  if (typeof value === 'symbol') return value.description ?? value.toString()
  if (value instanceof Date) return value.toISOString()
  return JSON.stringify(value) ?? ''
}

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
  pageSize: z.enum(['A4', 'Letter', 'Legal']).default('A4'),
  // Headless export target — when provided, skip the save dialog (Agent MCP).
  outputPath: z.string().min(1).optional()
})

/**
 * Render a note for export with its images carried inside the document.
 *
 * Both export paths go through here so the two stay in step: the PDF path has
 * no base URL to resolve a relative `<img src>` against, and an exported
 * `.html` only kept its images while it sat next to the attachments (#1935).
 */
async function renderNoteForExport(note: Note, includeMetadata: boolean): Promise<string> {
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
    { includeMetadata }
  )
  return inlineExportImages(html, { notePath: note.path, vaultPath: getVaultStatus().path })
}

/**
 * Register all note-related IPC handlers.
 * Call this once during app initialization.
 */
export function registerNotesHandlers(): void {
  // notes:create - Create a new note
  registerCommand(
    NotesChannels.invoke.CREATE,
    NoteCreateSchema,
    async (input) => {
      const note = await createNoteCommand(input)
      trackMainEvent('note_created', {
        surface: 'notes',
        action: 'created',
        objectType: 'note',
        result: 'success'
      })
      return { success: true as const, note }
    },
    'errors:note.createFailed'
  )

  // notes:get - Get a note by ID
  ipcMain.handle(
    NotesChannels.invoke.GET,
    createStringHandler(async (id) => {
      const note = await getNoteById(id)
      if (note) {
        trackMainEvent('note_opened', {
          surface: 'notes',
          action: 'opened',
          objectType: 'note',
          result: 'success'
        })
      }
      return note
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

  // notes:resolve-titles - Resolve a batch of WikiLink titles in one call.
  // An editor mount dedupes its document's wiki targets and asks once, so
  // broken-link detection costs one IPC round trip, not one per link.
  ipcMain.handle(
    NotesChannels.invoke.RESOLVE_TITLES,
    createValidatedHandler(z.array(z.string()), (titles) => {
      const db = getIndexDatabase()
      const resolved = resolveNotesByTitles(db, titles)
      return Object.fromEntries(resolved)
    })
  )

  // notes:resolve-wiki-target - Resolve a WikiLink target, heading half and all
  // `resolveByTitle` is heading-blind by contract, so `[[Meeting#Decisions]]`
  // misses it; this reads the note half first and falls back to the raw string,
  // which is what an agent following a link needs (#1557).
  ipcMain.handle(
    NotesChannels.invoke.RESOLVE_WIKI_TARGET,
    createStringHandler(async (target) => {
      const db = getIndexDatabase()
      const resolved = await resolveWikiTarget(target, (title) => resolveNoteByTitle(db, title))
      if (!resolved) return null
      return {
        id: resolved.match.id,
        path: resolved.match.path,
        title: resolved.match.title,
        fileType: resolved.match.fileType ?? 'markdown',
        heading: resolved.heading
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
  registerCommand(
    NotesChannels.invoke.UPDATE,
    NoteUpdateSchema,
    async (input) => {
      const note = await updateNoteCommand(input)
      if (shouldEmitThrottled(`note_updated:${note.id}`)) {
        trackMainEvent('note_updated', {
          surface: 'notes',
          action: 'updated',
          objectType: 'note',
          result: 'success'
        })
      }
      return { success: true as const, note }
    },
    'errors:note.updateFailed'
  )

  // notes:apply-template - Apply a template to an existing note
  registerCommand(
    NotesChannels.invoke.APPLY_TEMPLATE,
    ApplyTemplateSchema,
    async (input) => {
      const note = await applyTemplateToNote(input)
      trackMainEvent('note_updated', {
        surface: 'notes',
        action: 'template_applied',
        objectType: 'note',
        result: 'success'
      })
      return { success: true as const, note }
    },
    'errors:note.applyTemplateFailed'
  )

  // notes:rename - Rename a note
  registerCommand(
    NotesChannels.invoke.RENAME,
    NoteRenameSchema,
    async (input) => {
      const note = await renameNoteCommand(input.id, input.newTitle)
      return { success: true as const, note }
    },
    'errors:note.renameFailed'
  )

  // notes:move - Move note to different folder
  registerCommand(
    NotesChannels.invoke.MOVE,
    NoteMoveSchema,
    async (input) => {
      const note = await moveNoteCommand(input.id, input.newFolder)
      return { success: true as const, note }
    },
    'errors:note.moveFailed'
  )

  // notes:delete - Delete a note
  ipcMain.handle(
    NotesChannels.invoke.DELETE,
    createStringHandler(
      withErrorHandler(async (id) => {
        await deleteNoteCommand(id)
        trackMainEvent('note_deleted', {
          surface: 'notes',
          action: 'deleted',
          objectType: 'note',
          result: 'success'
        })
        return { success: true }
      }, 'errors:note.deleteFailed')
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
      }, 'errors:folder.createFailed')
    )
  )

  // notes:rename-folder - Rename a folder
  registerCommand(
    NotesChannels.invoke.RENAME_FOLDER,
    RenameFolderSchema,
    async (input) => {
      await renameFolder(input.oldPath, input.newPath)
      syncFolderConfigRename(input.oldPath, input.newPath)
      return { success: true as const }
    },
    'errors:folder.renameFailed'
  )

  // notes:delete-folder - Delete a folder and all its contents
  ipcMain.handle(
    NotesChannels.invoke.DELETE_FOLDER,
    createStringHandler(
      withErrorHandler(async (folderPath) => {
        await deleteFolder(folderPath)
        syncFolderConfigDelete(folderPath)
        return { success: true }
      }, 'errors:folder.deleteFailed')
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
      revealInFinder(id)
    })
  )

  // notes:attachment-resolve - Resolve an attachment block url to disk path + stored name
  ipcMain.handle(
    NotesChannels.invoke.ATTACHMENT_RESOLVE,
    createValidatedHandler(AttachmentActionSchema, (input) =>
      resolveAttachment(input.noteId, input.url)
    )
  )

  // notes:attachment-reveal-in-finder - Reveal an attachment in the OS file manager
  ipcMain.handle(
    NotesChannels.invoke.ATTACHMENT_REVEAL_IN_FINDER,
    createValidatedHandler(AttachmentActionSchema, (input) => {
      revealAttachmentInFinder(input.noteId, input.url)
    })
  )

  // notes:attachment-open-external - Open an attachment with the OS default app
  ipcMain.handle(
    NotesChannels.invoke.ATTACHMENT_OPEN_EXTERNAL,
    createValidatedHandler(AttachmentActionSchema, async (input) => {
      await openAttachmentExternal(input.noteId, input.url)
    })
  )

  // notes:attachment-rename - Rename an attachment on disk (#1714). The block's
  // url/name are rewritten by the caller; the body change is what reaches peers.
  ipcMain.handle(
    NotesChannels.invoke.ATTACHMENT_RENAME,
    createValidatedHandler(AttachmentRenameSchema, (input) =>
      renameAttachment(input.noteId, input.url, input.newName)
    )
  )

  // =========================================================================
  // T017-T018: Property Definitions IPC Handlers
  // Note: T015-T016 (get/set properties) moved to properties-handlers.ts
  // =========================================================================

  // T017: notes:get-property-definitions - Get all property definitions
  ipcMain.handle(
    NotesChannels.invoke.GET_PROPERTY_DEFINITIONS,
    createHandler(() => {
      const db = getDatabase()
      return listPropertyDefinitions(db)
    })
  )

  // T018: notes:create-property-definition - Create a new property definition
  registerCommand(
    NotesChannels.invoke.CREATE_PROPERTY_DEFINITION,
    CreatePropertyDefinitionSchema,
    async (input) => {
      const isSelectType =
        input.type === 'status' || input.type === 'select' || input.type === 'multiselect'

      if (isSelectType) {
        const { PropertyDefinitionsService } = await import('../vault/property-definitions')
        const service = PropertyDefinitionsService.get()
        await service.upsert({
          name: input.name,
          type: input.type,
          options: input.type !== 'status' ? input.options : undefined,
          defaultValue:
            input.defaultValue != null ? stringifyDefaultValue(input.defaultValue) : undefined
        })
        return { success: true as const, definition: service.get(input.name) }
      }

      const definition = createPropertyDefinitionRecord({
        name: input.name,
        type: input.type,
        options: input.options ? JSON.stringify(input.options) : null,
        defaultValue: input.defaultValue ? JSON.stringify(input.defaultValue) : null,
        color: input.color ?? null
      })
      return { success: true as const, definition }
    },
    'errors:property.createDefinitionFailed'
  )

  // notes:update-property-definition - Update a property definition
  registerCommand(
    NotesChannels.invoke.UPDATE_PROPERTY_DEFINITION,
    UpdatePropertyDefinitionSchema,
    async (input) => {
      const isSelectType =
        input.type === 'status' || input.type === 'select' || input.type === 'multiselect'

      if (isSelectType) {
        const { PropertyDefinitionsService } = await import('../vault/property-definitions')
        const service = PropertyDefinitionsService.get()
        const existing = service.get(input.name)
        if (!existing)
          return {
            success: false as const,
            definition: null,
            error: getMainI18n().t('system:error.definitionNotFound')
          }

        await service.upsert({
          ...existing,
          name: input.name,
          type: input.type ?? existing.type,
          options: input.options ?? existing.options,
          defaultValue:
            input.defaultValue != null
              ? stringifyDefaultValue(input.defaultValue)
              : existing.defaultValue
        })
        return { success: true as const, definition: service.get(input.name) }
      }

      const { name, ...updates } = input
      const definition = updatePropertyDefinitionRecord(name, {
        type: updates.type,
        options: updates.options ? JSON.stringify(updates.options) : undefined,
        defaultValue: updates.defaultValue ? JSON.stringify(updates.defaultValue) : undefined,
        color: updates.color
      })
      return { success: true as const, definition }
    },
    'errors:property.updateDefinitionFailed'
  )

  // notes:set-calendar-property-visibility - Toggle a date property's calendar visibility
  registerCommand(
    NotesChannels.invoke.SET_CALENDAR_PROPERTY_VISIBILITY,
    z.object({ name: z.string().min(1), showOnCalendar: z.boolean() }),
    async (input) => {
      const { PropertyDefinitionsService } = await import('../vault/property-definitions')
      await PropertyDefinitionsService.get().setShowOnCalendar(input.name, input.showOnCalendar)
      return { success: true as const }
    },
    'errors:property.setCalendarVisibilityFailed'
  )

  // notes:get-calendar-property-names - List property names enabled to show on the calendar
  ipcMain.handle(
    NotesChannels.invoke.GET_CALENDAR_PROPERTY_NAMES,
    createHandler(async () => {
      const { PropertyDefinitionsService } = await import('../vault/property-definitions')
      return PropertyDefinitionsService.get().listCalendarEnabledNames()
    })
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
        const { PropertyDefinitionsService } = await import('../vault/property-definitions')
        const service = PropertyDefinitionsService.get()
        // The service materializes a missing status definition itself, so the
        // pre-upsert this used to do only cost a second write of the same file.
        await service.addStatusOption(input.propertyName, input.categoryKey, input.option)
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
      deletePropertyDefinitionRecord(input.name)
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
      if (result.success && result.diskPath) {
        try {
          // `result.diskPath`, never `result.path`: the latter is a note-relative
          // ref, and running it back through `fromMemryFileUrl` threw on every
          // save, so this emit never fired and no attachment written from the
          // editor reached another device.
          emitNoteAttachmentSaved(input.noteId, result.diskPath)
        } catch (error) {
          // Don't block local save if sync event fails — but a swallowed emit
          // means the attachment silently never syncs to other devices.
          logger.warn('Attachment sync emit failed after local save', {
            noteId: input.noteId,
            error
          })
          trackMainError('notes', 'attachment_sync_emit', error)
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
  registerCommand(
    NotesChannels.invoke.DELETE_ATTACHMENT,
    DeleteAttachmentSchema,
    async (input) => {
      await deleteAttachment(input.noteId, input.filename)
      return { success: true as const }
    },
    'errors:attachment.deleteFailed'
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
  registerCommand(
    NotesChannels.invoke.SET_FOLDER_CONFIG,
    SetFolderConfigSchema,
    async (input) => {
      // FolderConfigSchema only carries icon/template/inherit, but .folder.md
      // also stores view configuration (views/formulas/properties/summaries).
      // Merge those back from disk so a template/icon write never wipes them.
      // Icon is preserved when the key is absent; explicit null clears it.
      const current = (await readFolderConfig(input.folderPath)) ?? {}
      const icon = 'icon' in input.config ? (input.config.icon ?? null) : (current.icon ?? null)
      await writeFolderConfig(input.folderPath, {
        ...input.config,
        icon,
        views: current.views,
        formulas: current.formulas,
        properties: current.properties,
        summaries: current.summaries
      })
      syncFolderConfigSet(input.folderPath, icon)
      return { success: true as const }
    },
    'errors:folder.setConfigFailed'
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

  registerCommand(
    NotesChannels.invoke.EXPORT_PDF,
    ExportNoteSchema,
    async (input) => {
      const t = getMainI18n().getFixedT(null, 'system')
      const note = await getNoteById(input.noteId)
      if (!note) {
        return { success: false as const, error: t('error.noteNotFound') }
      }

      let targetPath = input.outputPath
      if (!targetPath) {
        const defaultFilename = `${sanitizeFilename(note.title)}.pdf`
        const result = await dialog.showSaveDialog({
          title: t('dialog.exportPdf.title'),
          defaultPath: defaultFilename,
          filters: [{ name: t('dialog.exportPdf.filterName'), extensions: ['pdf'] }]
        })

        if (result.canceled || !result.filePath) {
          return { success: false as const, error: t('dialog.exportCancelled') }
        }
        targetPath = result.filePath
      }

      const html = await renderNoteForExport(note, input.includeMetadata)

      const win = new BrowserWindow({
        show: false,
        width: 800,
        height: 600,
        webPreferences: {
          javascript: false
        }
      })

      let pdfData: Buffer
      try {
        await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
        await new Promise((resolve) => setTimeout(resolve, 100))

        const pageSizeMap: Record<string, Electron.PrintToPDFOptions['pageSize']> = {
          A4: 'A4',
          Letter: 'Letter',
          Legal: 'Legal'
        }

        pdfData = await win.webContents.printToPDF({
          printBackground: true,
          pageSize: pageSizeMap[input.pageSize] || 'A4',
          margins: {
            top: 0.5,
            bottom: 0.5,
            left: 0.5,
            right: 0.5
          }
        })
      } finally {
        if (!win.isDestroyed()) win.destroy()
      }

      await fs.writeFile(targetPath, pdfData)

      trackMainEvent('note_exported', {
        surface: 'notes',
        action: 'pdf',
        objectType: 'note',
        result: 'success'
      })
      return { success: true as const, path: targetPath }
    },
    'errors:note.exportPdfFailed'
  )

  // =========================================================================
  // T108: HTML Export Handler
  // =========================================================================

  registerCommand(
    NotesChannels.invoke.EXPORT_HTML,
    ExportNoteSchema,
    async (input) => {
      const t = getMainI18n().getFixedT(null, 'system')
      const note = await getNoteById(input.noteId)
      if (!note) {
        return { success: false as const, error: t('error.noteNotFound') }
      }

      let targetPath = input.outputPath
      if (!targetPath) {
        const defaultFilename = `${sanitizeFilename(note.title)}.html`
        const result = await dialog.showSaveDialog({
          title: t('dialog.exportHtml.title'),
          defaultPath: defaultFilename,
          filters: [{ name: t('dialog.exportHtml.filterName'), extensions: ['html', 'htm'] }]
        })

        if (result.canceled || !result.filePath) {
          return { success: false as const, error: t('dialog.exportCancelled') }
        }
        targetPath = result.filePath
      }

      const html = await renderNoteForExport(note, input.includeMetadata)

      await fs.writeFile(targetPath, html, 'utf-8')

      trackMainEvent('note_exported', {
        surface: 'notes',
        action: 'html',
        objectType: 'note',
        result: 'success'
      })
      return { success: true as const, path: targetPath }
    },
    'errors:note.exportHtmlFailed'
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
        trackMainEvent('note_updated', {
          surface: 'notes',
          action: 'version_restored',
          objectType: 'note',
          result: 'success'
        })
        return { success: true, note }
      }, 'errors:note.restoreVersionFailed')
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
      }, 'errors:note.deleteVersionFailed')
    )
  )

  registerCommand(
    NotesChannels.invoke.GET_POSITIONS,
    NoteGetPositionsSchema,
    (input) => {
      const db = getDatabase()
      const positions = getNotesInFolder(db, input.folderPath)
      return { success: true as const, positions }
    },
    'Failed to get positions'
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

  registerCommand(
    NotesChannels.invoke.REORDER,
    NoteReorderSchema,
    (input) => {
      const db = getDatabase()
      reorderNotesInFolder(db, input.folderPath, input.notePaths)
      return { success: true as const }
    },
    'errors:note.reorderFailed'
  )

  // notes:import-files - Import files from external paths into the vault
  registerCommand(
    NotesChannels.invoke.IMPORT_FILES,
    z.object({
      sourcePaths: z.array(z.string()),
      targetFolder: z.string().optional()
    }),
    async (input) => {
      const result = await importFiles(input)
      trackMainEvent('note_imported', {
        surface: 'notes',
        action: 'imported',
        objectType: 'note',
        result: result.failed === 0 ? 'success' : 'failed',
        metrics: { itemCount: result.imported }
      })
      for (const file of result.importedFiles) {
        if (file.fileType !== 'markdown') {
          emitNoteAttachmentSaved('vault-import', file.destPath)
        }
      }
      return result
    },
    'errors:note.importFilesFailed'
  )

  // notes:show-import-dialog - Open a file dialog to select files for import
  ipcMain.handle(
    NotesChannels.invoke.SHOW_IMPORT_DIALOG,
    createHandler(async () => {
      const t = getMainI18n().getFixedT(null, 'system')
      const extensions = getAllSupportedExtensions()
      const result = await dialog.showOpenDialog({
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: t('dialog.import.filterSupported'), extensions },
          { name: t('dialog.import.filterAll'), extensions: ['*'] }
        ]
      })

      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true, filePaths: [] }
      }

      return { canceled: false, filePaths: result.filePaths }
    })
  )

  // notes:set-local-only — Toggle local-only flag (excludes from sync)
  registerCommand(
    NotesChannels.invoke.SET_LOCAL_ONLY,
    SetLocalOnlySchema,
    async (input) => {
      const note = await setNoteLocalOnlyCommand(input)
      return { success: true as const, note }
    },
    'errors:note.setLocalOnlyFailed'
  )

  // notes:get-local-only-count — Count of local-only notes
  ipcMain.handle(
    NotesChannels.invoke.GET_LOCAL_ONLY_COUNT,
    createHandler(() => {
      return { count: countLocalOnlyNoteMetadata(getDatabase()) }
    })
  )

  // notes:large-file-open — Prepare a large-file-class file for the read-only
  // viewer. Returns as soon as the handle is open; the line-offset scan runs
  // behind it and reports on NotesChannels.events.LARGE_FILE_INDEX.
  ipcMain.handle(
    NotesChannels.invoke.LARGE_FILE_OPEN,
    createStringHandler((noteId) => openLargeFileSession(noteId))
  )

  // notes:large-file-read-lines — One window of lines from an open session
  ipcMain.handle(
    NotesChannels.invoke.LARGE_FILE_READ_LINES,
    createValidatedHandler(LargeFileReadLinesSchema, (input) => readLargeFileLines(input))
  )

  // notes:large-file-close — Release the session and its file handle
  ipcMain.handle(
    NotesChannels.invoke.LARGE_FILE_CLOSE,
    createStringHandler((sessionId) => closeLargeFileSession(sessionId))
  )

  // notes:large-file-search — Find a literal query inside an open session.
  // Large files never enter FTS, so this is the only search that can see them.
  ipcMain.handle(
    NotesChannels.invoke.LARGE_FILE_SEARCH,
    createValidatedHandler(LargeFileSearchSchema, (input) => searchLargeFileSession(input))
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
  // Handlers go away when the vault closes, and an open large-file session
  // pins an OS file handle to a file in the vault that is being left.
  void closeAllLargeFileSessions()
}
