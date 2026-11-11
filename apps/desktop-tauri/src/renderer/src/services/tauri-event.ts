import { createLogger } from '../lib/logger'

const log = createLogger('TauriEvent')

/** The `onListening` callbacks whose `listen` call was rejected, for `subscribeToEvents` to count. */
const failedListens = new WeakSet<() => void>()

/**
 * A Tauri event as the renderer subscribes to it: a synchronous unsubscribe. `onListening` runs
 * once main delivers the event to this page, and also when `listen` fails: a page that cannot
 * listen has no other way to see what changed, so it reads again either way.
 */
export function subscribeToEvent<T>(
  event: { listen: (handler: (event: { payload: T }) => void) => Promise<() => void> },
  callback: (payload: T) => void,
  onListening?: () => void
): () => void {
  let active = true
  const registered = event.listen((received) => {
    if (active) callback(received.payload)
  })
  registered.then(
    () => {
      if (active) onListening?.()
    },
    (error: unknown) => {
      log.warn('event subscription failed', error)
      if (!active || !onListening) return
      failedListens.add(onListening)
      onListening()
    }
  )
  return () => {
    active = false
    void registered.then((unlisten) => unlisten()).catch(() => undefined)
  }
}

/**
 * Subscribes a group of events and runs `onListening` once every one of them reaches this page.
 * A Tauri listener goes live only when main answers its `listen` call, and an event main sends
 * before then reaches nobody (Electron's `ipcRenderer.on` was live at once). A page that read
 * what these events change before they went live reads it again in `onListening` (#4270).
 * A `listen` that fails counts as done, so one broken event does not keep the re-read from the
 * others; the group logs how many failed.
 */
export function subscribeToEvents(
  subscriptions: ReadonlyArray<(onListening: () => void) => () => void>,
  onListening: () => void
): () => void {
  let waiting = subscriptions.length
  let failed = 0
  const stops = subscriptions.map((subscribe) => {
    const done = () => {
      if (failedListens.has(done)) failed += 1
      waiting -= 1
      if (waiting > 0) return
      if (failed > 0) {
        log.warn(`${failed} of ${subscriptions.length} event listeners failed to go live`)
      }
      onListening()
    }
    return subscribe(done)
  })
  return () => {
    for (const stop of stops) stop()
  }
}
