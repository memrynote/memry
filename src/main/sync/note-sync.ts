import fs from 'fs'
import path from 'path'
import type { VectorClock } from '@shared/contracts/sync-api'
import type { NoteSyncPayload } from '@shared/contracts/sync-payloads'
import type { NoteCache } from '@shared/db/schema/notes-cache'
import { getNoteProperties, type PropertyValue } from '@shared/db/queries/notes'
import { getPinnedTagsForNote } from './item-handlers/note-pin-helpers'
import { ContentSyncService, type ContentSyncDeps } from './content-sync-base'
import { getIndexDatabase } from '../database/client'
import { createLogger } from '../lib/logger'
import { toAbsolutePath } from '../vault/notes'
import { getConfig } from '../vault/index'
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
    cached: NoteCache | undefined,
    clock: VectorClock
  ): NoteSyncPayload | null {
    if (!cached) {
      log.warn('Note not found in cache for delete enqueue')
      return null
    }

    return {
      title: cached.title,
      clock,
      createdAt: cached.createdAt,
      modifiedAt: cached.modifiedAt
    }
  }

  protected buildSnapshotPayload(
    cached: NoteCache,
    clock: VectorClock,
    operation: 'create' | 'update'
  ): NoteSyncPayload {
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

    const folderPath = extractFolderFromPath(cached.path)
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
}

export function extractFolderFromPath(relativePath: string): string | null {
  const config = getConfig()
  const prefix = config.defaultNoteFolder + '/'
  const withoutPrefix = relativePath.startsWith(prefix)
    ? relativePath.slice(prefix.length)
    : relativePath
  const dir = path.dirname(withoutPrefix)
  return dir === '.' ? null : dir
}
