import type { ReadwiseErrorKind, ReadwiseStatusResult } from '@memry/contracts/import-channels'

/**
 * What the Readwise row and panel show (#1418). One derivation, so the row
 * and the panel's banner never disagree.
 */
export type ReadwiseState =
  | { kind: 'not-connected' }
  | { kind: 'other-device'; deviceName: string | null }
  | { kind: 'waiting-for-sync' }
  | { kind: 'syncing'; planned: number | null; done: number }
  | { kind: 'error'; error: ReadwiseErrorKind; detail: string | null }
  | { kind: 'synced'; at: string }
  | { kind: 'connected' }

export function deriveReadwiseState(status: ReadwiseStatusResult | null): ReadwiseState {
  if (!status) return { kind: 'not-connected' }
  // The token stays on the pulling device, so this device is never "connected" here.
  if (!status.thisDevicePulls) return { kind: 'other-device', deviceName: status.pullingDeviceName }
  if (!status.connected) return { kind: 'not-connected' }
  if (status.syncing) {
    return status.syncing.stage === 'waiting-for-sync'
      ? { kind: 'waiting-for-sync' }
      : { kind: 'syncing', planned: status.syncing.planned, done: status.syncing.done }
  }
  if (status.error) {
    return { kind: 'error', error: status.error.kind, detail: status.error.detail }
  }
  if (status.lastSyncAt) return { kind: 'synced', at: status.lastSyncAt }
  return { kind: 'connected' }
}
