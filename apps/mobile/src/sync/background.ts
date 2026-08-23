import * as BackgroundTask from 'expo-background-task'
import * as TaskManager from 'expo-task-manager'
import { AppState } from 'react-native'
import { createLogger } from '../lib/logger'
import { getSyncEngine } from './engine'

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

let foregroundWired = false

/** Foreground transitions trigger an incremental sync pass. */
export function wireForegroundSync(): void {
  if (foregroundWired) return
  foregroundWired = true
  let previous = AppState.currentState
  AppState.addEventListener('change', (next) => {
    if (next === 'active' && previous !== 'active' && activeVaultId) {
      void getSyncEngine(activeVaultId)
        .sync()
        .catch(() => {})
    }
    previous = next
  })
}
