import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
    mocks.handlers.set(channel, handler)
  }),
  removeHandler: vi.fn((channel: string) => {
    mocks.handlers.delete(channel)
  }),
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
  getUpdateState: vi.fn(),
  quitAndInstall: vi.fn(),
  setAutoCheckEnabled: vi.fn(),
  consumeWhatsNew: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: mocks.handle,
    removeHandler: mocks.removeHandler
  }
}))

vi.mock('../updater', () => ({
  checkForUpdates: mocks.checkForUpdates,
  downloadUpdate: mocks.downloadUpdate,
  getUpdateState: mocks.getUpdateState,
  quitAndInstall: mocks.quitAndInstall,
  setAutoCheckEnabled: mocks.setAutoCheckEnabled,
  consumeWhatsNew: mocks.consumeWhatsNew
}))

import { UpdaterChannels } from '@memry/contracts/ipc-updater'
import { registerUpdaterHandlers, unregisterUpdaterHandlers } from './updater-handlers'

describe('updater ipc handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.handlers.clear()
    mocks.getUpdateState.mockReturnValue({ status: 'idle' })
    mocks.checkForUpdates.mockResolvedValue({ status: 'checking' })
    mocks.downloadUpdate.mockResolvedValue({ status: 'downloading' })
    mocks.setAutoCheckEnabled.mockReturnValue({ status: 'idle', autoCheckEnabled: false })
    mocks.consumeWhatsNew.mockReturnValue(null)
  })

  it('registers every updater invoke channel and forwards calls to updater services', async () => {
    registerUpdaterHandlers()

    expect(mocks.handle).toHaveBeenCalledTimes(6)
    expect(mocks.handlers.get(UpdaterChannels.invoke.GET_STATE)?.()).toEqual({ status: 'idle' })
    await expect(mocks.handlers.get(UpdaterChannels.invoke.CHECK_FOR_UPDATES)?.()).resolves.toEqual(
      { status: 'checking' }
    )
    await expect(mocks.handlers.get(UpdaterChannels.invoke.DOWNLOAD_UPDATE)?.()).resolves.toEqual({
      status: 'downloading'
    })

    expect(mocks.handlers.get(UpdaterChannels.invoke.QUIT_AND_INSTALL)?.()).toBeUndefined()
    expect(mocks.quitAndInstall).toHaveBeenCalledTimes(1)

    expect(mocks.handlers.get(UpdaterChannels.invoke.SET_AUTO_CHECK)?.({}, false)).toEqual({
      status: 'idle',
      autoCheckEnabled: false
    })
    expect(mocks.setAutoCheckEnabled).toHaveBeenCalledWith(false)

    expect(mocks.handlers.get(UpdaterChannels.invoke.CONSUME_WHATS_NEW)?.()).toBeNull()
    expect(mocks.consumeWhatsNew).toHaveBeenCalledTimes(1)
  })

  it('unregisters every updater invoke channel', () => {
    registerUpdaterHandlers()
    unregisterUpdaterHandlers()

    expect(mocks.removeHandler).toHaveBeenCalledWith(UpdaterChannels.invoke.GET_STATE)
    expect(mocks.removeHandler).toHaveBeenCalledWith(UpdaterChannels.invoke.CHECK_FOR_UPDATES)
    expect(mocks.removeHandler).toHaveBeenCalledWith(UpdaterChannels.invoke.DOWNLOAD_UPDATE)
    expect(mocks.removeHandler).toHaveBeenCalledWith(UpdaterChannels.invoke.QUIT_AND_INSTALL)
    expect(mocks.removeHandler).toHaveBeenCalledWith(UpdaterChannels.invoke.SET_AUTO_CHECK)
    expect(mocks.removeHandler).toHaveBeenCalledWith(UpdaterChannels.invoke.CONSUME_WHATS_NEW)
    expect(mocks.handlers.size).toBe(0)
  })
})
