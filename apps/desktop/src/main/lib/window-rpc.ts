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
  if (typeof win.webContents.isDestroyed === 'function' && win.webContents.isDestroyed())
    return null

  const requestId = randomUUID()
  const responseChannel = getResponseChannel(requestId)
  const timeoutMs = options.timeoutMs ?? 2_000

  return new Promise((resolve) => {
    let settled = false

    const cleanup = (): void => {
      clearTimeout(timeout)
      ipcMain.removeListener(responseChannel, handleResponse)
    }

    const settle = (result: T | null): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }

    const handleResponse = (event: IpcMainEvent, result: T | null): void => {
      if (event.sender !== win.webContents) return
      settle(result)
    }

    ipcMain.on(responseChannel, handleResponse)
    const timeout = setTimeout(() => settle(null), timeoutMs)

    try {
      const message: MainInvokePayload = { requestId, channel, payload }
      win.webContents.send(MAIN_INVOKE_CHANNEL, message)
    } catch {
      settle(null)
    }
  })
}
