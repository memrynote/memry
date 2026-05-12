import { ipcRenderer } from 'electron'
import type {
  MainIpcInvokeChannel,
  MainIpcInvokeArgs,
  MainIpcInvokeResult
} from '../../main/ipc/generated-ipc-invoke-map'

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
        current(payload)
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
