import fs from 'fs'
import type { VectorClock } from '@memry/contracts/sync-api'
import type { JournalSyncPayload } from '@memry/contracts/sync-payloads'
import type { NoteMetadata } from '@memry/db-schema/data-schema'
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
    // A tombstone deliberately carries NO user-visible data, matching notes.
    // Nothing consumes it: ItemApplier short-circuits `operation === 'delete'`
    // and calls applyDelete(ctx, itemId, clock) without ever decoding the
    // payload bytes, and SyncItemHandler.applyDelete has no data parameter to
    // receive them with. journal-handler.applyDelete resolves the day from the
    // local row (`existing.journalDate`), never from the body. The date was
    // therefore dead weight that still got encrypted and uploaded on every
    // journal delete — and sat in plaintext in the local sync queue until the
    // push drained.
    //
    // Backward compatible in both directions. New sender → old receiver: no
    // shipped build has ever parsed a delete body (the short-circuit is in the
    // first ItemApplier commit, d52dbf875), so the missing field is unreadable
    // either way. Old sender → new receiver: `date` stays accepted, it is only
    // optional now. The `clock` MUST stay —
    // push-coordinator.extractPayloadMetadata lifts it out of this string to
    // stamp the server-side item version, so dropping it would break delete
    // ordering across devices.
    return {
      clock,
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
