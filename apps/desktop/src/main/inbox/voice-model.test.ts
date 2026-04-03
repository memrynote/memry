import { EventEmitter } from 'events'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserWindow } from 'electron'
import { SettingsChannels } from '@memry/contracts/ipc-channels'

const mockApp = vi.hoisted(() => ({
  getPath: vi.fn((name: string) => `/mock/${name}`)
}))
const getAllWindows = vi.hoisted(() => vi.fn())

class MockUtilityProcess extends EventEmitter {
  postMessage = vi.fn()
  kill = vi.fn().mockReturnValue(true)
  stdout = null
  stderr = null
  pid = 1234

  simulateMessage(message: unknown): void {
    this.emit('message', message)
  }

  simulateExit(code: number): void {
    this.emit('exit', code)
  }

  simulateSpawn(): void {
    this.emit('spawn')
  }
}

class MockBrowserWindow {
  webContents = {
    send: vi.fn()
  }
}

const mockFork = vi.hoisted(() => vi.fn())
let mockUtilityProcessInstance: MockUtilityProcess

vi.mock('electron', () => ({
  app: mockApp,
  BrowserWindow: {
    getAllWindows
  },
  utilityProcess: {
    fork: (...args: unknown[]) => {
      mockUtilityProcessInstance = new MockUtilityProcess()
      mockFork(...args)
      return mockUtilityProcessInstance
    }
  }
}))

import {
  downloadVoiceModel,
  getVoiceModelStatus,
  transcribeWithLocalModel,
  unloadVoiceModel
} from './voice-model'

describe('voice model', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-voice-model-'))
    mockFork.mockReset()
    unloadVoiceModel()
    mockApp.getPath.mockImplementation((name: string) =>
      name === 'userData' ? tempDir : `/mock/${name}`
    )
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([])
  })

  afterEach(() => {
    unloadVoiceModel()
    fs.rmSync(tempDir, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  it('loads whisper through a utility process and forwards progress', async () => {
    const window = new MockBrowserWindow()
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([window])

    const downloadPromise = downloadVoiceModel()

    expect(mockFork).toHaveBeenCalledOnce()
    mockUtilityProcessInstance.simulateSpawn()
    mockUtilityProcessInstance.simulateMessage({ type: 'ready' })
    await vi.waitFor(() => {
      expect(mockUtilityProcessInstance.postMessage).toHaveBeenCalledTimes(1)
    })

    const [, , options] = mockFork.mock.calls[0] ?? []
    expect(options).toEqual(
      expect.objectContaining({
        serviceName: 'VoiceTranscription',
        env: expect.objectContaining({
          MEMRY_USER_DATA_PATH: tempDir
        })
      })
    )

    const requestMessage = mockUtilityProcessInstance.postMessage.mock.calls[0]?.[0] as {
      type: string
      requestId: string
    }

    expect(requestMessage.type).toBe('download-model')

    mockUtilityProcessInstance.simulateMessage({
      type: 'progress',
      phase: 'downloading',
      progress: 50,
      status: 'Downloading Whisper Small...'
    })
    mockUtilityProcessInstance.simulateMessage({
      type: 'progress',
      phase: 'ready',
      progress: 100,
      status: 'Whisper Small ready'
    })
    mockUtilityProcessInstance.simulateMessage({
      type: 'download-model-result',
      requestId: requestMessage.requestId
    })

    await expect(downloadPromise).resolves.toBe(true)
    expect(getVoiceModelStatus()).toEqual(
      expect.objectContaining({
        loaded: true,
        downloaded: true,
        loading: false,
        error: null
      })
    )

    expect(window.webContents.send).toHaveBeenCalledWith(
      SettingsChannels.events.VOICE_MODEL_PROGRESS,
      expect.objectContaining({
        phase: 'downloading',
        progress: 50
      })
    )
  })

  it('transcribes audio through the utility process', async () => {
    const transcribePromise = transcribeWithLocalModel(Buffer.from('audio'))

    expect(mockFork).toHaveBeenCalledOnce()
    mockUtilityProcessInstance.simulateSpawn()
    mockUtilityProcessInstance.simulateMessage({ type: 'ready' })
    await vi.waitFor(() => {
      expect(mockUtilityProcessInstance.postMessage).toHaveBeenCalledTimes(1)
    })

    const requestMessage = mockUtilityProcessInstance.postMessage.mock.calls[0]?.[0] as {
      type: string
      requestId: string
      audioBuffer: Uint8Array
    }

    expect(requestMessage.type).toBe('transcribe')
    expect(Buffer.from(requestMessage.audioBuffer)).toEqual(Buffer.from('audio'))

    mockUtilityProcessInstance.simulateMessage({
      type: 'transcribe-result',
      requestId: requestMessage.requestId,
      transcription: 'voice memo'
    })

    await expect(transcribePromise).resolves.toBe('voice memo')
  })

  it('rejects instead of crashing when the utility process exits unexpectedly', async () => {
    const transcribePromise = transcribeWithLocalModel(Buffer.from('audio'))

    expect(mockFork).toHaveBeenCalledOnce()
    mockUtilityProcessInstance.simulateSpawn()
    mockUtilityProcessInstance.simulateMessage({ type: 'ready' })
    await vi.waitFor(() => {
      expect(mockUtilityProcessInstance.postMessage).toHaveBeenCalledTimes(1)
    })
    mockUtilityProcessInstance.simulateExit(9)

    await expect(transcribePromise).rejects.toThrow(
      'Voice transcription utility exited unexpectedly (code 9)'
    )
    expect(getVoiceModelStatus()).toEqual(
      expect.objectContaining({
        loaded: false,
        loading: false,
        error: 'Voice transcription utility exited unexpectedly (code 9)'
      })
    )
  })
})
