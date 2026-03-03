import fs from 'fs'
import { and, isNull, sql } from 'drizzle-orm'
import { noteCache } from '@shared/db/schema/notes-cache'
import type { SyncQueueManager } from '../queue'
import { increment } from '../vector-clock'
import { extractFolderFromPath } from '../note-sync'
import { isBinaryFileType } from '@shared/file-types'
import { toAbsolutePath } from '../../vault/notes'
import { parseNote } from '../../vault/frontmatter'
import { getIndexDatabase } from '../../database/client'
import { createLogger } from '../../lib/logger'
import { getPinnedTagsForNote } from './note-pin-helpers'
import {
  getNoteCacheById,
  getNoteProperties,
  updateNoteCache,
  type PropertyValue
} from '@shared/db/queries/notes'

const log = createLogger('NoteHandlerSyncHelpers')

function propsToRecord(props: PropertyValue[]): Record<string, unknown> {
  return Object.fromEntries(props.map((p) => [p.name, p.value]))
}

export function fetchLocalNote(itemId: string): Record<string, unknown> | undefined {
  const indexDb = getIndexDatabase()
  const cached = getNoteCacheById(indexDb, itemId)
  if (!cached) return undefined
  return cached as unknown as Record<string, unknown>
}

export function buildNotePushPayload(itemId: string, operation: string): string | null {
  const indexDb = getIndexDatabase()
  const cached = getNoteCacheById(indexDb, itemId)
  if (!cached || cached.localOnly) return null

  if (cached.fileType && isBinaryFileType(cached.fileType)) {
    const folderPath = extractFolderFromPath(cached.path)
    return JSON.stringify({
      title: cached.title,
      emoji: cached.emoji,
      fileType: cached.fileType,
      mimeType: cached.mimeType,
      attachmentId: cached.attachmentId,
      folderPath,
      clock: cached.clock ?? {},
      createdAt: cached.createdAt,
      modifiedAt: cached.modifiedAt
    })
  }

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
  const properties = propsToRecord(getNoteProperties(indexDb, itemId))
  const pinnedTags = getPinnedTagsForNote(indexDb, itemId)

  return JSON.stringify({
    title: cached.title,
    content,
    tags,
    properties,
    pinnedTags,
    emoji: cached.emoji,
    fileType: cached.fileType,
    folderPath,
    clock: cached.clock ?? {},
    createdAt: cached.createdAt,
    modifiedAt: cached.modifiedAt
  })
}

export function seedUnclockedNotes(deviceId: string, queue: SyncQueueManager): number {
  let indexDb: ReturnType<typeof getIndexDatabase>
  try {
    indexDb = getIndexDatabase()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.warn('Skipping unclocked note seeding: index database unavailable', { message })
    return 0
  }

  const items = indexDb
    .select()
    .from(noteCache)
    .where(
      and(isNull(noteCache.clock), isNull(noteCache.date), sql`${noteCache.localOnly} IS NOT 1`)
    )
    .all()

  for (const item of items) {
    const clock = increment({}, deviceId)
    const folderPath = extractFolderFromPath(item.path)
    const properties = propsToRecord(getNoteProperties(indexDb, item.id))
    const pinnedTags = getPinnedTagsForNote(indexDb, item.id)
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
        ...(Object.keys(properties).length > 0 ? { properties } : {}),
        ...(pinnedTags.length > 0 ? { pinnedTags } : {}),
        clock,
        createdAt: item.createdAt,
        modifiedAt: item.modifiedAt
      }),
      priority: 0
    })
  }

  return items.length
}
