import { isDatabaseInitialized, requireDatabase } from '../../database'
import { createLogger } from '../../lib/logger'
import { refreshDueIcsCalendars } from './ics-subscriptions'

const log = createLogger('Calendar:IcsRunner')

// Each feed keeps its own refresh interval (15 min to 24 h); this tick only
// decides how late a due feed can be picked up.
const TICK_MS = 5 * 60 * 1000

let timer: NodeJS.Timeout | null = null
let tickInFlight = false

async function tick(): Promise<void> {
  if (tickInFlight || !isDatabaseInitialized()) return
  tickInFlight = true
  try {
    await refreshDueIcsCalendars(requireDatabase())
  } catch (error) {
    log.warn('Calendar feed refresh pass failed', error)
  } finally {
    tickInFlight = false
  }
}

/** Runs without a Memry account: a feed URL needs no sign-in. No-op without an open vault. */
export function startIcsCalendarRunner(): void {
  if (timer) return
  timer = setInterval(() => void tick(), TICK_MS)
  void tick()
}

export function stopIcsCalendarRunner(): void {
  if (!timer) return
  clearInterval(timer)
  timer = null
}
