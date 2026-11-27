import type { DrizzleDb } from '@memry/sync-client/drizzle-db'
import type { SyncQueueManager } from '@memry/sync-client/queue'
import { createLogger } from '../../lib/logger'
import { isStrayAttachmentNote } from '../../vault/attachments'

const log = createLogger('PushStrayGuard')

/**
 * Removes from the queue, and from `items`, every note record whose row is a
 * stray: a binary row in the attachment store that an older Windows build
 * made of a pasted attachment (#5607). Such a row never leaves this device.
 *
 * Here, at the push, because that holds whatever queued the record: an older
 * build before the upgrade, a recovery pass, an edit of the row. The vault
 * open forgets the rows (`forgetStrayAttachmentRows`), but the sync runtime
 * starts beside that pass, and the pass waits for the next open when the CRDT
 * store is not open.
 */
export function retireStrayAttachmentRecords<
  T extends { id: string; type: string; itemId: string }
>(db: DrizzleDb, queue: Pick<SyncQueueManager, 'removeById'>, items: T[]): T[] {
  return items.filter((item) => {
    if (item.type !== 'note' || !isStrayAttachmentNote(db, item.itemId)) return true
    log.info('Push: retired a queued record of a note made of an attachment file', {
      itemId: item.itemId
    })
    queue.removeById(item.id)
    return false
  })
}
