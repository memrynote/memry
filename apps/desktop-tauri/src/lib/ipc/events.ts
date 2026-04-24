import { listen as tauriListen, type UnlistenFn } from '@tauri-apps/api/event'

type EventCallback<T> = (payload: T) => void | Promise<void>

/**
 * Typed wrapper around Tauri's listen. At M1, no backend events are emitted
 * (Rust stubs are empty). The wrapper registers the listener so UI code that
 * subscribes to events (e.g. `sync-progress`) doesn't crash — callbacks
 * simply never fire until M2+ emit real events.
 */
export async function listen<T = unknown>(
  event: string,
  callback: EventCallback<T>
): Promise<UnlistenFn> {
  return tauriListen<T>(event, (tauriEvent) => {
    void callback(tauriEvent.payload as T)
  })
}

/**
 * Subscribe once and auto-unsubscribe after the first event fires.
 */
export async function listenOnce<T = unknown>(
  event: string,
  callback: EventCallback<T>
): Promise<void> {
  const unlisten = await listen<T>(event, async (payload) => {
    try {
      await callback(payload)
    } finally {
      unlisten()
    }
  })
}
