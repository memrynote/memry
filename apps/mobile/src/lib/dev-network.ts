import { File, Paths } from 'expo-file-system'
import { createLogger } from './logger'

const log = createLogger('DevNetwork')

/**
 * A dev-build-only network kill switch (T066).
 *
 * The offline matrix has to take the device offline twenty times, and Maestro
 * cannot reach airplane mode — neither the simulator nor a device exposes it
 * to the accessibility tree. The one lever that looked scriptable,
 * `simctl status_bar override --dataNetwork hide`, only repaints the status
 * bar: the simulator stays fully online, so a matrix driven by it does all of
 * its "offline" work with a working network and reports a green that means
 * nothing.
 *
 * So the app supplies the lever. When it is on, the HTTP adapter reports
 * offline and FAILS every request, which is what the code under test sees in
 * airplane mode: `isOnline()` false, requests rejected, outbox parked and
 * retried. It cannot make the app behave BETTER than real airplane mode, which
 * is the property a gate needs.
 *
 * `__DEV__` only. In a release build the getter is always false and the setter
 * is a no-op, so there is no offline toggle in a shipped app.
 */

/**
 * The switch is A FILE, and the app re-reads it rather than being told.
 *
 * A deep link was the obvious lever and does not work: under the dev-client
 * shell the `memry://` scheme is consumed by the launcher and the running app
 * never sees the URL. A file needs no scheme, no UI and no running app — the
 * driver writes it into the simulator's data container with
 * `simctl get_app_container <udid> <bundle> data`.
 *
 * It also has to survive a relaunch: the matrix force-quits and relaunches
 * while offline — that relaunch is the point of the scenario — and an
 * in-memory flag comes back up online, so the run would verify persistence
 * against a device that had quietly reconnected.
 */
const MARKER_NAME = '.dev-offline'

/**
 * Bounded staleness on the file check.
 *
 * `isDevOffline()` is called per request and per reachability read, and a
 * `stat` on each is wasteful for a value that changes a handful of times per
 * run. A quarter second is far below the granularity of anything the matrix
 * asserts.
 */
const RECHECK_MS = 250

let cached = false
let checkedAt = 0
const listeners = new Set<(offline: boolean) => void>()

function marker(): File {
  return new File(Paths.document, MARKER_NAME)
}

function readMarker(): boolean {
  try {
    return marker().exists
  } catch {
    return false
  }
}

export function isDevOffline(): boolean {
  if (!__DEV__) return false
  const now = Date.now()
  if (now - checkedAt < RECHECK_MS) return cached
  checkedAt = now

  const next = readMarker()
  if (next !== cached) {
    cached = next
    log.warn('Dev network switch', { offline: next })
    for (const listener of listeners) listener(next)
  }
  return cached
}

export function setDevOffline(next: boolean): void {
  if (!__DEV__) return
  try {
    const file = marker()
    if (next) file.write('1')
    else if (file.exists) file.delete()
  } catch (err) {
    log.warn('Could not write the dev network switch', {
      error: err instanceof Error ? err.message : String(err)
    })
    return
  }
  // Force the next read to see it rather than the cache.
  checkedAt = 0
  isDevOffline()
}

/**
 * Notified when the file's state changes.
 *
 * The change is only NOTICED on the next `isDevOffline()`, which the HTTP
 * adapter calls on every request and on every reachability read — so a
 * subscriber hears about an externally-written file within `RECHECK_MS` of the
 * app next touching the network, which is exactly when it matters.
 */
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
