import type { RuntimeBrowser } from './driver'

interface RuntimeCommandResult<T> {
  ok: boolean
  value?: T
  error?: string
}

export async function invokeRuntimeCommand<T>(
  browser: RuntimeBrowser,
  command: string,
  args: Record<string, unknown> = {}
): Promise<T> {
  const result = await browser.executeAsync<RuntimeCommandResult<T>>(
    (cmd, payload, done) => {
      const tauriWindow = window as Window & {
        __TAURI_INTERNALS__?: {
          invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
        }
      }
      const invoke = tauriWindow.__TAURI_INTERNALS__?.invoke
      if (!invoke) {
        done({ ok: false, error: 'window.__TAURI_INTERNALS__.invoke is unavailable' })
        return
      }

      invoke(cmd as string, payload as Record<string, unknown>)
        .then((value) => done({ ok: true, value: value as T }))
        .catch((err) => done({ ok: false, error: String(err) }))
    },
    command,
    args
  )

  if (!result.ok) {
    throw new Error(`Runtime command ${command} failed: ${result.error ?? 'unknown error'}`)
  }

  return result.value as T
}
