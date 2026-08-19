import { describe, it, expect, vi, beforeEach } from 'vitest'
import { z } from 'zod'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() }
}))

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

vi.mock('../../database', () => ({
  getDatabase: vi.fn(),
  requireDatabase: vi.fn()
}))

vi.mock('../../telemetry/diagnostics', () => ({
  trackMainError: vi.fn()
}))

import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { trackMainError } from '../../telemetry/diagnostics'
import { createValidatedHandler } from '../validate'
import { installIpcChannelLabels } from './ipc-channel-labels'

const mockTrackMainError = vi.mocked(trackMainError)
// Captured before the install replaces the property, so the pass-through is
// still assertable afterwards.
const realHandle = vi.mocked(ipcMain.handle)

const invokeEvent = {} as IpcMainInvokeEvent
const TitleSchema = z.object({ title: z.string().min(1) })

describe('installIpcChannelLabels', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('#given a handler registered through ipcMain.handle #then its failures name the channel', async () => {
    // #given
    installIpcChannelLabels()
    const listener = createValidatedHandler(TitleSchema, async (input) => input)
    ipcMain.handle('tasks:create', listener)

    // #when the contract schema rejects the input
    await expect(listener(invokeEvent, { title: '' })).rejects.toThrow('Validation failed')

    // #then telemetry can pin the ZodError to a channel
    expect(mockTrackMainError).toHaveBeenCalledWith('ipc', 'tasks:create', expect.anything())
  })

  it('#then registration still reaches the real ipcMain.handle', () => {
    installIpcChannelLabels()
    const listener = createValidatedHandler(TitleSchema, async (input) => input)

    ipcMain.handle('notes:list', listener)

    expect(realHandle).toHaveBeenCalledTimes(1)
    expect(realHandle).toHaveBeenCalledWith('notes:list', listener)
  })

  it('#given a second install #then handle is not wrapped twice', () => {
    installIpcChannelLabels()
    installIpcChannelLabels()

    ipcMain.handle(
      'vault:status',
      createValidatedHandler(TitleSchema, async (i) => i)
    )

    // A double wrap would register the same handler with Electron twice.
    expect(realHandle).toHaveBeenCalledTimes(1)
  })
})
