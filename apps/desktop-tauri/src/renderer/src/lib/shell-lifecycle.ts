import { useEffect } from 'react'

import { commands } from '../../../generated/bindings'
import { createLogger } from './logger'

const log = createLogger('ShellLifecycle')

/** Matches `BEAT_INTERVAL_MS` in `memry_desktop::shell::heartbeat`. */
export const HEARTBEAT_INTERVAL_MS = 2000

const beat = (): void => {
  commands.shellHeartbeat().catch(() => undefined)
}

/**
 * Tells the shell the app has mounted, so it shows the window, then starts the liveness beat.
 * Not `requestAnimationFrame`: the window is hidden until this call, and a hidden WKWebView
 * never runs animation frames. A passive effect runs after the first commit.
 */
export function startShellLifecycle(): () => void {
  commands.shellFirstPaint().catch((error: unknown) => log.warn('shell_first_paint failed', error))
  beat()
  const timer = setInterval(beat, HEARTBEAT_INTERVAL_MS)
  return () => clearInterval(timer)
}

/** Rendered once inside the main window's tree. */
export function ShellLifecycle(): null {
  useEffect(() => startShellLifecycle(), [])
  return null
}
