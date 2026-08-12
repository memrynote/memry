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

function makeBlob(bytes: ArrayBuffer = new ArrayBuffer(8)): Blob {
  return {
    arrayBuffer: vi.fn(async () => bytes)
  } as unknown as Blob
}

/**
 * Byte-for-byte copy of the pcm16 WAV encoder as it stood before the allocation fix,
 * kept as an oracle so the stored audio format can never drift.
 */
function encodePcm16WavReference(audioBuffer: AudioBuffer): ArrayBuffer {
  const channelData = audioBuffer.getChannelData(0)
  const frameCount = channelData.length
  const dataSize = frameCount * 2
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  const writeString = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index))
    }
  }

  writeString(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, audioBuffer.sampleRate, true)
  view.setUint32(28, audioBuffer.sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeString(36, 'data')
  view.setUint32(40, dataSize, true)

  let offset = 44
  for (let index = 0; index < frameCount; index += 1) {
    const sample = Math.max(-1, Math.min(1, channelData[index] ?? 0))
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
    offset += 2
  }

  return buffer
}

/** Deterministic signal covering silence, both polarities, and out-of-range clipping. */
function makeRepresentativeSamples(count: number): number[] {
  const samples: number[] = []
  for (let index = 0; index < count; index += 1) {
    samples.push(Math.sin(index / 7) * (1.4 - (index % 100) / 100))
  }
  samples[0] = 0
  samples[1] = -1
  samples[2] = 1
  samples[3] = -3
  samples[4] = 3
  return samples
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
      disconnect: vi.fn(),
      start: vi.fn()
    }
    let bufferAtRender: AudioBuffer | null = null
    const startRendering = vi.fn(async () => {
      bufferAtRender = source.buffer
      return rendered
    })
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
    expect(bufferAtRender).toBe(decoded)
    expect(source.connect).toHaveBeenCalledTimes(1)
    expect(source.start).toHaveBeenCalledWith(0)
    expect(startRendering).toHaveBeenCalledTimes(1)
    expect(result.duration).toBe(0.5)
    expect(view.getUint32(24, true)).toBe(16_000)
    expect(view.getUint32(40, true)).toBe(4)
    expect(source.disconnect).toHaveBeenCalledTimes(1)
    expect(source.buffer).toBeNull()
  })

  it('decodes the blob buffer in place instead of copying the encoded bytes', async () => {
    const encodedBytes = new ArrayBuffer(64)
    const slice = vi.spyOn(encodedBytes, 'slice')
    const decoded = makeAudioBuffer({
      sampleRate: 16_000,
      numberOfChannels: 1,
      duration: 0.1,
      samples: [0.5]
    })
    const decodeAudioData = vi.fn(async () => decoded)
    const AudioContextMock = vi.fn(function AudioContext(this: any) {
      this.decodeAudioData = decodeAudioData
      this.close = vi.fn()
    })

    vi.stubGlobal('AudioContext', AudioContextMock)
    vi.stubGlobal('OfflineAudioContext', vi.fn())

    await prepareVoiceMemoAudio(makeBlob(encodedBytes))

    expect(decodeAudioData).toHaveBeenCalledWith(encodedBytes)
    expect(slice).not.toHaveBeenCalled()
  })

  it('releases the decoded buffer from the render graph before encoding the wav', async () => {
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
      disconnect: vi.fn(),
      start: vi.fn()
    }
    const AudioContextMock = vi.fn(function AudioContext(this: any) {
      this.decodeAudioData = vi.fn(async () => decoded)
      this.close = vi.fn()
    })
    const OfflineAudioContextMock = vi.fn(function OfflineAudioContext(this: any) {
      this.destination = {}
      this.createBufferSource = vi.fn(() => source)
      this.startRendering = vi.fn(async () => rendered)
    })

    vi.stubGlobal('AudioContext', AudioContextMock)
    vi.stubGlobal('OfflineAudioContext', OfflineAudioContextMock)

    await prepareVoiceMemoAudio(makeBlob())

    const releasedAt = (source.disconnect.mock.invocationCallOrder[0] ?? Infinity) as number
    const encodedAt = ((rendered.getChannelData as unknown as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0] ?? -Infinity) as number

    expect(source.buffer).toBeNull()
    expect(releasedAt).toBeLessThan(encodedAt)
  })

  it('releases the decoded buffer when rendering fails', async () => {
    const decoded = makeAudioBuffer({
      sampleRate: 48_000,
      numberOfChannels: 2,
      duration: 0.5,
      samples: [0.25]
    })
    const source = {
      buffer: null as AudioBuffer | null,
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn()
    }
    const AudioContextMock = vi.fn(function AudioContext(this: any) {
      this.decodeAudioData = vi.fn(async () => decoded)
      this.close = vi.fn()
    })
    const OfflineAudioContextMock = vi.fn(function OfflineAudioContext(this: any) {
      this.destination = {}
      this.createBufferSource = vi.fn(() => source)
      this.startRendering = vi.fn(async () => {
        throw new Error('render failed')
      })
    })

    vi.stubGlobal('AudioContext', AudioContextMock)
    vi.stubGlobal('OfflineAudioContext', OfflineAudioContextMock)

    await expect(prepareVoiceMemoAudio(makeBlob())).rejects.toThrow('render failed')

    expect(source.disconnect).toHaveBeenCalledTimes(1)
    expect(source.buffer).toBeNull()
  })

  it('produces bytes identical to the previous encoder for a representative memo', async () => {
    const samples = makeRepresentativeSamples(5_000)
    const decoded = makeAudioBuffer({
      sampleRate: 16_000,
      numberOfChannels: 1,
      duration: samples.length / 16_000,
      samples
    })
    const AudioContextMock = vi.fn(function AudioContext(this: any) {
      this.decodeAudioData = vi.fn(async () => decoded)
      this.close = vi.fn()
    })

    vi.stubGlobal('AudioContext', AudioContextMock)
    vi.stubGlobal('OfflineAudioContext', vi.fn())

    const result = await prepareVoiceMemoAudio(makeBlob())
    const expected = encodePcm16WavReference(decoded)

    expect(result.data.byteLength).toBe(44 + samples.length * 2)
    expect(new Uint8Array(result.data)).toEqual(new Uint8Array(expected))
  })
})
