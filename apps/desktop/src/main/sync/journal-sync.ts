import type { VectorClock } from '@memry/contracts/sync-api'
import type { JournalSyncPayload } from '@memry/contracts/sync-payloads'
import type { NoteMetadata } from '@memry/db-schema/data-schema'
import { ContentSyncService, type ContentSyncDeps } from './content-sync-base'
import { createLogger } from '../lib/logger'
import { extractJournalProperties, parseJournalEntry, readJournalTextSync } from '../vault/journal'

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

export class JournalSyncService extends ContentSyncService<JournalSyncPayload, [string]> {
  protected readonly log = log
  readonly itemType = 'journal' as const

  // `date` is still taken so the controller's extra-args signature is unchanged
  // and callers keep passing it; it is deliberately not put on the wire.
  protected buildDeletePayload(
    cached: NoteMetadata | undefined,
    clock: VectorClock,
    _date: string
  ): JournalSyncPayload {
    // A tombstone deliberately carries NO user-visible data, matching notes:
    // the date stays off the wire, since journal-handler.applyDelete resolves
    // the day from the local row (`existing.journalDate`). A receiver reads
    // only `bodyStateVector`, the doc's Yjs state vector, to keep body text
    // this delete never saw (chapter 05 §5.8, #3037); older builds never
    // decode a delete body, and `date` stays accepted, only optional. The
    // `clock` MUST stay — push-coordinator.extractPayloadMetadata lifts it
    // out of this string to stamp the server-side item version.
    return {
      clock,
      bodyStateVector: this.bodyStateVector(cached?.id),
      createdAt: cached?.createdAt,
      modifiedAt: cached?.modifiedAt
    }
  }

  protected buildSnapshotPayload(
    cached: NoteMetadata,
    clock: VectorClock,
    operation: 'create' | 'update',
    date: string
  ): JournalSyncPayload {
    let content: string | null = null
    let tags: string[] = []
    let properties: Record<string, unknown> | null = null
    try {
      const raw = readJournalTextSync(date)
      if (raw === null) throw new Error(`Journal file is missing: ${date}`)
      const parsed = parseJournalEntry(raw, date)
      content = operation === 'create' ? parsed.content : null
      tags = parsed.frontmatter.tags ?? []
      properties = extractJournalProperties(parsed.frontmatter) ?? null
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
