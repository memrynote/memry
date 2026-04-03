import { EventEmitter } from 'events'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockPipeline = vi.hoisted(() => vi.fn())
const mockEnv = vi.hoisted(() => ({ cacheDir: '' }))

class MockParentPort extends EventEmitter {
  postMessage = vi.fn()
}

vi.mock('@huggingface/transformers', () => ({
  pipeline: mockPipeline,
  env: mockEnv
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

describe('voice transcription worker', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-voice-worker-'))
    process.env.MEMRY_USER_DATA_PATH = tempDir
    mockPipeline.mockReset()
    mockEnv.cacheDir = ''
  })

  afterEach(() => {
    Reflect.deleteProperty(process, 'parentPort')
    Reflect.deleteProperty(process.env, 'MEMRY_USER_DATA_PATH')
    fs.rmSync(tempDir, { recursive: true, force: true })
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('announces ready through process.parentPort on startup', async () => {
    const port = new MockParentPort()
    Object.defineProperty(process, 'parentPort', {
      configurable: true,
      writable: true,
      value: port
    })

    await import('./voice-transcription-worker')

    expect(port.postMessage).toHaveBeenCalledWith({ type: 'ready' })
  })

  it('loads whisper with guarded ORT session options and transcribes in english', async () => {
    const port = new MockParentPort()
    Object.defineProperty(process, 'parentPort', {
      configurable: true,
      writable: true,
      value: port
    })

    const mockTranscriber = vi.fn().mockResolvedValue({ text: 'voice memo' })
    mockPipeline.mockResolvedValue(mockTranscriber)

    await import('./voice-transcription-worker')

    port.emit('message', {
      data: {
        type: 'transcribe',
        requestId: 'req-1',
        audioBuffer: new Uint8Array(createMonoPcm16Wav([0, 0.25, -0.25, 0.5], 16_000))
      }
    })

    await vi.waitFor(() => {
      expect(port.postMessage).toHaveBeenCalledWith({
        type: 'transcribe-result',
        requestId: 'req-1',
        transcription: 'voice memo'
      })
    })

    expect(mockEnv.cacheDir).toBe(path.join(tempDir, 'models', 'transformers'))
    expect(mockPipeline).toHaveBeenCalledWith(
      'automatic-speech-recognition',
      'Xenova/whisper-small',
      expect.objectContaining({
        device: 'cpu',
        session_options: {
          executionProviders: [{ name: 'cpu', useArena: false }],
          enableCpuMemArena: false,
          enableMemPattern: false,
          executionMode: 'sequential',
          graphOptimizationLevel: 'basic',
          intraOpNumThreads: 1,
          interOpNumThreads: 1
        }
      })
    )
    expect(mockTranscriber).toHaveBeenCalledWith(expect.any(Float32Array), {
      sampling_rate: 16_000,
      language: 'en',
      task: 'transcribe'
    })
  })
})

function createMonoPcm16Wav(samples: number[], sampleRate: number): Buffer {
  const dataSize = samples.length * 2
  const buffer = Buffer.alloc(44 + dataSize)

  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)

  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0))
    const value = sample < 0 ? sample * 0x8000 : sample * 0x7fff
    buffer.writeInt16LE(Math.round(value), 44 + index * 2)
  }

  return buffer
}
