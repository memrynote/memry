import { isDatabaseInitialized, requireDatabase } from '../../database'
import { createLogger } from '../../lib/logger'
import { PROVIDER_CAPABILITIES } from '../provider/capabilities'
import { syncCaldavNow } from './caldav-sync'

const log = createLogger('Calendar:CaldavRunner')

// CalDAV has no push (`supportsPush: false`), so this device polls.
const POLL_MS = PROVIDER_CAPABILITIES.caldav.pollIntervalMs ?? 15 * 60 * 1000

let timer: NodeJS.Timeout | null = null
let tickInFlight = false

async function tick(): Promise<void> {
  if (tickInFlight || !isDatabaseInitialized()) return
  tickInFlight = true
  try {
    await syncCaldavNow(requireDatabase())
  } catch (error) {
    log.warn('CalDAV sync pass failed', error)
  } finally {
    tickInFlight = false
  }
}

/** Runs without a Memry account: CalDAV talks to the server directly. No-op without an open vault. */
export function startCaldavCalendarRunner(): void {
  if (timer) return
  timer = setInterval(() => void tick(), POLL_MS)
  void tick()
}

export function stopCaldavCalendarRunner(): void {
  if (!timer) return
  clearInterval(timer)
  timer = null
}

/** Pull now, outside the schedule (window focus, a manual refresh). */
export function triggerCaldavSync(): void {
  void tick()
}
