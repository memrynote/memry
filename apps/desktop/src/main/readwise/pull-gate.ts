import { getCurrentDeviceId } from '@memry/sync-client/current-device-id'
import {
  hasCompletedPullSinceStart,
  isSyncDecided,
  isSyncEligible
} from '@memry/sync-client/sync-eligibility'
import { getDatabase } from '../database'
import type { DataDb } from '../database/types'
import { createLogger } from '../lib/logger'
import { sleep } from './client'
import { readClaim, readCurrentDeviceName, writeClaim } from './claim'

const log = createLogger('Readwise:PullGate')

/**
 * Who pulls from Readwise (#1408 D8). Notes ride memry sync and a write
 * replaces the whole body, so two devices pulling, or a device pulling before
 * it holds the others' notes, duplicates books. This is the one gate. The
 * scheduler (#1416) asks `canPull()` before it starts a run, and the run
 * engine awaits `awaitPullAuthority` itself, so a run started anywhere else (the
 * import dialog) is held to the same rule.
 */
export type PullAuthority =
  | { state: 'pull' }
  /** Sync's verdict or its first pull is not in yet. Ask again later. */
  | { state: 'wait' }
  /** Sync is on and nobody claims Readwise. The first run claims it. */
  | { state: 'claim-needed' }
  | { state: 'elsewhere'; deviceName: string | null }

export interface PullEnv {
  /** The sync runtime reached a verdict for the open vault. */
  decided: boolean
  /** Memry sync runs on this install. */
  eligible: boolean
  /** A memry sync pull completed since the runtime started. */
  pulled: boolean
  /** The registered sync device id, null before registration. */
  deviceId: string | null
}

export function readPullEnv(db: DataDb): PullEnv {
  return {
    decided: isSyncDecided(),
    eligible: isSyncEligible(),
    pulled: hasCompletedPullSinceStart(),
    deviceId: getCurrentDeviceId(db)
  }
}

export function pullAuthority(db: DataDb, env: PullEnv = readPullEnv(db)): PullAuthority {
  if (!env.decided) return { state: 'wait' }
  // Sync off: no peer to race, so no claim, and this device pulls.
  if (!env.eligible) return { state: 'pull' }
  if (env.deviceId === null) return { state: 'wait' }
  const claim = readClaim(db)
  if (claim.deviceId !== null && claim.deviceId !== env.deviceId) {
    return { state: 'elsewhere', deviceName: claim.deviceName }
  }
  if (!env.pulled) return { state: 'wait' }
  return { state: claim.deviceId === null ? 'claim-needed' : 'pull' }
}

/** True when a run may start now. The seam #1416's scheduler gates on. */
export function canPull(): boolean {
  let db: DataDb
  try {
    db = getDatabase()
  } catch {
    return false
  }
  const { state } = pullAuthority(db)
  return state === 'pull' || state === 'claim-needed'
}

/** True once another device holds the claim, which is when this one must stop. */
export function claimLostToAnotherDevice(): boolean {
  let db: DataDb
  try {
    db = getDatabase()
  } catch {
    return false
  }
  const { eligible, deviceId } = readPullEnv(db)
  const claim = readClaim(db).deviceId
  return eligible && deviceId !== null && claim !== null && claim !== deviceId
}

export type PullGateErrorCode = 'elsewhere' | 'not-ready' | 'needs-sync' | 'claim-not-delivered'

/** A run or takeover that sync's state does not allow. The message is for logs only. */
export class ReadwisePullGateError extends Error {
  constructor(
    readonly code: PullGateErrorCode,
    readonly deviceName: string | null = null
  ) {
    super(`Readwise pull gate: ${code}`)
    this.name = 'ReadwisePullGateError'
  }
}

const POLL_MS = 500
const READY_TIMEOUT_MS = 2 * 60_000
const PUSH_TIMEOUT_MS = 30_000

interface SyncEngineView {
  isCaughtUpWithServer(): boolean
  requestPush(): void
  hasQueuedItem(itemId: string): boolean
}

async function loadEngine(): Promise<SyncEngineView | null> {
  // Lazy: the sync runtime pulls in the whole sync stack, which the gate needs
  // only to push the claim.
  const { getSyncEngine } = await import('../sync/runtime')
  return getSyncEngine()
}

/**
 * Makes this device the pulling device and returns once the claim reached the
 * server, so the old device sees it before this one reads anything from
 * Readwise. Writes nothing when sync cannot deliver it right now.
 */
export async function claimThisDevice(
  db: DataDb,
  options: { sleepFn?: typeof sleep; signal?: AbortSignal } = {}
): Promise<void> {
  const env = readPullEnv(db)
  const engine = await loadEngine()
  if (!env.eligible || env.deviceId === null || !engine)
    throw new ReadwisePullGateError('needs-sync')
  if (!env.pulled || !engine.isCaughtUpWithServer()) throw new ReadwisePullGateError('not-ready')

  writeClaim(db, { deviceId: env.deviceId, deviceName: readCurrentDeviceName(db) })
  engine.requestPush()
  const wait = options.sleepFn ?? sleep
  for (let waited = 0; engine.hasQueuedItem('synced_settings'); waited += POLL_MS) {
    if (waited >= PUSH_TIMEOUT_MS) throw new ReadwisePullGateError('claim-not-delivered')
    await wait(POLL_MS, options.signal)
  }
}

/**
 * Resolves when this device may pull, claiming Readwise first when sync is on
 * and nobody holds it. Throws when another device pulls, or when sync's first
 * pull does not complete within two minutes (the run is skipped, not failed:
 * the next one tries again).
 */
export async function awaitPullAuthority(
  signal: AbortSignal,
  sleepFn: typeof sleep = sleep
): Promise<void> {
  for (let waited = 0; ; waited += POLL_MS) {
    const authority = pullAuthority(getDatabase())
    if (authority.state === 'pull') return
    if (authority.state === 'elsewhere') {
      throw new ReadwisePullGateError('elsewhere', authority.deviceName)
    }
    if (authority.state === 'claim-needed') {
      await claimThisDevice(getDatabase(), { signal })
      continue
    }
    if (waited >= READY_TIMEOUT_MS) {
      log.info('Readwise run held back: memry sync has not completed a pull yet')
      throw new ReadwisePullGateError('not-ready')
    }
    await sleepFn(POLL_MS, signal)
  }
}
