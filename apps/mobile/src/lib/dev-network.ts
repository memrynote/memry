import { File, Paths } from 'expo-file-system'
import { createLogger } from './logger'

const log = createLogger('DevNetwork')

/**
 * A dev-build-only network kill switch (T066).
 *
 * The offline matrix has to take the device offline twenty times, and neither
 * the simulator nor a device exposes airplane mode to Maestro. The one lever
 * that looked scriptable — `simctl status_bar override --dataNetwork hide` —
 * only repaints the status bar; the simulator stays fully online, so a matrix
 * driven by it does all of its "offline" work with a working network and
 * reports a green that means nothing.
 *
 * So the app provides the lever. When it is on, the HTTP adapter reports
 * offline and FAILS every request, which is what the code under test sees in
 * airplane mode: `isOnline()` false, requests rejected, outbox parked and
 * retried. It cannot make the app behave BETTER than real airplane mode, which
 * is the property a gate needs.
 *
 * `__DEV__` only. In a release build `setDevOffline` is a no-op and the getter
 * is always false, so there is no switch to reach in a shipped app.
 */

/**
 * The switch is PERSISTED, and that is not incidental.
 *
 * The matrix force-quits and relaunches the app while it is supposed to be
 * offline — that relaunch is the whole point of the scenario. An in-memory
 * flag comes back up online, and the run would verify persistence against a
 * device that had quietly reconnected.
 */
const MARKER_NAME = '.dev-offline'

function marker(): File {
  return new File(Paths.document, MARKER_NAME)
}

function readMarker(): boolean {
  if (!__DEV__) return false
  try {
    return marker().exists
  } catch {
    return false
  }
}

let offline = readMarker()
const listeners = new Set<(offline: boolean) => void>()

export function isDevOffline(): boolean {
  return __DEV__ && offline
}

export function setDevOffline(next: boolean): void {
  if (!__DEV__) return
  if (offline === next) return
  offline = next

  try {
    const file = marker()
    if (next) file.write('1')
    else if (file.exists) file.delete()
  } catch (err) {
    // The in-memory flag still flipped, so a manual toggle works; only the
    // survives-a-relaunch property is lost, and that is worth a warning
    // rather than a failure.
    log.warn('Could not persist the dev network switch', {
      error: err instanceof Error ? err.message : String(err)
    })
  }

  log.warn('Dev network switch', { offline: next })
  for (const listener of listeners) listener(next)
}

export function subscribeDevOffline(listener: (offline: boolean) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Thrown by the HTTP adapter while the switch is on. */
export class DevOfflineError extends Error {
  constructor() {
    // The message shape matters: the sync client's transport wraps whatever it
    // catches in a NetworkError, and the retry and backoff paths key off that
    // — which is exactly what a real offline device produces.
    super('Network request failed (dev offline switch)')
    this.name = 'DevOfflineError'
  }
}
