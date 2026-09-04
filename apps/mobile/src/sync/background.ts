import * as BackgroundTask from 'expo-background-task'
import * as TaskManager from 'expo-task-manager'
import { AppState } from 'react-native'
import { createLogger } from '../lib/logger'
import { createMobileHttpClient } from '../adapters/http-client'
import { syncBaseUrl } from './server-config'
import { startSyncSocket, stopSyncSocket } from './socket-controller'
import { requestVaultSync } from './triggers'

const log = createLogger('BackgroundSync')

const TASK_NAME = 'memry-background-sync'

let activeVaultId: string | null = null

export function setBackgroundSyncVault(vaultId: string | null): void {
  activeVaultId = vaultId
}

export { drainOutbox } from './triggers'

/**
 * T052: foreground sync triggers + BGAppRefreshTask via expo-background-task.
 * The task is resumable and interruptible by construction: each pull page is
 * durable before the cursor advances, so the OS killing the task mid-run
 * costs at most the in-flight page.
 */
TaskManager.defineTask(TASK_NAME, async () => {
  if (!activeVaultId) return BackgroundTask.BackgroundTaskResult.Success
  try {
    await requestVaultSync(activeVaultId, 'background-task')
    log.info('Background sync pass finished')
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

let foregroundWired = false

/**
 * App-state transitions drive both directions of sync, and the socket's
 * lifetime with them.
 *
 * The socket is the live loop; these edges are what start and stop it. It is
 * closed DELIBERATELY on the way out, because a close the OS delivers when it
 * suspends the process is indistinguishable from a network failure, and the
 * manager would arm its backoff and burn handshake attempts against a shared
 * per-user budget on an app nobody is looking at.
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
      startSyncSocket(vaultId)
      void requestVaultSync(vaultId, 'app-foreground')
    } else if (next !== 'active' && previous === 'active') {
      stopSyncSocket()
      void requestVaultSync(vaultId, 'app-background')
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
  createMobileHttpClient(syncBaseUrl()).onOnlineChanged((online) => {
    const vaultId = activeVaultId
    if (!online || !vaultId) return
    // Two concurrent drains would send the same rows twice, and the switch and
    // NetInfo can both emit for one transition. `OutboxDrain` coalesces them
    // itself with a running pass plus at most one trailing pass, which is why
    // the local `draining` flag this used to keep is gone.
    startSyncSocket(vaultId)
    void requestVaultSync(vaultId, 'online')
  })
}
