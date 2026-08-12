import fs from 'fs'
import path from 'path'
import type { VectorClock } from '@memry/contracts/sync-api'
import type { NoteSyncPayload } from '@memry/contracts/sync-payloads'
import { isBinaryFileType } from '@memry/shared/file-types'
import type { NoteMetadata } from '@memry/db-schema/data-schema'
import { getNoteProperties, type PropertyValue } from '@main/database/queries/notes'
import { getPinnedTagsForNote } from './item-handlers/note-pin-helpers'
import { ContentSyncService, type ContentSyncDeps } from './content-sync-base'
import { getIndexDatabase } from '../database/client'
import { createLogger } from '../lib/logger'
import { toAbsolutePath } from '../vault/notes'
import { parseNote } from '../vault/frontmatter'
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

    // A tombstone deliberately carries NO user-visible text. Nothing consumes
    // it: ItemApplier short-circuits `operation === 'delete'` and calls
    // applyDelete(ctx, itemId, clock) without ever decoding the payload bytes,
    // and SyncItemHandler.applyDelete has no data parameter to receive them
    // with. The title was therefore dead weight that still got encrypted and
    // uploaded on every single note delete.
    //
    // Backward compatible in both directions: `title` is optional in
    // NoteSyncPayloadSchema, so an older receiving build that did parse this
    // body still validates it, and no shipped delete path reads the field. The
    // `clock` MUST stay — push-coordinator.extractPayloadMetadata lifts it out
    // of this string to stamp the server-side item version, so dropping it
    // would break delete ordering across devices.
    return {
      clock,
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

    let content: string | null = null
    let tags: string[] = []
    const absolutePath = toAbsolutePath(cached.path)
    try {
      const raw = fs.readFileSync(absolutePath, 'utf-8')
      const parsed = parseNote(raw)
      content = operation === 'create' ? parsed.content : null
      tags = parsed.frontmatter.tags ?? []
    } catch {
      log.warn('Could not read note file for sync snapshot', { noteId: cached.id })
    }

    const indexDb = getIndexDatabase()
    const properties = propsToRecord(getNoteProperties(indexDb, cached.id))
    const pinnedTags = getPinnedTagsForNote(indexDb, cached.id)

    return {
      title: cached.title,
      content,
      tags,
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
