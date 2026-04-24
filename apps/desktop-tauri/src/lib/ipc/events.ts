import { listen as tauriListen, type UnlistenFn } from '@tauri-apps/api/event'

type EventCallback<T> = (payload: T) => void | Promise<void>

/**
 * True inside the Tauri webview. False in plain browser contexts (Vite dev
 * opened in a regular browser, Playwright WebKit). Without this guard,
 * calling `tauriListen` outside Tauri throws
 * "undefined is not an object (evaluating 'window.__TAURI_INTERNALS__.transformCallback')"
 * and kills the renderer before first paint.
 */
function isTauriRuntime(): boolean {
  return (
    typeof window !== 'undefined' &&
    '__TAURI_INTERNALS__' in window &&
    window.__TAURI_INTERNALS__ !== undefined
  )
}

/**
 * Typed wrapper around Tauri's listen. Inside Tauri, registers the real
 * listener. Outside Tauri (e.g. M1 Vite dev in a browser, Playwright e2e),
 * returns a noop unsubscriber — the renderer code is mock-only at M1 and
 * doesn't rely on backend events firing. M2+ event emission lands only
 * inside Tauri.
 */
export async function listen<T = unknown>(
  event: string,
  callback: EventCallback<T>
): Promise<UnlistenFn> {
  if (!isTauriRuntime()) {
    return () => {}
  }
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
