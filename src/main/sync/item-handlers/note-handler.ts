import fs from 'fs'
import path from 'path'
import { NoteSyncPayloadSchema, type NoteSyncPayload } from '@shared/contracts/sync-payloads'
import { utcNow } from '@shared/utc'
import {
  isBinaryFileType,
  getExtensionFromMimeType,
  getDefaultExtension,
  getMimeType,
  type FileType
} from '@shared/file-types'
import { NotesChannels } from '@shared/ipc-channels'
import type { VectorClock } from '@shared/contracts/sync-api'
import type { SyncQueueManager } from '../queue'
import { extractFolderFromPath } from '../note-sync'
import { markWritebackIgnored } from '../crdt-writeback'
import { attachmentEvents } from '../attachment-events'
import { getIndexDatabase } from '../../database/client'
import {
  deleteFile,
  generateNotePath,
  generateFilePath,
  generateUniquePathSync
} from '../../vault/file-ops'
import { toAbsolutePath, toRelativePath, getNotesDir } from '../../vault/notes'
import {
  parseNote,
  serializeNote,
  inferPropertyType,
  type NoteFrontmatter
} from '../../vault/frontmatter'
import { syncNoteToCache, syncFileToCache, deleteNoteFromCache } from '../../vault/note-sync'
import {
  getNoteCacheById,
  getNoteCacheByPath,
  getNoteTags,
  setNoteTags,
  updateNoteCache,
  setNoteProperties,
  getPropertyType
} from '@shared/db/queries/notes'
import { createLogger } from '../../lib/logger'
import { resolveClockConflict } from './types'
import { applyPinnedTags } from './note-pin-helpers'
import {
  buildNotePushPayload,
  fetchLocalNote,
  seedUnclockedNotes
} from './note-handler-sync-helpers'
import type { SyncItemHandler, ApplyContext, ApplyResult, DrizzleDb } from './types'

const log = createLogger('NoteHandler')

async function removeEmptyParents(dir: string, stopAt: string): Promise<void> {
  let current = dir
  while (current !== stopAt && current.startsWith(stopAt)) {
    try {
      const entries = await fs.promises.readdir(current)
      const meaningful = entries.filter((e) => e !== '.DS_Store' && !e.startsWith('._'))
      if (meaningful.length > 0) break

      for (const junk of entries) {
        await fs.promises.unlink(path.join(current, junk)).catch(() => {})
      }
      await fs.promises.rmdir(current)
      log.debug('Removed empty folder', { dir: current })
      current = path.dirname(current)
    } catch {
      break
    }
  }
}

export const noteHandler: SyncItemHandler<NoteSyncPayload> = {
  type: 'note',
  schema: NoteSyncPayloadSchema,

  applyUpsert(
    ctx: ApplyContext,
    itemId: string,
    data: NoteSyncPayload,
    clock: VectorClock
  ): ApplyResult {
    const indexDb = getIndexDatabase()
    const remoteClock = Object.keys(clock).length > 0 ? clock : (data.clock ?? {})
    const now = utcNow()

    const existing = getNoteCacheById(indexDb, itemId)

    if (existing) {
      const resolution = resolveClockConflict(existing.clock, remoteClock)
      if (resolution.action === 'skip') {
        log.info('Skipping remote note update, local is newer', { itemId })
        return 'skipped'
      }
      if (resolution.action === 'merge') {
        log.warn('Concurrent note edit, applying (CRDT handles merge)', { itemId })
      }

      if (existing.fileType && isBinaryFileType(existing.fileType)) {
        const newTitle = data.title ?? existing.title
        const titleChanged = newTitle !== existing.title
        const localFolder = extractFolderFromPath(existing.path)
        const remoteFolder = data.folderPath ?? null
        const folderChanged = localFolder !== remoteFolder
        const resolvedEmoji = data.emoji ?? existing.emoji
        const needsPathUpdate = folderChanged || titleChanged

        const updateFields: Parameters<typeof updateNoteCache>[2] = {
          title: newTitle,
          emoji: resolvedEmoji,
          clock: resolution.mergedClock,
          syncedAt: now,
          modifiedAt: data.modifiedAt ?? now
        }

        if (needsPathUpdate) {
          const notesDir = getNotesDir()
          const ext = existing.mimeType
            ? (getExtensionFromMimeType(existing.mimeType) ??
              getDefaultExtension(existing.fileType))
            : getDefaultExtension(existing.fileType)
          const baseAbsPath = generateFilePath(notesDir, newTitle, ext, remoteFolder ?? undefined)
          const newAbsPath = generateUniquePathSync(
            baseAbsPath,
            (p) => !!getNoteCacheByPath(indexDb, toRelativePath(p))
          )
          const newRelPath = toRelativePath(newAbsPath)
          const oldAbsPath = toAbsolutePath(existing.path)

          updateFields.path = newRelPath

          try {
            if (fs.existsSync(oldAbsPath)) {
              markWritebackIgnored(newAbsPath)
              const dir = path.dirname(newAbsPath)
              fs.mkdirSync(dir, { recursive: true })
              fs.renameSync(oldAbsPath, newAbsPath)
              removeEmptyParents(path.dirname(oldAbsPath), notesDir).catch(() => {})
            }
          } catch {
            log.warn('Could not rename binary file', { itemId })
          }

          if (titleChanged) {
            ctx.emit(NotesChannels.events.RENAMED, {
              id: itemId,
              oldPath: existing.path,
              newPath: newRelPath,
              oldTitle: existing.title,
              newTitle,
              source: 'sync'
            })
          }
          if (folderChanged) {
            ctx.emit(NotesChannels.events.MOVED, {
              id: itemId,
              oldPath: existing.path,
              newPath: newRelPath,
              source: 'sync'
            })
          }
        }

        updateNoteCache(indexDb, itemId, updateFields)
        ctx.emit(NotesChannels.events.UPDATED, { id: itemId, source: 'sync' })
        return resolution.action === 'merge' ? 'conflict' : 'applied'
      }

      const localFolder = extractFolderFromPath(existing.path)
      const remoteFolder = data.folderPath ?? null
      const folderChanged = localFolder !== remoteFolder
      const newTitle = data.title ?? existing.title
      const titleChanged = newTitle !== existing.title
      const needsPathUpdate = folderChanged || titleChanged

      const remoteTags = data.tags
      const localTags = remoteTags !== undefined ? getNoteTags(indexDb, itemId) : undefined
      const tagsChanged =
        remoteTags !== undefined &&
        localTags !== undefined &&
        (remoteTags.length !== localTags.length || remoteTags.some((t) => !localTags.includes(t)))

      const remoteProperties = data.properties
      const propertiesPresent = remoteProperties !== undefined && remoteProperties !== null

      log.debug('applyUpsert properties', {
        itemId,
        propertiesPresent,
        remotePropertiesKeys: remoteProperties ? Object.keys(remoteProperties) : 'undefined',
        action: resolution.action
      })

      const resolvedEmoji = data.emoji ?? existing.emoji
      const emojiChanged = data.emoji !== undefined && data.emoji !== existing.emoji

      const updateFields: Parameters<typeof updateNoteCache>[2] = {
        title: newTitle,
        emoji: resolvedEmoji,
        clock: resolution.mergedClock,
        syncedAt: now,
        modifiedAt: data.modifiedAt ?? now
      }

      if (needsPathUpdate) {
        const notesDir = getNotesDir()
        const baseAbsPath = generateNotePath(notesDir, newTitle, remoteFolder ?? undefined)
        const newAbsPath = generateUniquePathSync(
          baseAbsPath,
          (p) => !!getNoteCacheByPath(indexDb, toRelativePath(p))
        )
        const newRelPath = toRelativePath(newAbsPath)
        const oldAbsPath = toAbsolutePath(existing.path)

        updateFields.path = newRelPath

        try {
          const raw = fs.readFileSync(oldAbsPath, 'utf-8')
          const parsed = parseNote(raw)
          parsed.frontmatter.title = newTitle
          if (tagsChanged && remoteTags) {
            parsed.frontmatter.tags = remoteTags
          }
          if (propertiesPresent) {
            if (Object.keys(remoteProperties).length > 0) {
              parsed.frontmatter.properties = remoteProperties
            } else {
              delete parsed.frontmatter.properties
            }
          }
          if (emojiChanged) {
            parsed.frontmatter.emoji = resolvedEmoji
          }
          const updatedContent = serializeNote(parsed.frontmatter, parsed.content)

          markWritebackIgnored(newAbsPath)
          const dir = path.dirname(newAbsPath)
          fs.mkdirSync(dir, { recursive: true })
          const tmpPath = newAbsPath + '.tmp'
          fs.writeFileSync(tmpPath, updatedContent, 'utf-8')
          fs.renameSync(tmpPath, newAbsPath)
          fs.unlinkSync(oldAbsPath)
          removeEmptyParents(path.dirname(oldAbsPath), notesDir).catch(() => {})
        } catch {
          log.warn('Could not read old note for rename/move', { itemId })
        }

        if (titleChanged) {
          ctx.emit(NotesChannels.events.RENAMED, {
            id: itemId,
            oldPath: existing.path,
            newPath: newRelPath,
            oldTitle: existing.title,
            newTitle,
            source: 'sync'
          })
        }
        if (folderChanged) {
          ctx.emit(NotesChannels.events.MOVED, {
            id: itemId,
            oldPath: existing.path,
            newPath: newRelPath,
            source: 'sync'
          })
        }
      } else if ((tagsChanged && remoteTags) || propertiesPresent || emojiChanged) {
        const absPath = toAbsolutePath(existing.path)
        try {
          const raw = fs.readFileSync(absPath, 'utf-8')
          const parsed = parseNote(raw)
          if (tagsChanged && remoteTags) {
            parsed.frontmatter.tags = remoteTags
          }
          if (propertiesPresent) {
            if (Object.keys(remoteProperties).length > 0) {
              parsed.frontmatter.properties = remoteProperties
            } else {
              delete parsed.frontmatter.properties
            }
          }
          if (emojiChanged) {
            parsed.frontmatter.emoji = resolvedEmoji
          }
          const updatedContent = serializeNote(parsed.frontmatter, parsed.content)
          markWritebackIgnored(absPath)
          const tmpPath = absPath + '.tmp'
          fs.writeFileSync(tmpPath, updatedContent, 'utf-8')
          fs.renameSync(tmpPath, absPath)
        } catch {
          log.warn('Could not read note for frontmatter update', { itemId })
        }
      }

      if (tagsChanged && remoteTags) {
        setNoteTags(indexDb, itemId, remoteTags)
      }

      if (propertiesPresent) {
        const getType = (name: string, value: unknown) =>
          getPropertyType(indexDb, name, value, inferPropertyType)
        setNoteProperties(indexDb, itemId, remoteProperties, getType)
      }

      if (data.pinnedTags) {
        applyPinnedTags(indexDb, itemId, data.pinnedTags)
      }

      updateNoteCache(indexDb, itemId, updateFields)

      ctx.emit(NotesChannels.events.UPDATED, { id: itemId, source: 'sync' })
      if (tagsChanged) {
        ctx.emit('notes:tags-changed', {})
      }
      return resolution.action === 'merge' ? 'conflict' : 'applied'
    }

    const notesDir = getNotesDir()
    const title = data.title ?? 'Untitled'

    if (data.fileType && isBinaryFileType(data.fileType)) {
      const ext =
        (data.mimeType ? getExtensionFromMimeType(data.mimeType) : null) ??
        getDefaultExtension(data.fileType as FileType)
      const basePath = generateFilePath(notesDir, title, ext, data.folderPath ?? undefined)
      const absolutePath = generateUniquePathSync(
        basePath,
        (p) => !!getNoteCacheByPath(indexDb, toRelativePath(p))
      )
      const relPath = toRelativePath(absolutePath)

      syncFileToCache(indexDb, {
        id: itemId,
        path: relPath,
        title,
        fileType: data.fileType as Exclude<FileType, 'markdown'>,
        mimeType: data.mimeType ?? getMimeType(ext) ?? null,
        fileSize: 0,
        createdAt: data.createdAt ? new Date(data.createdAt) : new Date(),
        modifiedAt: data.modifiedAt ? new Date(data.modifiedAt) : new Date()
      })
      updateNoteCache(indexDb, itemId, {
        clock: remoteClock,
        syncedAt: now,
        emoji: data.emoji ?? null,
        attachmentId: data.attachmentId ?? null
      })

      if (data.attachmentId) {
        attachmentEvents.emitDownloadNeeded({
          noteId: itemId,
          attachmentId: data.attachmentId,
          diskPath: absolutePath
        })
      }

      ctx.emit(NotesChannels.events.CREATED, {
        note: { id: itemId, path: relPath, title },
        source: 'sync'
      })
      return 'applied'
    }

    const content = data.content ?? ''

    const frontmatter: NoteFrontmatter = {
      id: itemId,
      title,
      created: data.createdAt ?? now,
      modified: data.modifiedAt ?? now,
      tags: data.tags ?? [],
      ...(data.aliases?.length ? { aliases: data.aliases } : {}),
      ...(data.properties && Object.keys(data.properties).length > 0
        ? { properties: data.properties }
        : {}),
      ...(data.emoji ? { emoji: data.emoji } : {})
    }

    const fileContent = serializeNote(frontmatter, content)
    const basePath = generateNotePath(notesDir, title, data.folderPath ?? undefined)
    const absolutePath = generateUniquePathSync(
      basePath,
      (p) => !!getNoteCacheByPath(indexDb, toRelativePath(p))
    )
    const relPath = toRelativePath(absolutePath)

    syncNoteToCache(
      indexDb,
      { id: itemId, path: relPath, fileContent, frontmatter, parsedContent: content },
      { isNew: true }
    )
    updateNoteCache(indexDb, itemId, { clock: remoteClock, syncedAt: now })

    if (data.pinnedTags) {
      applyPinnedTags(indexDb, itemId, data.pinnedTags)
    }

    markWritebackIgnored(absolutePath)
    const dir = path.dirname(absolutePath)
    fs.mkdirSync(dir, { recursive: true })
    const tmpPath = absolutePath + '.tmp'
    fs.writeFileSync(tmpPath, fileContent, 'utf-8')
    fs.renameSync(tmpPath, absolutePath)

    ctx.emit(NotesChannels.events.CREATED, {
      note: { id: itemId, path: relPath, title },
      source: 'sync'
    })
    return 'applied'
  },

  applyDelete(ctx: ApplyContext, itemId: string, clock?: VectorClock): 'applied' | 'skipped' {
    const indexDb = getIndexDatabase()
    const existing = getNoteCacheById(indexDb, itemId)
    if (!existing) return 'skipped'

    if (clock && existing.clock) {
      const resolution = resolveClockConflict(existing.clock, clock)
      if (resolution.action === 'skip' || resolution.action === 'merge') {
        log.info('Skipping remote note delete, local has unseen changes', { itemId })
        return 'skipped'
      }
    }

    const absolutePath = toAbsolutePath(existing.path)
    deleteNoteFromCache(indexDb, itemId)
    ctx.emit(NotesChannels.events.DELETED, { id: itemId, path: existing.path, source: 'sync' })

    markWritebackIgnored(absolutePath)
    deleteFile(absolutePath).catch((err) => {
      log.error('Failed to delete synced note file', { itemId, error: err })
    })
    return 'applied'
  },

  fetchLocal(_db: DrizzleDb, itemId: string): Record<string, unknown> | undefined {
    return fetchLocalNote(itemId)
  },

  buildPushPayload(
    _db: DrizzleDb,
    itemId: string,
    _deviceId: string,
    operation: string
  ): string | null {
    return buildNotePushPayload(itemId, operation)
  },

  seedUnclocked(_db: DrizzleDb, deviceId: string, queue: SyncQueueManager): number {
    return seedUnclockedNotes(deviceId, queue)
  }
}
