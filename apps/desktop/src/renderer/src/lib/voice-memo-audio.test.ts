import { afterEach, describe, expect, it, vi } from 'vitest'

import { prepareVoiceMemoAudio } from './voice-memo-audio'

function makeAudioBuffer({
  sampleRate,
  numberOfChannels,
  duration,
  samples
}: {
  sampleRate: number
  numberOfChannels: number
  duration: number
  samples: number[]
}): AudioBuffer {
  return {
    sampleRate,
    numberOfChannels,
    duration,
    getChannelData: vi.fn(() => Float32Array.from(samples))
  } as unknown as AudioBuffer
}

function readAscii(buffer: ArrayBuffer, offset: number, length: number): string {
  const bytes = new Uint8Array(buffer, offset, length)
  return String.fromCharCode(...bytes)
}

function makeBlob(): Blob {
  return {
    arrayBuffer: vi.fn(async () => new ArrayBuffer(8))
  } as unknown as Blob
}

describe('prepareVoiceMemoAudio', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('encodes decoded mono 16 kHz audio directly as pcm16 wav', async () => {
    const decoded = makeAudioBuffer({
      sampleRate: 16_000,
      numberOfChannels: 1,
      duration: 0.25,
      samples: [-2, -1, 0, 0.5, 2]
    })
    const close = vi.fn()
    const decodeAudioData = vi.fn(async () => decoded)
    const AudioContextMock = vi.fn(function AudioContext(this: any) {
      this.decodeAudioData = decodeAudioData
      this.close = close
    })
    const OfflineAudioContextMock = vi.fn()

    vi.stubGlobal('AudioContext', AudioContextMock)
    vi.stubGlobal('OfflineAudioContext', OfflineAudioContextMock)

    const result = await prepareVoiceMemoAudio(makeBlob())
    const view = new DataView(result.data)

    expect(AudioContextMock).toHaveBeenCalledTimes(1)
    expect(decodeAudioData).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
    expect(OfflineAudioContextMock).not.toHaveBeenCalled()
    expect(result.format).toBe('wav')
    expect(result.duration).toBe(0.25)
    expect(readAscii(result.data, 0, 4)).toBe('RIFF')
    expect(readAscii(result.data, 8, 4)).toBe('WAVE')
    expect(readAscii(result.data, 12, 4)).toBe('fmt ')
    expect(readAscii(result.data, 36, 4)).toBe('data')
    expect(view.getUint32(24, true)).toBe(16_000)
    expect(view.getInt16(44, true)).toBe(-32768)
    expect(view.getInt16(48, true)).toBe(0)
    expect(view.getInt16(52, true)).toBe(32767)
  })

  it('renders non-target audio through OfflineAudioContext before encoding', async () => {
    const decoded = makeAudioBuffer({
      sampleRate: 48_000,
      numberOfChannels: 2,
      duration: 0.5,
      samples: [0.25]
    })
    const rendered = makeAudioBuffer({
      sampleRate: 16_000,
      numberOfChannels: 1,
      duration: 0.5,
      samples: [0.25, -0.25]
    })
    const source = {
      buffer: null as AudioBuffer | null,
      connect: vi.fn(),
      start: vi.fn()
    }
    const startRendering = vi.fn(async () => rendered)
    const createBufferSource = vi.fn(() => source)
    const AudioContextMock = vi.fn(function AudioContext(this: any) {
      this.decodeAudioData = vi.fn(async () => decoded)
      this.close = vi.fn()
    })
    const OfflineAudioContextMock = vi.fn(function OfflineAudioContext(
      this: any,
      channels: number,
      frameCount: number,
      sampleRate: number
    ) {
      this.channels = channels
      this.frameCount = frameCount
      this.sampleRate = sampleRate
      this.destination = {}
      this.createBufferSource = createBufferSource
      this.startRendering = startRendering
    })

    vi.stubGlobal('AudioContext', AudioContextMock)
    vi.stubGlobal('OfflineAudioContext', OfflineAudioContextMock)

    const result = await prepareVoiceMemoAudio(makeBlob())
    const view = new DataView(result.data)

    expect(OfflineAudioContextMock).toHaveBeenCalledWith(1, 8000, 16_000)
    expect(source.buffer).toBe(decoded)
    expect(source.connect).toHaveBeenCalledTimes(1)
    expect(source.start).toHaveBeenCalledWith(0)
    expect(startRendering).toHaveBeenCalledTimes(1)
    expect(result.duration).toBe(0.5)
    expect(view.getUint32(24, true)).toBe(16_000)
    expect(view.getUint32(40, true)).toBe(4)
  })
})
