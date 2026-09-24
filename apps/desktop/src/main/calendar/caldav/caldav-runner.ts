import { isDatabaseInitialized, requireDatabase } from '../../database'
import { PROVIDER_CAPABILITIES } from '../provider/capabilities'
import { createPollRunner } from '../sync/poll-runner'
import { syncCaldavNow } from './caldav-sync'

// CalDAV has no push (`supportsPush: false`), so this device polls. A server
// that rate-limits pushes the next pass out by what it asked for.
const runner = createPollRunner({
  name: 'CalDAV',
  intervalMs: PROVIDER_CAPABILITIES.caldav.pollIntervalMs ?? 15 * 60 * 1000,
  isReady: isDatabaseInitialized,
  run: async () => {
    const { retryAfterMs } = await syncCaldavNow(requireDatabase())
    return { retryAfterMs }
  }
})

/** Runs without a Memry account: CalDAV talks to the server directly. No-op without an open vault. */
export function startCaldavCalendarRunner(): void {
  runner.start()
}

export function stopCaldavCalendarRunner(): void {
  runner.stop()
}

/** Pull now, outside the schedule (a manual refresh). */
export function triggerCaldavSync(): void {
  runner.trigger()
}
