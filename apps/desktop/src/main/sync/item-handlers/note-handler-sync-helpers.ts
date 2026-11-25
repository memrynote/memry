import { and, isNull, sql } from 'drizzle-orm'
import { noteMetadata } from '@memry/db-schema/data-schema'
import type { SyncQueueManager } from '@memry/sync-client/queue'
import { nextLocalClock } from '@memry/sync-client/tombstone-clocks'
import { extractFolderFromPath } from '../note-sync'
import { seedSkipsDeletedNote } from '../pending-deletes'
import { readNoteFileFields } from '../note-file-fields'
import { getDatabase, getIndexDatabase } from '../../database/client'
import { createLogger } from '../../lib/logger'
import { getPinnedTagsForNote } from '@memry/sync-client/item-handlers/note-pin-helpers'
import { getNoteMetadataById, updateNoteMetadata } from '@memry/storage-data'
import { getNoteProperties, type PropertyValue } from '@main/database/queries/notes'
import type { NoteCoverSync } from '@memry/contracts/sync-payloads'
import type { DrizzleDb } from '@memry/sync-client/drizzle-db'
import {
  noteCoverForPush,
  offFileNoteCoverForPush,
  settleNoteCoverRemoval
} from './note-cover-sync'
import { binaryRecordFields } from '@memry/shared/file-types'

const log = createLogger('NoteHandlerSyncHelpers')

function propsToRecord(props: PropertyValue[]): Record<string, unknown> {
  return Object.fromEntries(props.map((p) => [p.name, p.value]))
}

export function fetchLocalNote(itemId: string): Record<string, unknown> | undefined {
  const dataDb = getDatabase()
  const cached = getNoteMetadataById(dataDb, itemId)
  if (!cached) return undefined
  return cached
}

export function buildNotePushPayload(itemId: string, operation: string): string | null {
  const dataDb = getDatabase()
  const indexDb = getIndexDatabase()
  const cached = getNoteMetadataById(dataDb, itemId)
  if (!cached || cached.localOnly) return null

  const binary = binaryRecordFields(cached)
  if (binary) {
    const folderPath = extractFolderFromPath(cached.path)
    return JSON.stringify({
      title: cached.title,
      emoji: cached.emoji,
      ...binary,
      attachmentId: cached.attachmentId,
      folderPath,
      clock: cached.clock ?? {},
      createdAt: cached.createdAt,
      modifiedAt: cached.modifiedAt
    })
  }

  const { content, tags, aliases, frontmatter, offFile } = readNoteFileFields(cached, operation)
  // `undefined` omits the key, which tells peers nothing: the file could not be
  // read, this device does not hold the cover's framing, or this note has had
  // no cover here. `null` is a local removal only.
  const cover: NoteCoverSync | null | undefined =
    frontmatter === null
      ? undefined
      : (offFile ? offFileNoteCoverForPush : noteCoverForPush)(dataDb, itemId, frontmatter)

  const folderPath = extractFolderFromPath(cached.path)
  const properties = propsToRecord(getNoteProperties(indexDb, itemId))
  const pinnedTags = getPinnedTagsForNote(indexDb, itemId)

  return JSON.stringify({
    title: cached.title,
    content,
    tags,
    ...(aliases !== undefined ? { aliases } : {}),
    properties,
    pinnedTags,
    emoji: cached.emoji,
    fileType: cached.fileType,
    folderPath,
    // Ids of server-side attachment blobs this note embeds; the receiving
    // device downloads any it is missing into its own vault (older clients
    // parse with zod strip mode and simply ignore the key).
    ...(cached.attachmentReferences?.length
      ? { attachmentReferences: cached.attachmentReferences }
      : {}),
    ...(cover !== undefined ? { cover } : {}),
    // An older iOS build's `coverImage` rides along from the kept unknown
    // fields, and readers fall back to it when `cover` is null. A removal
    // clears it too, so the old picture does not come back.
    ...(cover === null ? { coverImage: null } : {}),
    clock: cached.clock ?? {},
    createdAt: cached.createdAt,
    modifiedAt: cached.modifiedAt
  })
}

/** Called once a note push is confirmed; see `settleNoteCoverRemoval`. */
export function settlePushedNoteCover(db: DrizzleDb, itemId: string): void {
  settleNoteCoverRemoval(db, itemId, () => {
    const cached = getNoteMetadataById(db, itemId)
    return cached ? readNoteFileFields(cached, 'update').frontmatter : null
  })
}

export function seedUnclockedNotes(deviceId: string, queue: SyncQueueManager): number {
  let dataDb: ReturnType<typeof getDatabase>
  try {
    dataDb = getDatabase()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.warn('Skipping unclocked note seeding: data database unavailable', { message })
    return 0
  }

  const indexDb = getIndexDatabase()
  const items = dataDb
    .select()
    .from(noteMetadata)
    .where(
      and(
        isNull(noteMetadata.clock),
        isNull(noteMetadata.journalDate),
        sql`${noteMetadata.localOnly} IS NOT 1`
      )
    )
    .all()
    .filter((item) => !seedSkipsDeletedNote(dataDb, item.id))

  for (const item of items) {
    const clock = nextLocalClock(dataDb, 'note', item.id, null, deviceId, 'create')
    const folderPath = extractFolderFromPath(item.path)
    const properties = propsToRecord(getNoteProperties(indexDb, item.id))
    const pinnedTags = getPinnedTagsForNote(indexDb, item.id)
    updateNoteMetadata(dataDb, item.id, { clock })
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
        ...(item.attachmentReferences?.length
          ? { attachmentReferences: item.attachmentReferences }
          : {}),
        clock,
        createdAt: item.createdAt,
        modifiedAt: item.modifiedAt
      }),
      priority: 0
    })
  }

  return items.length
}
