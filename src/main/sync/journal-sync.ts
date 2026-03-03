import fs from 'fs'
import type { VectorClock } from '@shared/contracts/sync-api'
import type { JournalSyncPayload } from '@shared/contracts/sync-payloads'
import type { NoteCache } from '@shared/db/schema/notes-cache'
import { ContentSyncService, type ContentSyncDeps } from './content-sync-base'
import { createLogger } from '../lib/logger'
import { getJournalPath, parseJournalEntry } from '../vault/journal'

const log = createLogger('JournalSync')

let instance: JournalSyncService | null = null

export function initJournalSyncService(deps: ContentSyncDeps): JournalSyncService {
  instance = new JournalSyncService(deps)
  return instance
}

export function getJournalSyncService(): JournalSyncService | null {
  return instance
}

export function resetJournalSyncService(): void {
  instance = null
}

export class JournalSyncService extends ContentSyncService<JournalSyncPayload> {
  protected readonly log = log
  readonly itemType = 'journal' as const

  protected buildDeletePayload(
    cached: NoteCache | undefined,
    clock: VectorClock,
    date: string
  ): JournalSyncPayload {
    return {
      date,
      clock,
      createdAt: cached?.createdAt,
      modifiedAt: cached?.modifiedAt
    }
  }

  protected buildSnapshotPayload(
    cached: NoteCache,
    clock: VectorClock,
    operation: 'create' | 'update',
    date: string
  ): JournalSyncPayload {
    let content: string | null = null
    let tags: string[] = []
    let properties: Record<string, unknown> | null = null
    const filePath = getJournalPath(date)
    try {
      const raw = fs.readFileSync(filePath, 'utf-8')
      const parsed = parseJournalEntry(raw, date)
      content = operation === 'create' ? parsed.content : null
      tags = parsed.frontmatter.tags ?? []
      if (parsed.frontmatter.properties) {
        properties = parsed.frontmatter.properties as Record<string, unknown>
      }
    } catch {
      log.warn('Could not read journal file for sync snapshot', { noteId: cached.id, date })
    }

    return {
      date,
      content,
      tags,
      properties,
      clock,
      createdAt: cached.createdAt,
      modifiedAt: cached.modifiedAt
    }
  }
}
