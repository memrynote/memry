import * as BackgroundTask from 'expo-background-task'
import * as TaskManager from 'expo-task-manager'
import { AppState } from 'react-native'
import { getEditorSession } from '../editor/session'
import { createLogger } from '../lib/logger'
import { createMobileHttpClient } from '../adapters/http-client'
import { getSyncEngine } from './engine'
import { syncBaseUrl } from './server-config'

const log = createLogger('BackgroundSync')

const TASK_NAME = 'memry-background-sync'

let activeVaultId: string | null = null

export function setBackgroundSyncVault(vaultId: string | null): void {
  activeVaultId = vaultId
}

/**
 * T052: foreground sync triggers + BGAppRefreshTask via expo-background-task.
 * The task is resumable and interruptible by construction: each pull page is
 * durable before the cursor advances, so the OS killing the task mid-run
 * costs at most the in-flight page.
 */
TaskManager.defineTask(TASK_NAME, async () => {
  if (!activeVaultId) return BackgroundTask.BackgroundTaskResult.Success
  try {
    // Push before pull: the queued edits are the only data that exists nowhere
    // else, and a background window the OS cuts short should spend itself on
    // those rather than on refreshing what is already safe on the server.
    await drainOutbox(activeVaultId)
    const summary = await getSyncEngine(activeVaultId).sync()
    log.info('Background sync pass finished', {
      ok: summary.ok,
      itemsApplied: summary.itemsApplied
    })
    return BackgroundTask.BackgroundTaskResult.Success
  } catch (err) {
    log.warn('Background sync pass failed', {
      error: err instanceof Error ? err.message : String(err)
    })
    return BackgroundTask.BackgroundTaskResult.Failed
  }
})

export async function registerBackgroundSync(minIntervalMinutes = 15): Promise<void> {
  try {
    await BackgroundTask.registerTaskAsync(TASK_NAME, {
      minimumInterval: minIntervalMinutes
    })
    log.info('Background sync task registered')
  } catch (err) {
    log.warn('Background task registration failed', {
      error: err instanceof Error ? err.message : String(err)
    })
  }
}

/**
 * Drain the write queue (T063/T076). Failures are logged, never thrown: a
 * drain that rejects into an AppState listener is an unhandled rejection, and
 * the rows it could not send are still queued for the next pass.
 */
export async function drainOutbox(vaultId: string): Promise<void> {
  try {
    const session = await getEditorSession(vaultId)
    await session.flush()
  } catch (err) {
    log.warn('Outbox drain failed', {
      error: err instanceof Error ? err.message : String(err)
    })
  }
}

let foregroundWired = false

/**
 * App-state transitions drive both directions of sync.
 *
 * Foreground: drain first, then pull — an edit made offline should leave the
 * device before the pull has a chance to hand the user a stale-looking screen.
 * Background: drain only, and immediately, because iOS may suspend the process
 * at any point after the transition (contract rule 5).
 */
export function wireForegroundSync(): void {
  if (foregroundWired) return
  foregroundWired = true
  let previous = AppState.currentState
  AppState.addEventListener('change', (next) => {
    const vaultId = activeVaultId
    if (!vaultId) {
      previous = next
      return
    }
    if (next === 'active' && previous !== 'active') {
      void drainOutbox(vaultId).then(() =>
        getSyncEngine(vaultId)
          .sync()
          .catch(() => {})
      )
    } else if (next !== 'active' && previous === 'active') {
      void drainOutbox(vaultId)
    }
    previous = next
  })

  wireOnlineDrain()
}

/**
 * Coming back online has to PUSH, not just pull.
 *
 * The engine already reacts to the transition, and it calls `sync()` — a pull.
 * Nothing drained the outbox, so edits made offline sat in the queue with
 * `attempt_count` still 0 until the app happened to be backgrounded and
 * foregrounded again. On a device that never leaves the foreground, "your
 * changes send themselves once you reconnect" was simply not true, and the
 * banner counted up while the queue was never once tried.
 *
 * Unlike the engine's handler this does NOT skip the first emission. The
 * engine skips it because syncing on subscribe raced the windowed first sync
 * over the shared record cursor; a drain touches neither, and skipping it here
 * would leave the commonest case unhandled — an app launched with a queue
 * already full, which is exactly what a relaunch after an offline session is.
 */
let onlineDrainWired = false

function wireOnlineDrain(): void {
  if (onlineDrainWired) return
  onlineDrainWired = true
  let draining = false
  createMobileHttpClient(syncBaseUrl()).onOnlineChanged((online) => {
    const vaultId = activeVaultId
    // `draining` is not an optimisation: the switch and NetInfo can both emit
    // for one transition, and two concurrent drains would send the same rows
    // twice and race each other's deletes.
    if (!online || !vaultId || draining) return
    draining = true
    void drainOutbox(vaultId).finally(() => {
      draining = false
    })
  })
}
