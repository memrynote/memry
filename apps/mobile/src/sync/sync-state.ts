import { getMeta, openVaultDb, setMeta, vaultDir } from '../db/index'
import { backoffDelayMs } from './outbox'

const SYNC_STATE_KEY = 'sync.state'

export type SyncFailureReason = 'locked' | 'error' | 'refused'

export interface VaultSyncState {
  lastSuccessAt: number | null
  lastFailure: { reason: SyncFailureReason; at: number } | null
  /** Consecutive failures since the last success. Drives the retry estimate. */
  failureCount: number
}

const EMPTY: VaultSyncState = { lastSuccessAt: null, lastFailure: null, failureCount: 0 }

const FAILURE_REASONS: SyncFailureReason[] = ['locked', 'error', 'refused']

/**
 * Hand-rolled rather than schema-validated: this row is written only by
 * `recordSyncOutcome` below, so the parse exists to survive a shape change
 * across app versions, not to police a foreign payload.
 */
function parse(raw: string | null): VaultSyncState {
  if (!raw) return EMPTY
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return EMPTY
  }
  if (typeof value !== 'object' || value === null) return EMPTY
  const record = value as Record<string, unknown>
  const failure = record.lastFailure as Record<string, unknown> | null | undefined
  return {
    lastSuccessAt: typeof record.lastSuccessAt === 'number' ? record.lastSuccessAt : null,
    lastFailure:
      failure &&
      typeof failure.at === 'number' &&
      FAILURE_REASONS.includes(failure.reason as SyncFailureReason)
        ? { reason: failure.reason as SyncFailureReason, at: failure.at }
        : null,
    failureCount: typeof record.failureCount === 'number' ? record.failureCount : 0
  }
}

/**
 * Whether this device has ever opened the vault.
 *
 * Checked off the directory rather than the database, because `openVaultDb`
 * creates and migrates one — asking the question through it would answer yes
 * for every vault the picker merely listed.
 */
export function isVaultOnThisDevice(vaultId: string): boolean {
  return vaultDir(vaultId).exists
}

export async function readSyncState(vaultId: string): Promise<VaultSyncState | null> {
  if (!isVaultOnThisDevice(vaultId)) return null
  const db = await openVaultDb(vaultId)
  return parse(await getMeta(db, SYNC_STATE_KEY))
}

export async function recordSyncOutcome(
  vaultId: string,
  outcome: { ok: boolean; reason: SyncFailureReason | null }
): Promise<void> {
  const db = await openVaultDb(vaultId)
  const current = parse(await getMeta(db, SYNC_STATE_KEY))
  const at = Date.now()
  const next: VaultSyncState = outcome.ok
    ? { lastSuccessAt: at, lastFailure: null, failureCount: 0 }
    : {
        lastSuccessAt: current.lastSuccessAt,
        lastFailure: { reason: outcome.reason ?? 'error', at },
        failureCount: current.failureCount + 1
      }
  await setMeta(db, SYNC_STATE_KEY, JSON.stringify(next))
}

/** When the next automatic attempt lands, on the outbox's backoff curve. */
export function nextRetryDelayMs(state: VaultSyncState): number {
  return backoffDelayMs(state.failureCount)
}
