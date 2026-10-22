import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getSetting: vi.fn(),
  voiceSettings: vi.fn(),
  generateAudioEmbedding: vi.fn()
}))

vi.mock('../database', () => ({ getDatabase: vi.fn(() => ({})) }))
vi.mock('@main/database/queries/settings', () => ({ getSetting: mocks.getSetting }))
vi.mock('../inbox/voice-transcription-settings', () => ({
  getVoiceTranscriptionSettings: mocks.voiceSettings
}))
vi.mock('./embeddings', () => ({ generateAudioEmbedding: mocks.generateAudioEmbedding }))

import {
  decodeWavForEmbedding,
  embedAudio,
  isAudioEmbeddingEnabled,
  splitAudioWindows
} from './audio-embedding'

function wav(options: {
  rate: number
  channels?: number
  samples: number[]
  format?: 'pcm16' | 'float32'
}): Uint8Array {
  const channels = options.channels ?? 1
  const float = options.format === 'float32'
  const bytes = float ? 4 : 2
  const data = new DataView(new ArrayBuffer(options.samples.length * bytes))
  options.samples.forEach((value, i) =>
    float
      ? data.setFloat32(i * 4, value, true)
      : data.setInt16(i * 2, Math.round(value * 32767), true)
  )
  const out = new DataView(new ArrayBuffer(44 + data.byteLength))
  const tag = (at: number, text: string): void =>
    [...text].forEach((c, i) => out.setUint8(at + i, c.charCodeAt(0)))
  tag(0, 'RIFF')
  out.setUint32(4, 36 + data.byteLength, true)
  tag(8, 'WAVE')
  tag(12, 'fmt ')
  out.setUint32(16, 16, true)
  out.setUint16(20, float ? 3 : 1, true)
  out.setUint16(22, channels, true)
  out.setUint32(24, options.rate, true)
  out.setUint32(28, options.rate * channels * bytes, true)
  out.setUint16(32, channels * bytes, true)
  out.setUint16(34, bytes * 8, true)
  tag(36, 'data')
  out.setUint32(40, data.byteLength, true)
  new Uint8Array(out.buffer).set(new Uint8Array(data.buffer), 44)
  return new Uint8Array(out.buffer)
}

describe('decodeWavForEmbedding', () => {
  it('reads 16 kHz mono PCM16 voice memos as-is', () => {
    const decoded = decodeWavForEmbedding(wav({ rate: 16_000, samples: [0, 0.5, -0.5] }))!
    expect(Array.from(decoded)).toEqual([0, expect.closeTo(0.5, 3), expect.closeTo(-0.5, 3)])
  })

  it('averages channels and resamples to 16 kHz', () => {
    const stereo = wav({
      rate: 48_000,
      channels: 2,
      samples: Array.from({ length: 96 }, (_, i) => (i % 2 ? 0.5 : -0.5))
    })
    const decoded = decodeWavForEmbedding(stereo)!
    expect(decoded).toHaveLength(16)
    expect(Math.max(...decoded.map(Math.abs))).toBeLessThan(0.001)
  })

  it('reads float32 and rejects anything that is not a WAV', () => {
    expect(
      decodeWavForEmbedding(wav({ rate: 16_000, format: 'float32', samples: [0.25] }))![0]
    ).toBe(0.25)
    expect(decodeWavForEmbedding(new TextEncoder().encode('not audio at all'))).toBeNull()
  })
})

describe('splitAudioWindows', () => {
  it('splits past the 300s window and caps the recording at 12 windows', () => {
    const rate = 16_000
    expect(splitAudioWindows(new Float32Array(rate * 650)).map((w) => w.length / rate)).toEqual([
      300, 300, 50
    ])
    expect(splitAudioWindows(new Float32Array(rate * 300 * 15))).toHaveLength(12)
  })
})

describe('embedAudio', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.getSetting.mockReturnValue(undefined)
    mocks.voiceSettings.mockReturnValue({ provider: 'local', memoNameMode: 'transcript' })
    mocks.generateAudioEmbedding.mockResolvedValue(new Float32Array(256))
  })

  it('embeds each window, dropping a sub-second tail', async () => {
    const vectors = await embedAudio(new Float32Array(16_000 * 300 + 8_000))
    expect(vectors).toHaveLength(1)
    expect(mocks.generateAudioEmbedding).toHaveBeenCalledTimes(1)
  })

  it('never reaches the encoder when the setting is off, AI is off, or the clip is too short', async () => {
    mocks.voiceSettings.mockReturnValue({
      provider: 'local',
      memoNameMode: 'transcript',
      audioSearch: false
    })
    expect(isAudioEmbeddingEnabled()).toBe(false)
    expect(await embedAudio(new Float32Array(32_000))).toBeNull()

    mocks.getSetting.mockImplementation((_db, key) => (key === 'ai.enabled' ? 'false' : undefined))
    expect(await embedAudio(new Float32Array(32_000))).toBeNull()

    mocks.getSetting.mockReturnValue(undefined)
    mocks.voiceSettings.mockReturnValue({ provider: 'local', memoNameMode: 'transcript' })
    expect(await embedAudio(new Float32Array(8_000))).toBeNull()
    expect(mocks.generateAudioEmbedding).not.toHaveBeenCalled()
  })

  it('returns null instead of a partial set when a window fails', async () => {
    mocks.generateAudioEmbedding
      .mockResolvedValueOnce(new Float32Array(256))
      .mockResolvedValueOnce(null)
    expect(await embedAudio(new Float32Array(16_000 * 400))).toBeNull()
  })
})
