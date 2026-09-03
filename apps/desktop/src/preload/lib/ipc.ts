import { ipcRenderer } from 'electron'
import type {
  MainIpcInvokeChannel,
  MainIpcInvokeArgs,
  MainIpcInvokeResult
} from '../../main/ipc/generated-ipc-invoke-map'

/**
 * Every preload API module imports this file, so it has to stay import-light:
 * pulling `./logger` (electron-log/renderer) in here hangs the preload test
 * suite at collection time.
 *
 * `__electronLog` is the same sink `createLogger()` writes to — electron-log's
 * own preload script, installed by `log.initialize()` in the main process, puts
 * it on this world's global. Falling back to console keeps the failure visible
 * when it isn't there (tests, or an initialize that didn't run).
 */
export function logListenerError(channel: string, error: unknown): void {
  const message = `[PreloadIpc] Listener for "${channel}" threw`
  const sink = (globalThis as typeof globalThis & { __electronLog?: unknown }).__electronLog as
    { error?: (...data: unknown[]) => void } | undefined
  if (typeof sink?.error === 'function') {
    sink.error(message, error)
    return
  }
  console.error(message, error)
}

export function invoke<C extends MainIpcInvokeChannel>(
  channel: C,
  ...args: MainIpcInvokeArgs<C>
): Promise<MainIpcInvokeResult<C>>
export function invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>
export function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  return ipcRenderer.invoke(channel, ...args)
}

export function invokeSync(channel: string): unknown {
  return ipcRenderer.sendSync(channel)
}

export function send(channel: string, ...args: unknown[]): void {
  ipcRenderer.send(channel, ...args)
}

type IpcCallback = (payload: unknown) => void

interface ChannelSubscription {
  callbacks: IpcCallback[]
  handler: (_event: Electron.IpcRendererEvent, payload: unknown) => void
}

const channelSubscriptions = new Map<string, ChannelSubscription>()

export function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  let subscription = channelSubscriptions.get(channel)
  if (!subscription) {
    const callbacks: IpcCallback[] = []
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
      for (const current of [...callbacks]) {
        // One throwing listener must not abort the fan-out. Without this guard
        // a single unexpected payload shape takes down every subscriber
        // registered after it — for the rest of the session, not just this
        // event — because the loop unwinds out of the IPC dispatch.
        try {
          current(payload)
        } catch (error) {
          logListenerError(channel, error)
        }
      }
    }
    subscription = { callbacks, handler }
    channelSubscriptions.set(channel, subscription)
    ipcRenderer.on(channel, handler)
  }

  const wrapped = callback as IpcCallback
  subscription.callbacks.push(wrapped)

  let unsubscribed = false
  return () => {
    if (unsubscribed) return
    unsubscribed = true

    const current = channelSubscriptions.get(channel)
    if (!current) return

    const index = current.callbacks.indexOf(wrapped)
    if (index !== -1) {
      current.callbacks.splice(index, 1)
    }

    if (current.callbacks.length === 0) {
      ipcRenderer.removeListener(channel, current.handler)
      channelSubscriptions.delete(channel)
    }
  }
}
