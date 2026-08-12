import { randomUUID } from 'node:crypto'
import { ipcMain, type BrowserWindow, type IpcMainEvent } from 'electron'

export const MAIN_INVOKE_CHANNEL = 'main:invoke'
export const MAIN_INVOKE_RESPONSE_CHANNEL_PREFIX = 'main:invoke:response:'

export interface MainInvokePayload {
  requestId: string
  channel: string
  payload?: unknown
}

interface MainToRendererInvokeOptions {
  timeoutMs?: number
}

function getResponseChannel(requestId: string): string {
  return `${MAIN_INVOKE_RESPONSE_CHANNEL_PREFIX}${requestId}`
}

export async function mainToRendererInvoke<T>(
  win: BrowserWindow,
  channel: string,
  payload?: unknown,
  options: MainToRendererInvokeOptions = {}
): Promise<T | null> {
  if (win.isDestroyed()) return null
  // Resolve the target once: reading `win.webContents` again from inside the
  // response handler throws if the window was destroyed while the call was in
  // flight, and the captured reference keeps the sender check stable.
  const target = win.webContents
  if (typeof target.isDestroyed === 'function' && target.isDestroyed()) return null

  const requestId = randomUUID()
  const responseChannel = getResponseChannel(requestId)
  const timeoutMs = options.timeoutMs ?? 2_000

  return new Promise((resolve) => {
    let settled = false

    const cleanup = (): void => {
      clearTimeout(timeout)
      ipcMain.removeListener(responseChannel, handleResponse)
      target.removeListener('destroyed', handleTargetDestroyed)
    }

    const settle = (result: T | null): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }

    // A reply on this per-request channel only counts when it comes from the
    // window we asked. A foreign sender is dropped rather than settled — letting
    // it settle would hand any renderer a way to null out another window's call.
    const handleResponse = (event: IpcMainEvent, result: T | null): void => {
      if (event.sender !== target) return
      settle(result)
    }

    // The window went away before answering (closed, or reloaded out from under
    // the request). No reply is ever coming, so drop the per-call listener now
    // instead of parking it on the shared ipcMain until the timeout fires.
    const handleTargetDestroyed = (): void => settle(null)

    ipcMain.on(responseChannel, handleResponse)
    target.once('destroyed', handleTargetDestroyed)
    const timeout = setTimeout(() => settle(null), timeoutMs)

    try {
      const message: MainInvokePayload = { requestId, channel, payload }
      target.send(MAIN_INVOKE_CHANNEL, message)
    } catch {
      settle(null)
    }
  })
}
