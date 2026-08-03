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
  isDestroyed = () => false
  webContents = {
    isDestroyed: () => false,
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
  stopVoiceModel,
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
    vi.useRealTimers()
    fs.rmSync(tempDir, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  it('reports the model as downloaded when the marker file exists', () => {
    const markerDir = path.join(tempDir, 'models', 'voice-transcription')
    fs.mkdirSync(markerDir, { recursive: true })
    fs.writeFileSync(path.join(markerDir, 'whisper-small.json'), '{}')

    expect(getVoiceModelStatus()).toEqual(
      expect.objectContaining({
        downloaded: true,
        loaded: false
      })
    )
    expect(mockFork).not.toHaveBeenCalled()
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

  it('shuts down the utility process after transcription stays idle', async () => {
    vi.useFakeTimers()
    const transcribePromise = transcribeWithLocalModel(Buffer.from('audio'))

    mockUtilityProcessInstance.simulateMessage({ type: 'ready' })
    await vi.waitFor(() => {
      expect(mockUtilityProcessInstance.postMessage).toHaveBeenCalledTimes(1)
    })

    const requestMessage = mockUtilityProcessInstance.postMessage.mock.calls[0]?.[0] as {
      requestId: string
    }
    mockUtilityProcessInstance.simulateMessage({
      type: 'transcribe-result',
      requestId: requestMessage.requestId,
      transcription: 'voice memo'
    })

    await expect(transcribePromise).resolves.toBe('voice memo')
    expect(mockUtilityProcessInstance.postMessage).not.toHaveBeenCalledWith({ type: 'shutdown' })

    await vi.advanceTimersByTimeAsync(30_000)

    expect(mockUtilityProcessInstance.postMessage).toHaveBeenLastCalledWith({ type: 'shutdown' })
  })

  it('keeps the utility process alive when another transcription starts before idle shutdown', async () => {
    vi.useFakeTimers()
    const firstTranscribe = transcribeWithLocalModel(Buffer.from('first'))

    mockUtilityProcessInstance.simulateMessage({ type: 'ready' })
    await vi.waitFor(() => {
      expect(mockUtilityProcessInstance.postMessage).toHaveBeenCalledTimes(1)
    })

    const firstRequest = mockUtilityProcessInstance.postMessage.mock.calls[0]?.[0] as {
      requestId: string
    }
    mockUtilityProcessInstance.simulateMessage({
      type: 'transcribe-result',
      requestId: firstRequest.requestId,
      transcription: 'first memo'
    })

    await expect(firstTranscribe).resolves.toBe('first memo')
    await vi.advanceTimersByTimeAsync(20_000)

    const secondTranscribe = transcribeWithLocalModel(Buffer.from('second'))
    await vi.waitFor(() => {
      expect(mockUtilityProcessInstance.postMessage).toHaveBeenCalledTimes(2)
    })

    await vi.advanceTimersByTimeAsync(10_000)
    expect(mockUtilityProcessInstance.postMessage).not.toHaveBeenCalledWith({ type: 'shutdown' })

    const secondRequest = mockUtilityProcessInstance.postMessage.mock.calls[1]?.[0] as {
      requestId: string
    }
    mockUtilityProcessInstance.simulateMessage({
      type: 'transcribe-result',
      requestId: secondRequest.requestId,
      transcription: 'second memo'
    })

    await expect(secondTranscribe).resolves.toBe('second memo')
    await vi.advanceTimersByTimeAsync(30_000)

    expect(mockUtilityProcessInstance.postMessage).toHaveBeenLastCalledWith({ type: 'shutdown' })
  })

  it('returns false for worker errors and unexpected download responses', async () => {
    const failedDownload = downloadVoiceModel()

    mockUtilityProcessInstance.simulateMessage({ type: 'ready' })
    await vi.waitFor(() => {
      expect(mockUtilityProcessInstance.postMessage).toHaveBeenCalledTimes(1)
    })
    const failedRequest = mockUtilityProcessInstance.postMessage.mock.calls[0]?.[0] as {
      requestId: string
    }
    mockUtilityProcessInstance.simulateMessage({
      type: 'error',
      requestId: failedRequest.requestId,
      error: 'download failed'
    })

    await expect(failedDownload).resolves.toBe(false)
    expect(getVoiceModelStatus().error).toBe('download failed')

    unloadVoiceModel()
    mockFork.mockClear()
    const unexpectedDownload = downloadVoiceModel()

    mockUtilityProcessInstance.simulateMessage({ type: 'ready' })
    await vi.waitFor(() => {
      expect(mockUtilityProcessInstance.postMessage).toHaveBeenCalledTimes(1)
    })
    const unexpectedRequest = mockUtilityProcessInstance.postMessage.mock.calls[0]?.[0] as {
      requestId: string
    }
    mockUtilityProcessInstance.simulateMessage({
      type: 'transcribe-result',
      requestId: unexpectedRequest.requestId,
      transcription: 'not a download'
    })

    await expect(unexpectedDownload).resolves.toBe(false)
  })

  it('rejects start, request, and fatal utility failures', async () => {
    vi.useFakeTimers()
    const startTimeout = transcribeWithLocalModel(Buffer.from('audio'))
    const startTimeoutExpectation = expect(startTimeout).rejects.toThrow(
      'Voice transcription utility failed to start within timeout'
    )

    await vi.advanceTimersByTimeAsync(10_000)
    await startTimeoutExpectation
    expect(getVoiceModelStatus().error).toBe(
      'Voice transcription utility failed to start within timeout'
    )

    unloadVoiceModel()
    const fatalBeforeReady = transcribeWithLocalModel(Buffer.from('audio'))
    const fatalExpectation = expect(fatalBeforeReady).rejects.toThrow(
      'Voice transcription utility fatal error: SIGSEGV at worker.cc:10'
    )
    mockUtilityProcessInstance.emit('error', 'SIGSEGV', 'worker.cc:10', 'report')

    await fatalExpectation

    unloadVoiceModel()
    const requestTimeout = transcribeWithLocalModel(Buffer.from('audio'))
    mockUtilityProcessInstance.simulateMessage({ type: 'ready' })
    await vi.waitFor(() => {
      expect(mockUtilityProcessInstance.postMessage).toHaveBeenCalledTimes(1)
    })

    const requestTimeoutExpectation = expect(requestTimeout).rejects.toThrow(
      'Voice transcription request timed out: transcribe'
    )
    await vi.advanceTimersByTimeAsync(5 * 60_000)

    await requestTimeoutExpectation
  })

  it('stops a running utility process via graceful shutdown or timeout kill', async () => {
    vi.useFakeTimers()
    const downloadPromise = downloadVoiceModel()

    mockUtilityProcessInstance.simulateMessage({ type: 'ready' })
    await vi.waitFor(() => {
      expect(mockUtilityProcessInstance.postMessage).toHaveBeenCalledTimes(1)
    })
    const requestMessage = mockUtilityProcessInstance.postMessage.mock.calls[0]?.[0] as {
      requestId: string
    }
    mockUtilityProcessInstance.simulateMessage({
      type: 'download-model-result',
      requestId: requestMessage.requestId
    })
    await expect(downloadPromise).resolves.toBe(true)

    const stopPromise = stopVoiceModel()
    expect(mockUtilityProcessInstance.postMessage).toHaveBeenLastCalledWith({ type: 'shutdown' })
    mockUtilityProcessInstance.simulateExit(0)
    await expect(stopPromise).resolves.toBeUndefined()

    const secondDownload = downloadVoiceModel()
    mockUtilityProcessInstance.simulateMessage({ type: 'ready' })
    await vi.waitFor(() => {
      expect(mockUtilityProcessInstance.postMessage).toHaveBeenCalledTimes(1)
    })
    const secondRequest = mockUtilityProcessInstance.postMessage.mock.calls[0]?.[0] as {
      requestId: string
    }
    mockUtilityProcessInstance.simulateMessage({
      type: 'download-model-result',
      requestId: secondRequest.requestId
    })
    await expect(secondDownload).resolves.toBe(true)

    const timeoutStop = stopVoiceModel()
    await vi.advanceTimersByTimeAsync(3_000)

    expect(mockUtilityProcessInstance.kill).toHaveBeenCalled()
    await expect(timeoutStop).resolves.toBeUndefined()
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
