import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SYNC_CHANNELS, SYNC_EVENTS } from '@memry/contracts/ipc-sync'

const exposeInMainWorldMock = vi.fn()
const ipcInvokeMock = vi.fn(async () => ({ success: true }))
const ipcOnMock = vi.fn()
const ipcRemoveListenerMock = vi.fn()

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: exposeInMainWorldMock
  },
  ipcRenderer: {
    send: vi.fn(),
    invoke: ipcInvokeMock,
    on: ipcOnMock,
    removeListener: ipcRemoveListenerMock
  }
}))

vi.mock('@electron-toolkit/preload', () => ({
  electronAPI: { version: 'test-electron' }
}))

type ApiShape = {
  syncAuth: {
    requestOtp: (input: { email: string }) => Promise<unknown>
  }
  crypto: {
    encryptItem: (input: {
      itemId: string
      type: string
      operation: string
      content: unknown
      metadata?: Record<string, unknown>
    }) => Promise<unknown>
  }
  onSyncStatusChanged: (callback: (event: { status: string }) => void) => () => void
}

async function importPreloadAndGetApi(): Promise<ApiShape> {
  vi.resetModules()
  exposeInMainWorldMock.mockClear()
  ipcInvokeMock.mockClear()
  ipcOnMock.mockClear()
  ipcRemoveListenerMock.mockClear()

  const processWithIsolation = process as NodeJS.Process & { contextIsolated?: boolean }
  processWithIsolation.contextIsolated = true

  await import('../preload/index')

  const apiCall = exposeInMainWorldMock.mock.calls.find((call) => call[0] === 'api')
  if (!apiCall) {
    throw new Error('api was not exposed to renderer')
  }

  return apiCall[1] as ApiShape
}

describe('preload sync bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('exposes api and forwards sync auth calls over IPC', async () => {
    const api = await importPreloadAndGetApi()

    await api.syncAuth.requestOtp({ email: 'user@example.com' })

    expect(exposeInMainWorldMock).toHaveBeenCalledWith('api', expect.any(Object))
    expect(ipcInvokeMock).toHaveBeenCalledWith(SYNC_CHANNELS.AUTH_REQUEST_OTP, {
      email: 'user@example.com'
    })
  })

  it('forwards crypto encrypt calls to the crypto channel', async () => {
    const api = await importPreloadAndGetApi()

    await api.crypto.encryptItem({
      itemId: 'item-1',
      type: 'task',
      operation: 'create',
      content: { title: 'test' }
    })

    expect(ipcInvokeMock).toHaveBeenCalledWith(SYNC_CHANNELS.ENCRYPT_ITEM, {
      itemId: 'item-1',
      type: 'task',
      operation: 'create',
      content: { title: 'test' }
    })
  })

  it('registers and unregisters sync status listeners', async () => {
    const api = await importPreloadAndGetApi()

    const callback = vi.fn()
    const unsubscribe = api.onSyncStatusChanged(callback)

    expect(ipcOnMock).toHaveBeenCalledWith(SYNC_EVENTS.STATUS_CHANGED, expect.any(Function))

    unsubscribe()

    expect(ipcRemoveListenerMock).toHaveBeenCalledWith(
      SYNC_EVENTS.STATUS_CHANGED,
      expect.any(Function)
    )
  })
})
