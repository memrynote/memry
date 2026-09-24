import { isDatabaseInitialized, requireDatabase } from '../../database'
import type { DataDb } from '../../database/types'
import { createLogger } from '../../lib/logger'
import { disposeEventKitBridge, loadEventKitBridge } from './eventkit-loader'
import { appleAccountPermission, getAppleAccount, recordAppleAccountState } from './eventkit-mirror'
import {
  applyApplePermissionLoss,
  runAppleCalendarPass,
  type AppleSyncOutcome
} from './eventkit-sync'
import type { EventKitBridge } from './eventkit-types'

/**
 * Keeps the macOS Calendar mirror current (#2374). macOS only: the caller
 * starts it behind a darwin check and it refuses to start anywhere else.
 *
 * - `EKEventStoreChanged` (debounced) re-reads the window. No relay, no polling
 *   of a server, no Memry account.
 * - A cheap tick re-checks the permission, so a revoke in System Settings
 *   purges the mirror, and re-reads the window every 15 minutes as a safety net.
 * - Nothing runs, and the helper is never spawned, until the user connects.
 */

const log = createLogger('Calendar:EventKitRunner')

const TICK_MS = 60 * 1000
const FULL_READ_MS = 15 * 60 * 1000
const CHANGE_DEBOUNCE_MS = 1500

let timer: NodeJS.Timeout | null = null
let debounce: NodeJS.Timeout | null = null
let watched: { bridge: EventKitBridge; unsubscribe: () => void } | null = null
let passInFlight: Promise<AppleSyncOutcome | null> | null = null
let rerunRequested = false
let lastFullReadAt = 0
/** Bumped on disconnect/shutdown: a pass from an older generation stops and never re-watches. */
let generation = 0

function stopWatching(): void {
  if (debounce) clearTimeout(debounce)
  debounce = null
  watched?.unsubscribe()
  watched = null
}

function watch(bridge: EventKitBridge): void {
  if (watched?.bridge === bridge) return
  stopWatching()
  const unsubscribe = bridge.onChanged(() => {
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => {
      debounce = null
      if (!isDatabaseInitialized()) return
      void requestAppleCalendarPass(requireDatabase())
    }, CHANGE_DEBOUNCE_MS)
  })
  watched = { bridge, unsubscribe }
}

async function onePass(db: DataDb, passGeneration: number): Promise<AppleSyncOutcome | null> {
  if (!getAppleAccount(db)) return null
  const load = await loadEventKitBridge()
  if (passGeneration !== generation) return null
  if (load.status !== 'available') {
    recordAppleAccountState(db, { error: 'unavailable', now: new Date().toISOString() })
    return { ok: false, permission: null, errorCode: 'unavailable' }
  }
  const outcome = await runAppleCalendarPass(db, load.bridge)
  if (passGeneration !== generation) return outcome
  lastFullReadAt = Date.now()
  if (outcome.ok) watch(load.bridge)
  else if (outcome.permission && outcome.permission !== 'full_access') stopWatching()
  return outcome
}

/**
 * Run a full pass now (connect, refresh, a change notification). Passes never
 * overlap: a request during one runs once more after it, and every caller
 * gets the final outcome.
 */
export function requestAppleCalendarPass(db: DataDb): Promise<AppleSyncOutcome | null> {
  if (passInFlight) {
    rerunRequested = true
    return passInFlight
  }
  const passGeneration = generation
  const run = async (): Promise<AppleSyncOutcome | null> => {
    let outcome: AppleSyncOutcome | null = null
    do {
      rerunRequested = false
      outcome = await onePass(db, passGeneration)
    } while (rerunRequested && passGeneration === generation)
    return outcome
  }
  passInFlight = run()
    .catch((error: unknown) => {
      log.warn('macOS Calendar pass crashed', error)
      return null
    })
    .finally(() => {
      passInFlight = null
    })
  return passInFlight
}

/** The periodic check. Exported for tests. */
export async function tickAppleCalendarRunner(db: DataDb): Promise<void> {
  const account = getAppleAccount(db)
  if (!account) {
    stopWatching()
    return
  }
  const tickGeneration = generation
  const load = await loadEventKitBridge()
  if (load.status !== 'available') {
    recordAppleAccountState(db, { error: 'unavailable', now: new Date().toISOString() })
    return
  }
  const permission = await load.bridge.authorizationStatus().catch(() => null)
  // Disconnected while this check waited: leave the new state alone.
  if (tickGeneration !== generation) return
  if (!permission) {
    recordAppleAccountState(db, { error: 'unavailable', now: new Date().toISOString() })
    return
  }
  const previous = appleAccountPermission(account)
  if (permission !== 'full_access') {
    stopWatching()
    if (previous !== permission) applyApplePermissionLoss(db, permission)
    return
  }
  watch(load.bridge)
  if (previous !== 'full_access' || Date.now() - lastFullReadAt >= FULL_READ_MS) {
    await requestAppleCalendarPass(db)
  }
}

async function tick(): Promise<void> {
  if (!isDatabaseInitialized()) return
  try {
    await tickAppleCalendarRunner(requireDatabase())
  } catch (error) {
    log.warn('macOS Calendar check failed', error)
  }
}

export function startAppleCalendarRunner(platform: NodeJS.Platform = process.platform): void {
  if (platform !== 'darwin' || timer) return
  timer = setInterval(() => void tick(), TICK_MS)
  void tick()
}

/** App shutdown: stop checking and watching, and stop the helper. */
export function stopAppleCalendarRunner(): void {
  if (timer) clearInterval(timer)
  timer = null
  void releaseAppleCalendarBridge()
}

/**
 * Disconnect: stop watching and stop the helper, without stopping the tick.
 * Resolves once any pass in flight has ended, so the caller's cleanup runs last.
 */
export async function releaseAppleCalendarBridge(): Promise<void> {
  generation += 1
  stopWatching()
  lastFullReadAt = 0
  await disposeEventKitBridge()
  await passInFlight
}
