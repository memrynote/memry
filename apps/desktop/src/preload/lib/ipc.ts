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

export function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}
