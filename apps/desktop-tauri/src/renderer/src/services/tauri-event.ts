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
