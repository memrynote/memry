import { createLogger } from '../lib/logger'

const log = createLogger('TauriEvent')

/** A Tauri event as the renderer subscribes to it: a synchronous unsubscribe. */
export function subscribeToEvent<T>(
  event: { listen: (handler: (event: { payload: T }) => void) => Promise<() => void> },
  callback: (payload: T) => void
): () => void {
  let active = true
  const registered = event.listen((received) => {
    if (active) callback(received.payload)
  })
  registered.catch((error: unknown) => log.warn('event subscription failed', error))
  return () => {
    active = false
    void registered.then((unlisten) => unlisten()).catch(() => undefined)
  }
}
