import { afterEach, describe, expect, it, vi } from 'vitest'

const ipcMainHandle = vi.hoisted(() => vi.fn())
const ipcMainRemoveHandler = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  ipcMain: {
    handle: ipcMainHandle,
    removeHandler: ipcMainRemoveHandler
  }
}))

describe('registerDebugMemoryHandlers', () => {
  afterEach(() => {
    delete process.env.MEMRY_DEBUG_MEMORY
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('does not register the debug memory IPC handler by default', async () => {
    const { registerDebugMemoryHandlers } = await import('./memory-ipc-handlers')

    registerDebugMemoryHandlers()

    expect(ipcMainHandle).not.toHaveBeenCalled()
  })

  it('registers the debug memory IPC handler when explicitly enabled', async () => {
    process.env.MEMRY_DEBUG_MEMORY = '1'
    const { registerDebugMemoryHandlers } = await import('./memory-ipc-handlers')

    registerDebugMemoryHandlers()

    expect(ipcMainHandle).toHaveBeenCalledWith('debug:memory-snapshot', expect.any(Function))
  })
})
