import { createLogger } from '../../lib/logger'
import { requireDatabase } from '../../database'
import { isMemryUserSignedIn } from '../../sync/auth-state'
import { hasGoogleCalendarConnection } from './oauth'
import { listCalendarSources } from '../repositories/calendar-sources-repository'
import { getGooglePushRuntime, getOrInitGooglePushRuntime } from './push-runtime'
import { syncGoogleCalendarNow } from './sync-service'

const log = createLogger('Calendar:GoogleSyncRunner')

const RUN_INTERVAL_MS = 5 * 60 * 1000
export const PUSH_BACKOFF_INTERVAL_MS = 30 * 60 * 1000

let syncInterval: NodeJS.Timeout | null = null
let currentPollIntervalMs = RUN_INTERVAL_MS

export function getCurrentPollIntervalMs(): number {
  return currentPollIntervalMs
}

function runPeriodicSync(): void {
  void syncGoogleCalendarNow().catch((error) => {
    log.warn('periodic Google Calendar sync failed', error)
  })
}

export function reEvaluatePollCadence(activeChannelCount: number): void {
  const target = activeChannelCount > 0 ? PUSH_BACKOFF_INTERVAL_MS : RUN_INTERVAL_MS
  if (target === currentPollIntervalMs) return
  currentPollIntervalMs = target
  if (!syncInterval) return
  clearInterval(syncInterval)
  syncInterval = setInterval(runPeriodicSync, target)
}

export async function startGoogleCalendarSyncRunner(): Promise<void> {
  if (syncInterval) return
  if (!(await isMemryUserSignedIn())) return
  if (!(await hasGoogleCalendarConnection(requireDatabase()))) return

  void syncGoogleCalendarNow().catch((error) => {
    log.warn('initial Google Calendar sync failed', error)
  })

  syncInterval = setInterval(runPeriodicSync, currentPollIntervalMs)

  const pushRuntime = getOrInitGooglePushRuntime({
    onActiveCountChange: (count) => reEvaluatePollCadence(count)
  })
  if (pushRuntime) {
    const db = requireDatabase()
    const sources = listCalendarSources(db, {
      provider: 'google',
      kind: 'calendar',
      selectedOnly: true
    }).map((s) => ({
      id: s.id,
      remoteId: s.remoteId,
      isMemryManaged: s.isMemryManaged
    }))
    void pushRuntime.ensureForSelectedSources(sources).catch((err) => {
      log.warn('ensureForSelectedSources failed', err)
    })
  }
}

export function stopGoogleCalendarSyncRunner(): void {
  if (!syncInterval) return
  clearInterval(syncInterval)
  syncInterval = null

  const pushRuntime = getGooglePushRuntime()
  if (pushRuntime) {
    void pushRuntime.stopAll().catch((err) => {
      log.warn('stopAll failed', err)
    })
  }
}
