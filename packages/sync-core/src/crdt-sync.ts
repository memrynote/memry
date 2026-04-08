import type { SyncItemType } from '@memry/contracts/sync-api'

export interface CrdtSyncAdapter {
  readonly type: SyncItemType
  readonly kind: 'crdt'
  readonly documentContentOnly: boolean
}

export function createCrdtSyncAdapter(
  type: SyncItemType,
  options?: { documentContentOnly?: boolean }
): CrdtSyncAdapter {
  return {
    type,
    kind: 'crdt',
    documentContentOnly: options?.documentContentOnly ?? false
  }
}
