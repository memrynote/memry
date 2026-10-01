// Main-process event-loop stall detector (#2556). A Linux AppImage froze on
// every launch and left nothing in main.log to say what the main process was
// doing: the launch timeline only reports at window reveal, and a blocked loop
// never gets there. A fixed-interval tick that fires late means the loop was
// blocked for the difference (sync sqlite, sync fs, a synchronous safeStorage
// call waiting on the keyring). Each stall is logged once it ends, at warn so
// it reaches the diagnostic log sink, with the launch phase it interrupted.
import { powerMonitor } from 'electron'

import { latestLaunchPhase } from './launch-timeline'
import { createLogger } from './lib/logger'

const logger = createLogger('MainThreadStall')

export const STALL_TICK_MS = 1_000
export const STALL_THRESHOLD_MS = 2_000
// A loop that keeps stalling would otherwise write a line per tick for the
// whole run; the first ones are the ones that explain it.
export const MAX_STALL_REPORTS = 20

/**
 * Start the stall detector. Returns the stop function. The tick is unref'd so
 * it never keeps the process alive on quit.
 */
export function startMainThreadStallMonitor(): () => void {
  let lastTickAt = Date.now()
  let reports = 0
  // System sleep stops the loop too, so the first tick after wake reads as a
  // stall as long as the sleep. Ticks between suspend and resume never report
  // (the wake tick can run before the resume event), and resume re-arms.
  let suspended = false
  const onSuspend = (): void => {
    suspended = true
  }
  const onResume = (): void => {
    suspended = false
    lastTickAt = Date.now()
  }

  const timer = setInterval(() => {
    const now = Date.now()
    const stallMs = now - lastTickAt - STALL_TICK_MS
    lastTickAt = now
    if (suspended || stallMs < STALL_THRESHOLD_MS || reports >= MAX_STALL_REPORTS) return
    reports += 1
    logger.warn('main thread stalled', {
      durationMs: stallMs,
      phase: latestLaunchPhase() ?? 'startup',
      count: reports
    })
  }, STALL_TICK_MS)
  timer.unref?.()

  try {
    powerMonitor.on('suspend', onSuspend)
    powerMonitor.on('resume', onResume)
  } catch (err) {
    logger.warn('powerMonitor unavailable; sleep may read as a stall', { error: err })
  }

  return () => {
    clearInterval(timer)
    try {
      powerMonitor.removeListener('suspend', onSuspend)
      powerMonitor.removeListener('resume', onResume)
    } catch {
      /* listeners were never attached */
    }
  }
}
