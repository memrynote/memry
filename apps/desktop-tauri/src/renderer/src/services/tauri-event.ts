import { createLogger } from '../lib/logger'

const log = createLogger('TauriEvent')

/**
 * A Tauri event as the renderer subscribes to it: a synchronous unsubscribe. `onListening` runs
 * once main delivers the event to this page.
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
    (error: unknown) => log.warn('event subscription failed', error)
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
 */
export function subscribeToEvents(
  subscriptions: ReadonlyArray<(onListening: () => void) => () => void>,
  onListening: () => void
): () => void {
  let waiting = subscriptions.length
  const stops = subscriptions.map((subscribe) =>
    subscribe(() => {
      waiting -= 1
      if (waiting === 0) onListening()
    })
  )
  return () => {
    for (const stop of stops) stop()
  }
}
