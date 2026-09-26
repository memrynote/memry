import type { SyncItemType } from '@memry/contracts/sync-api'
import type { DecryptedPullItem } from '@memry/sync-client/worker-protocol'
import type { ApplyItemInput, ApplyItemResult, ItemApplier } from '../apply-item'
import type { PageApplyHandle } from '../bulk-apply'

export type DecryptedItemOperation = 'create' | 'update' | 'delete'

/**
 * The one mapping from a decrypted `/sync/pull` item to an `ItemApplier`
 * input, shared by pull pages, deferred retries, orphan repair and socket
 * items. A `deletedAt` makes it a delete whatever `operation` says.
 */
export function applyDecryptedItem(
  applier: Pick<ItemApplier, 'apply'>,
  dec: DecryptedPullItem,
  vaultKey: Uint8Array,
  page?: Pick<PageApplyHandle, 'db' | 'afterCommit'>
): { result: ApplyItemResult; operation: DecryptedItemOperation } {
  const operation: DecryptedItemOperation = dec.deletedAt
    ? 'delete'
    : (dec.operation as 'create' | 'update')
  const input: ApplyItemInput = {
    itemId: dec.id,
    type: dec.type as SyncItemType,
    operation,
    content: new TextEncoder().encode(dec.content),
    clock: dec.clock,
    deletedAt: dec.deletedAt,
    vaultKey
  }
  const result = page ? applier.apply(input, page) : applier.apply(input)
  return { result, operation }
}
