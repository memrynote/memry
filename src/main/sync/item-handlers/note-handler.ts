import fs from 'fs'
import path from 'path'
import { isNull, and } from 'drizzle-orm'
import { noteCache } from '@shared/db/schema/notes-cache'
import { NoteSyncPayloadSchema, type NoteSyncPayload } from '@shared/contracts/sync-payloads'
import { NotesChannels } from '@shared/ipc-channels'
import type { VectorClock } from '@shared/contracts/sync-api'
import type { SyncQueueManager } from '../queue'
import { increment } from '../vector-clock'
import { extractFolderFromPath } from '../note-sync'
import { getIndexDatabase } from '../../database/client'
import {
  atomicWrite,
  deleteFile,
  generateNotePath,
  generateUniquePathSync
} from '../../vault/file-ops'
import { toAbsolutePath, toRelativePath, getNotesDir } from '../../vault/notes'
import { parseNote, serializeNote, type NoteFrontmatter } from '../../vault/frontmatter'
import { syncNoteToCache, deleteNoteFromCache } from '../../vault/note-sync'
import { getNoteCacheById, getNoteCacheByPath, updateNoteCache } from '@shared/db/queries/notes'
import { createLogger } from '../../lib/logger'
import { resolveClockConflict } from './types'
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
    const now = new Date().toISOString()

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

      const localFolder = extractFolderFromPath(existing.path)
      const remoteFolder = data.folderPath ?? null
      const folderChanged = localFolder !== remoteFolder
      const newTitle = data.title ?? existing.title
      const titleChanged = newTitle !== existing.title
      const needsPathUpdate = folderChanged || titleChanged

      const updateFields: Parameters<typeof updateNoteCache>[2] = {
        title: newTitle,
        emoji: data.emoji ?? existing.emoji,
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
          const updatedContent = serializeNote(parsed.frontmatter, parsed.content)

          atomicWrite(newAbsPath, updatedContent)
            .then(() => deleteFile(oldAbsPath))
            .then(() => removeEmptyParents(path.dirname(oldAbsPath), notesDir))
            .catch((err: unknown) => {
              log.error('Failed to move/rename synced note', { itemId, error: err })
            })
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
      }

      updateNoteCache(indexDb, itemId, updateFields)

      ctx.emit(NotesChannels.events.UPDATED, { id: itemId, source: 'sync' })
      return resolution.action === 'merge' ? 'conflict' : 'applied'
    }

    const notesDir = getNotesDir()
    const title = data.title ?? 'Untitled'
    const content = data.content ?? ''

    const frontmatter: NoteFrontmatter = {
      id: itemId,
      title,
      created: data.createdAt ?? now,
      modified: data.modifiedAt ?? now,
      tags: data.tags ?? [],
      ...(data.aliases?.length ? { aliases: data.aliases } : {})
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

    atomicWrite(absolutePath, fileContent).catch((err) => {
      log.error('Failed to write synced note to disk', { itemId, error: err })
    })

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

    deleteFile(absolutePath).catch((err) => {
      log.error('Failed to delete synced note file', { itemId, error: err })
    })
    return 'applied'
  },

  fetchLocal(_db: DrizzleDb, itemId: string): Record<string, unknown> | undefined {
    const indexDb = getIndexDatabase()
    const cached = getNoteCacheById(indexDb, itemId)
    if (!cached) return undefined
    return cached as unknown as Record<string, unknown>
  },

  buildPushPayload(_db: DrizzleDb, itemId: string, _deviceId: string, operation: string): string | null {
    const indexDb = getIndexDatabase()
    const cached = getNoteCacheById(indexDb, itemId)
    if (!cached) return null

    let content: string | null = null
    let tags: string[] = []
    const absolutePath = toAbsolutePath(cached.path)
    try {
      const raw = fs.readFileSync(absolutePath, 'utf-8')
      const parsed = parseNote(raw)
      content = operation === 'create' ? parsed.content : null
      tags = parsed.frontmatter.tags ?? []
    } catch {
      log.warn('Could not read note file for push payload', { noteId: cached.id })
    }

    const folderPath = extractFolderFromPath(cached.path)

    return JSON.stringify({
      title: cached.title,
      content,
      tags,
      emoji: cached.emoji,
      fileType: cached.fileType,
      folderPath,
      clock: cached.clock ?? {},
      createdAt: cached.createdAt,
      modifiedAt: cached.modifiedAt
    })
  },

  seedUnclocked(_db: DrizzleDb, deviceId: string, queue: SyncQueueManager): number {
    const indexDb = getIndexDatabase()
    const items = indexDb
      .select()
      .from(noteCache)
      .where(and(isNull(noteCache.clock), isNull(noteCache.date)))
      .all()

    for (const item of items) {
      const clock = increment({}, deviceId)
      const folderPath = extractFolderFromPath(item.path)
      updateNoteCache(indexDb, item.id, { clock })
      queue.enqueue({
        type: 'note',
        itemId: item.id,
        operation: 'create',
        payload: JSON.stringify({
          title: item.title,
          emoji: item.emoji,
          fileType: item.fileType,
          folderPath,
          clock,
          createdAt: item.createdAt,
          modifiedAt: item.modifiedAt
        }),
        priority: 0
      })
    }
    return items.length
  }
}
