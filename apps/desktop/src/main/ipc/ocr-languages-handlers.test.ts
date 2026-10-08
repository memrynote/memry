import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invokeHandler, mockIpcMain, resetIpcMocks } from '@tests/utils/mock-ipc'
import { OcrLanguagesChannels } from '@memry/contracts/ocr-languages-api'

const state = { selected: ['eng', 'deu'], statuses: { eng: { state: 'ready' } } }
const mocks = vi.hoisted(() => ({
  getOcrLanguagesState: vi.fn(),
  setOcrLanguages: vi.fn(),
  retryOcrLanguages: vi.fn()
}))

vi.mock('electron', () => ({ ipcMain: mockIpcMain }))
vi.mock('../telemetry/diagnostics', () => ({ trackMainError: vi.fn() }))
vi.mock('../file-text/ocr-languages', () => mocks)

import {
  registerOcrLanguagesHandlers,
  unregisterOcrLanguagesHandlers
} from './ocr-languages-handlers'

describe('OCR languages IPC handlers', () => {
  beforeEach(() => {
    resetIpcMocks()
    vi.clearAllMocks()
    mocks.getOcrLanguagesState.mockReturnValue(state)
    mocks.setOcrLanguages.mockReturnValue(state)
    mocks.retryOcrLanguages.mockReturnValue(state)
    registerOcrLanguagesHandlers()
  })

  it('reads the state, sets validated languages, and retries', async () => {
    await expect(invokeHandler(OcrLanguagesChannels.invoke.GET)).resolves.toEqual(state)
    await expect(
      invokeHandler(OcrLanguagesChannels.invoke.SET, { languages: ['eng', 'deu'] })
    ).resolves.toEqual(state)
    await expect(invokeHandler(OcrLanguagesChannels.invoke.RETRY)).resolves.toEqual(state)

    expect(mocks.setOcrLanguages).toHaveBeenCalledWith(['eng', 'deu'])
    expect(mocks.retryOcrLanguages).toHaveBeenCalledTimes(1)
  })

  it('rejects a language the server does not serve before changing anything', async () => {
    await expect(
      invokeHandler(OcrLanguagesChannels.invoke.SET, { languages: ['klingon'] })
    ).rejects.toThrow()
    expect(mocks.setOcrLanguages).not.toHaveBeenCalled()
  })

  it('removes every channel on unregister', async () => {
    unregisterOcrLanguagesHandlers()

    await expect(invokeHandler(OcrLanguagesChannels.invoke.GET)).rejects.toThrow(
      'No handler registered'
    )
    expect(mockIpcMain.removeHandler).toHaveBeenCalledWith(OcrLanguagesChannels.invoke.SET)
    expect(mockIpcMain.removeHandler).toHaveBeenCalledWith(OcrLanguagesChannels.invoke.RETRY)
  })
})
