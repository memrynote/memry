import type { ReadwiseStatusResult } from '@memry/contracts/import-channels'
import { getDatabase } from '../database'
import { getMainI18n } from '../lib/main-i18n'
import { getStatus } from '../vault'
import { createLogger } from '../lib/logger'
import { ReadwiseError, verifyToken } from './client'
import { clearClaim, readClaim } from './claim'
import { claimThisDevice, pullAuthority, readPullEnv, ReadwisePullGateError } from './pull-gate'
import { deleteReadwiseToken, getReadwiseToken, setReadwiseToken } from './secrets'
import {
  getReadwiseScheduler,
  ReadwiseRunInProgressError,
  ReadwiseUnavailableError
} from './runtime-effects'
import { readReadwiseOptions } from './settings'
import { clearRunState, getCursor, getLastRun, setLastRun } from './sync-state'

const log = createLogger('ReadwiseConnection')

function requireVaultPath(): string {
  const { path: vaultPath } = getStatus()
  if (!vaultPath) throw new Error(getMainI18n().t('errors:ipc.noVaultOpen'))
  return vaultPath
}

/** The user-facing text for a Readwise failure, or null when `err` is not one. */
export function describeReadwiseError(err: unknown): string | null {
  const t = getMainI18n().t
  if (err instanceof ReadwisePullGateError) {
    if (err.code === 'elsewhere') {
      return t('errors:importer.readwiseSyncsOnDevice', {
        device: err.deviceName ?? t('errors:importer.readwiseAnotherDevice')
      })
    }
    if (err.code === 'needs-sync') return t('errors:importer.readwiseNeedsSync')
    if (err.code === 'claim-not-delivered') return t('errors:importer.readwiseClaimNotDelivered')
    return t('errors:importer.readwiseNotReady')
  }
  if (!(err instanceof ReadwiseError)) return null
  if (err.code === 'invalid-token') return t('errors:importer.readwiseInvalidToken')
  if (err.code === 'rate-limited') return t('errors:importer.readwiseRateLimited')
  return t('errors:importer.readwiseUnreachable')
}

/** For an IPC handler: a pull-gate failure reaches the user as its sentence, not its code. */
export function withUserMessage<T>(work: Promise<T>): Promise<T> {
  return work.catch((err: unknown) => {
    const message = err instanceof ReadwisePullGateError ? describeReadwiseError(err) : null
    throw message === null ? err : new Error(message, { cause: err })
  })
}

export async function getReadwiseStatus(): Promise<ReadwiseStatusResult> {
  const vaultPath = requireVaultPath()
  const db = getDatabase()
  const connected = (await getReadwiseToken(vaultPath)) !== null
  const lastRun = connected ? getLastRun(db) : null
  const authority = pullAuthority(db)
  return {
    connected,
    options: readReadwiseOptions(db),
    lastSyncAt: lastRun?.at ?? null,
    needsAttention: lastRun?.needsAttention ?? false,
    hasImported: getCursor(db) !== null,
    thisDevicePulls: authority.state !== 'elsewhere',
    pullingDeviceName: authority.state === 'elsewhere' ? authority.deviceName : null
  }
}

/** The check runs before anything is stored, so a bad token leaves no trace (D2). */
async function verifyPastedToken(token: string): Promise<void> {
  try {
    await verifyToken(token.trim())
  } catch (err) {
    const message = describeReadwiseError(err)
    if (message === null) throw err
    throw new Error(message)
  }
}

export async function connectReadwise(token: string): Promise<ReadwiseStatusResult> {
  const vaultPath = requireVaultPath()
  const db = getDatabase()
  const authority = pullAuthority(db)
  // Another device pulls: this one takes over instead of connecting beside it (D8).
  if (authority.state === 'elsewhere') {
    throw new ReadwisePullGateError('elsewhere', authority.deviceName)
  }
  await verifyPastedToken(token)
  await setReadwiseToken(vaultPath, token)
  // A fresh token ends "needs attention", so the schedule starts again.
  const lastRun = getLastRun(db)
  if (lastRun?.needsAttention) setLastRun(db, { ...lastRun, needsAttention: false })
  if (authority.state === 'claim-needed') {
    try {
      await claimThisDevice(db)
    } catch (err) {
      // The first run claims it once sync can deliver the claim.
      log.warn('Readwise connected, but the claim waits for sync', err)
    }
  }
  return await getReadwiseStatus()
}

/**
 * "Sync on this device instead" (D8). The token never travels between devices
 * (D2), so it is asked for again. The claim goes first and the call waits until
 * it reached the server, so the old device stops before this one reads
 * anything. Nothing is written until sync is caught up and online. Then the
 * token and a clean run state: the first run is a full export that adopts the
 * notes by `readwise_url`.
 */
export async function takeOverReadwise(token: string): Promise<ReadwiseStatusResult> {
  const vaultPath = requireVaultPath()
  const db = getDatabase()
  const env = readPullEnv(db)
  if (!env.decided || !env.eligible) throw new ReadwisePullGateError('needs-sync')
  await verifyPastedToken(token)
  await claimThisDevice(db)
  await setReadwiseToken(vaultPath, token)
  clearRunState(db)
  return await getReadwiseStatus()
}

/** Deletes the token and the run state. Every note stays (D9). */
export async function disconnectReadwise(): Promise<void> {
  const vaultPath = requireVaultPath()
  await deleteReadwiseToken(vaultPath)
  const db = getDatabase()
  clearRunState(db)
  // Only the pulling device's disconnect frees Readwise. The next device the
  // user connects claims (D8).
  if (readClaim(db).deviceId === readPullEnv(db).deviceId) clearClaim(db)
}

/** Runs now, or joins the scheduler's run, and resolves when it completes. */
export async function syncReadwiseNow(): Promise<void> {
  try {
    await getReadwiseScheduler().syncNow()
  } catch (err) {
    const t = getMainI18n().t
    if (err instanceof ReadwiseRunInProgressError) {
      throw new Error(t('errors:importer.readwiseRunInProgress'))
    }
    if (err instanceof ReadwiseUnavailableError) {
      throw new Error(
        err.reason === 'not-connected'
          ? t('errors:importer.readwiseNotConnected')
          : t('errors:importer.readwiseRunUnavailable')
      )
    }
    const message = describeReadwiseError(err)
    if (message === null) throw err
    throw new Error(message, { cause: err })
  }
}
