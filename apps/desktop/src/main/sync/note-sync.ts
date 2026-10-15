import path from 'path'
import type { VectorClock } from '@memry/contracts/sync-api'
import type { NoteSyncPayload } from '@memry/contracts/sync-payloads'
import { isBinaryFileType } from '@memry/shared/file-types'
import type { NoteMetadata } from '@memry/db-schema/data-schema'
import { getNoteProperties, type PropertyValue } from '@main/database/queries/notes'
import { getPinnedTagsForNote } from '@memry/sync-client/item-handlers/note-pin-helpers'
import { ContentSyncService, type ContentSyncDeps } from './content-sync-base'
import { getIndexDatabase } from '../database/client'
import { createLogger } from '../lib/logger'
import { readNoteFileFields } from './note-file-fields'
import { registerRenameSyncCallback, unregisterRenameSyncCallback } from '../vault/rename-tracker'

const log = createLogger('NoteSync')

function propsToRecord(props: PropertyValue[]): Record<string, unknown> {
  return Object.fromEntries(props.map((p) => [p.name, p.value]))
}

let instance: NoteSyncService | null = null

export function initNoteSyncService(deps: ContentSyncDeps): NoteSyncService {
  instance = new NoteSyncService(deps)
  registerRenameSyncCallback((id) => instance?.enqueueUpdate(id))
  return instance
}

export function getNoteSyncService(): NoteSyncService | null {
  return instance
}

export function resetNoteSyncService(): void {
  unregisterRenameSyncCallback()
  instance = null
}

export class NoteSyncService extends ContentSyncService<NoteSyncPayload> {
  protected readonly log = log
  readonly itemType = 'note' as const

  protected buildDeletePayload(
    cached: NoteMetadata | undefined,
    clock: VectorClock
  ): NoteSyncPayload | null {
    if (!cached) {
      log.warn('Note not found in cache for delete enqueue')
      return null
    }

    // A tombstone deliberately carries NO user-visible text. A receiver reads
    // only `bodyStateVector`, the doc's Yjs state vector (no text), to keep
    // body text this delete never saw (chapter 05 §5.8, #3037); older builds
    // never decode a delete body. `title` stays optional in
    // NoteSyncPayloadSchema, so an older body still validates. The `clock`
    // MUST stay — push-coordinator.extractPayloadMetadata lifts it out of
    // this string to stamp the server-side item version, so dropping it
    // would break delete ordering across devices.
    return {
      clock,
      bodyStateVector: this.bodyStateVector(cached.id),
      createdAt: cached.createdAt,
      modifiedAt: cached.modifiedAt
    }
  }

  protected buildSnapshotPayload(
    cached: NoteMetadata,
    clock: VectorClock,
    operation: 'create' | 'update'
  ): NoteSyncPayload {
    const folderPath = extractFolderFromPath(cached.path)

    if (cached.fileType && isBinaryFileType(cached.fileType)) {
      return {
        title: cached.title,
        emoji: cached.emoji,
        fileType: cached.fileType,
        mimeType: cached.mimeType,
        attachmentId: cached.attachmentId,
        folderPath,
        clock,
        createdAt: cached.createdAt,
        modifiedAt: cached.modifiedAt
      }
    }

    const { content, tags, aliases } = readNoteFileFields(cached, operation)

    const indexDb = getIndexDatabase()
    const properties = propsToRecord(getNoteProperties(indexDb, cached.id))
    const pinnedTags = getPinnedTagsForNote(indexDb, cached.id)

    return {
      title: cached.title,
      content,
      tags,
      ...(aliases !== undefined ? { aliases } : {}),
      properties,
      pinnedTags,
      emoji: cached.emoji,
      fileType: cached.fileType,
      folderPath,
      clock,
      createdAt: cached.createdAt,
      modifiedAt: cached.modifiedAt
    }
  }

  removeQueueItems(itemId: string): number {
    return this.queue.removeByItemId(itemId)
  }
}

/**
 * Folder a note syncs under, vault-relative.
 *
 * `defaultNoteFolder` is deliberately not stripped: it is a destination for
 * new notes, not a tree root, so two devices that disagree about it must still
 * agree about where a note lives (#1204).
 */
export function extractFolderFromPath(relativePath: string): string | null {
  const dir = path.dirname(relativePath)
  return dir === '.' ? null : dir
}
