import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({
  listeners: new Map<string, (...args: unknown[]) => void>(),
  randomUUID: vi.fn(() => 'request-1')
}))

vi.mock('node:crypto', () => ({
  randomUUID: hoisted.randomUUID
}))

vi.mock('electron', () => ({
  ipcMain: {
    on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
      hoisted.listeners.set(channel, listener)
    }),
    removeListener: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
      if (hoisted.listeners.get(channel) === listener) hoisted.listeners.delete(channel)
    })
  }
}))

import { ipcMain } from 'electron'
import { mainToRendererInvoke } from './window-rpc'

describe('mainToRendererInvoke', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    hoisted.listeners.clear()
    hoisted.randomUUID.mockReturnValue('request-1')
    vi.mocked(ipcMain.on).mockClear()
    vi.mocked(ipcMain.removeListener).mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends a main invoke request and resolves with the matching renderer response', async () => {
    const webContents = { send: vi.fn() }
    const win = {
      isDestroyed: () => false,
      webContents
    } as unknown as Electron.BrowserWindow

    const promise = mainToRendererInvoke<string>(win, 'agent_mcp:get_current_note', undefined)

    expect(webContents.send).toHaveBeenCalledWith('main:invoke', {
      requestId: 'request-1',
      channel: 'agent_mcp:get_current_note',
      payload: undefined
    })

    hoisted.listeners.get('main:invoke:response:request-1')?.({ sender: webContents }, 'ok')

    await expect(promise).resolves.toBe('ok')
    expect(ipcMain.removeListener).toHaveBeenCalledWith(
      'main:invoke:response:request-1',
      expect.any(Function)
    )
  })

  it('ignores responses from other renderers and resolves null on timeout', async () => {
    const webContents = { send: vi.fn() }
    const win = {
      isDestroyed: () => false,
      webContents
    } as unknown as Electron.BrowserWindow

    const promise = mainToRendererInvoke<string>(win, 'agent_mcp:get_current_note', undefined, {
      timeoutMs: 100
    })

    hoisted.listeners.get('main:invoke:response:request-1')?.({ sender: {} }, 'wrong-window')
    await vi.advanceTimersByTimeAsync(100)

    await expect(promise).resolves.toBeNull()
  })
})
