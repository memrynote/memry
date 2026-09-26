import type { SyncItemType } from '@memry/contracts/sync-api'
import { withIncrementedClock } from '@memry/sync-core'
import { createLogger } from '../../lib/logger'
import { decryptPullBatch } from '../sync-crypto-batch'
import { getHandler } from '../item-handlers'
import type { SyncContext } from './sync-context'
import type { CorruptItemTracker } from './corrupt-item-tracker'
import type { SchemaInvalidLedger } from './schema-invalid-ledger'
import { itemRefKey } from './sync-context'
import { PendingSyncIntentError } from '../pending-sync-intent-error'

const log = createLogger('OrphanRepair')

type DecryptedPullItem = Awaited<ReturnType<typeof decryptPullBatch>>['decrypted'][number]

export interface OrphanRef {
  item: DecryptedPullItem
  parentType: string
  parentId: string
}

export interface OrphanRepairParams {
  orphans: OrphanRef[]
  ctx: SyncContext
  corruptTracker: CorruptItemTracker
  schemaInvalid: SchemaInvalidLedger
  accessJwt: string
  vaultKey: Uint8Array
  /** Applies the item and does the run bookkeeping; throws if it still fails. */
  applyItem: (item: DecryptedPullItem) => void
}

function parentExistsLocally(ctx: SyncContext, parentType: string, parentId: string): boolean {
  const handler = getHandler(parentType as SyncItemType)
  if (!handler) return false
  try {
    return handler.fetchLocal(ctx.deps.db, parentId) !== undefined
  } catch {
    return false
  }
}

/**
 * Resolve items left unwritable by a missing FK parent.
 *
 * A cascade delete is invisible to sync: deleting a project removes its tasks
 * locally via SQLite `ON DELETE cascade`, but only the project is tombstoned on
 * the server. The child rows stay alive up there forever, so every device
 * re-pulls them, fails the FK insert, skips them, sees them as server-only in
 * the next manifest check, and re-pulls again — an endless loop (#837).
 *
 * The parent is re-fetched by id, which is authoritative in a way the pull
 * cursor window is not:
 * - server still has it → apply the parent, then the child lands normally.
 * - server positively says it is gone (requested and no live row served, or
 *   its delete applied here) → the parent is gone everywhere, so the child is
 *   a confirmed orphan. Tombstone it, which is what the cascade should have
 *   pushed in the first place, and the loop ends on every device.
 * - no answer (re-fetch cooldown, lost blob, a payload this build refuses) →
 *   keep the child for a later run.
 */
export async function repairOrphans(
  params: OrphanRepairParams
): Promise<{ repaired: number; tombstoned: number }> {
  const { orphans, ctx, corruptTracker, schemaInvalid, accessJwt, vaultKey, applyItem } = params
  if (orphans.length === 0) return { repaired: 0, tombstoned: 0 }

  const parentRefs = Array.from(
    new Map(orphans.map((o) => [itemRefKey(o.parentType, o.parentId), o])).values()
  ).map((o) => ({ id: o.parentId, type: o.parentType }))

  log.info('Repairing items with a missing FK parent', {
    orphanCount: orphans.length,
    parentCount: parentRefs.length
  })

  corruptTracker.clearExpired()
  const { recovered, invalid, blobMissing, missing, skipped } = await corruptTracker.refetch(
    parentRefs,
    accessJwt,
    vaultKey
  )
  schemaInvalid.record(invalid, 'envelope')
  schemaInvalid.record(blobMissing, 'blob_missing')

  // A child is tombstoned only on a positive "gone" answer for its parent: the
  // parent was requested and the server holds no live row for it, or its
  // delete (signed, or an admitted purged tombstone) was just applied here.
  // Everything else is unknown and keeps the child: a live parent this build
  // cannot apply (#2285), a lost parent blob or one on the re-fetch cooldown
  // (#2302), which a later run answers. Tombstoning on "not returned" pushed
  // the child's delete to every device, the newer one that wrote it included.
  const goneOnServer = new Set(missing.map((ref) => itemRefKey(ref.type, ref.id)))

  for (const parent of recovered) {
    try {
      const result = ctx.applier.apply({
        itemId: parent.id,
        type: parent.type as Parameters<typeof ctx.applier.apply>[0]['type'],
        operation: parent.deletedAt ? 'delete' : (parent.operation as 'create' | 'update'),
        content: new TextEncoder().encode(parent.content),
        clock: parent.clock,
        deletedAt: parent.deletedAt,
        vaultKey
      })
      if (result === 'schema_invalid') schemaInvalid.record([parent], 'payload')
      if (parent.deletedAt && result === 'applied') {
        goneOnServer.add(itemRefKey(parent.type, parent.id))
      }
    } catch (err) {
      // The parent waits on this device's own sync intent (#2301): the ledger
      // re-fetches it after the next pull-start drain.
      if (err instanceof PendingSyncIntentError) schemaInvalid.record([parent], 'pending_intent')
      log.warn('Failed to apply refetched FK parent', {
        itemId: parent.id,
        type: parent.type,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }
  if (skipped.length > 0) {
    log.info('FK parents with no answer this run; their children are kept', {
      count: skipped.length
    })
  }

  // Only needed if something actually turns out to be a confirmed orphan, but
  // resolved once here rather than per item: it is a keychain read.
  let tombstoneDeviceId: string | null | undefined

  let repaired = 0
  let tombstoned = 0

  for (const orphan of orphans) {
    if (parentExistsLocally(ctx, orphan.parentType, orphan.parentId)) {
      try {
        applyItem(orphan.item)
        repaired++
      } catch (err) {
        if (err instanceof PendingSyncIntentError) {
          schemaInvalid.record([orphan.item], 'pending_intent')
          continue
        }
        log.warn('Orphan still failed after its parent was restored', {
          itemId: orphan.item.id,
          type: orphan.item.type,
          error: err instanceof Error ? err.message : String(err)
        })
      }
      continue
    }

    if (
      !goneOnServer.has(itemRefKey(orphan.parentType, orphan.parentId)) ||
      schemaInvalid.has(orphan.parentType, orphan.parentId)
    ) {
      log.warn('FK parent not confirmed gone; keeping the child', {
        itemId: orphan.item.id,
        type: orphan.item.type,
        parentType: orphan.parentType
      })
      continue
    }

    // Parent confirmed absent locally AND confirmed gone on the server. The
    // child can never be written, so stop the re-pull loop at its source by
    // tombstoning it server-side for every device.
    //
    // The clock has to be advanced first. `orphan.item.content` is what this
    // device just pulled, so its clock is the server's OWN clock for that row,
    // and the server rejects any push whose clock has no entry greater than what
    // it already holds (`detectReplay` in services/sync.ts). Sent back unchanged
    // the tombstone came home as SYNC_REPLAY_DETECTED, the queue row was cleared
    // as "already applied", the next pull served the same orphan again, and this
    // repair ran again — the loop it exists to end, running forever. Seven tasks
    // sat in it for hours on a real device.
    //
    // A normal delete does not need this: it is built from a local row by the
    // domain layer, which stamps the clock on the way out. This one has no local
    // row — that is what being an orphan means — so nothing stamped it, and the
    // push path leaves `delete` payloads verbatim by design.
    if (tombstoneDeviceId === undefined) {
      tombstoneDeviceId = (await ctx.deps.getSigningKeys())?.deviceId ?? null
    }
    if (!tombstoneDeviceId) {
      // Without a device id the tombstone would be a replay again. Leave the
      // orphan for the next pull rather than burn a push proving that.
      log.warn('Cannot tombstone orphaned item without a device id', {
        itemId: orphan.item.id,
        type: orphan.item.type
      })
      continue
    }

    ctx.deps.queue.enqueue({
      type: orphan.item.type as SyncItemType,
      itemId: orphan.item.id,
      operation: 'delete',
      payload: withIncrementedClock(orphan.item.content, tombstoneDeviceId),
      priority: 0
    })
    tombstoned++
    log.warn('FK parent gone server-side — tombstoning orphaned item', {
      itemId: orphan.item.id,
      type: orphan.item.type,
      parentType: orphan.parentType,
      parentId: orphan.parentId
    })
  }

  log.info('Orphan repair complete', { repaired, tombstoned })
  if (tombstoned > 0) ctx.requestPush()

  return { repaired, tombstoned }
}
