/**
 * Keeps text a pulled delete would erase unseen (#3029).
 *
 * Another device deleted a note or journal day while this device held text it
 * never received. Delete still wins (chapter 05 §5.8), but before the handler
 * removes the row, doc and file, that text is saved as a new inbox note with a
 * fresh id. `keepsUnseenText` decides; this module gathers its facts and
 * writes the copy.
 *
 * The copy is written on the pull's page db, so it commits or rolls back with
 * the delete. A delete that arrives again finds no row and never reaches here,
 * which keeps the copy to one.
 *
 * @module sync/keep-unseen-text
 */

import fs from 'fs'
import { inboxItems } from '@memry/db-schema/schema/inbox'
import { InboxChannels } from '@memry/contracts/ipc-channels'
import type { VectorClock } from '@memry/contracts/sync-api'
import { keepsUnseenText } from '@memry/sync-client/delete-keep'
import type { ApplyContext } from '@memry/sync-client/item-handlers/types'
import type { DataDb } from '../database/types'
import { syncInboxCreate } from '../inbox/runtime-effects'
import { generateId } from '../lib/id'
import { parseNote } from '../vault/frontmatter'
import { createLogger } from '../lib/logger'
import { readLocalBodyFacts } from './note-sync-state'

const log = createLogger('KeepUnseenText')

export interface UnseenTextDelete {
  itemId: string
  /** Title of the inbox copy. */
  title: string
  localClock: VectorClock | null
  tombstoneClock: VectorClock | undefined
  deletedAt: number | undefined
  /** The item's markdown body, read only when a copy may be needed. */
  readBody: () => string | null
}

/** A markdown note's body, without its frontmatter. Null when it cannot be read. */
export function readNoteFileBody(absolutePath: string): string | null {
  try {
    return parseNote(fs.readFileSync(absolutePath, 'utf-8')).content
  } catch (error) {
    log.warn('Could not read a note file before a remote delete', { error })
    return null
  }
}

export function keepUnseenText(ctx: ApplyContext, del: UnseenTextDelete): void {
  const facts = readLocalBodyFacts(ctx.db as DataDb, del.itemId)
  const decide = (bodyBlank: boolean): boolean =>
    keepsUnseenText({
      bodyBlank,
      waitingChanges: facts.waiting,
      localClock: del.localClock,
      tombstoneClock: del.tombstoneClock ?? null,
      deletedAt: del.deletedAt ?? null,
      lastLocalBodyAt: facts.confirmedAt
    })
  if (!decide(false)) return
  const body = del.readBody()
  if (!body || !decide(body.trim() === '')) return

  const id = generateId()
  const now = new Date().toISOString()
  ctx.db
    .insert(inboxItems)
    .values({
      id,
      type: 'note',
      title: del.title,
      content: body,
      createdAt: now,
      modifiedAt: now,
      processingStatus: 'complete'
    })
    .run()
  syncInboxCreate(id)
  ctx.emit(InboxChannels.events.CAPTURED, { id })
  log.info('Kept unseen text of a remotely deleted item in the inbox', {
    itemId: del.itemId,
    inboxId: id
  })
}
