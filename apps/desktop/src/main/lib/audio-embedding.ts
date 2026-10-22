/**
 * Audio embeddings for voice memos, gated by the user's settings (AI on, and
 * `voiceTranscription.audioSearch` not false).
 *
 * The audio encoder costs a ~189MB download and extra RAM while loaded, so it
 * is opt-out and only reached for a memo that needs it (see
 * voice-embedding-projector.ts). Audio consumers go through here, not through
 * embeddings.ts, so the setting is enforced in one place.
 *
 * @module main/lib/audio-embedding
 */

import { getSetting } from '@main/database/queries/settings'
import { getDatabase } from '../database'
import { getVoiceTranscriptionSettings } from '../inbox/voice-transcription-settings'
import { generateAudioEmbedding } from './embeddings'
import {
  EMBEDDING_AUDIO_MAX_WINDOWS,
  EMBEDDING_AUDIO_SAMPLE_RATE,
  EMBEDDING_AUDIO_WINDOW_SECONDS
} from './embeddings-constants'

const AI_ENABLED_KEY = 'ai.enabled'

/** Clips shorter than this carry too little to embed. */
const MIN_AUDIO_SECONDS = 1

export function isAudioEmbeddingEnabled(): boolean {
  try {
    return (
      getSetting(getDatabase(), AI_ENABLED_KEY) !== 'false' &&
      getVoiceTranscriptionSettings().audioSearch !== false
    )
  } catch {
    return false
  }
}

/**
 * Decode a WAV file (PCM 16/32-bit or float32) to mono samples at the
 * encoder's 16 kHz, averaging channels and resampling linearly when needed.
 * Null for anything else: voice memos are recorded as 16 kHz mono PCM16 WAV
 * (renderer `voice-memo-audio.ts`), so other containers are not decoded here.
 */
export function decodeWavForEmbedding(bytes: Uint8Array): Float32Array | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length < 12 || view.getUint32(0) !== 0x52494646 || view.getUint32(8) !== 0x57415645) {
    return null
  }

  let format = 0
  let channels = 0
  let sampleRate = 0
  let bits = 0
  let dataStart = -1
  let dataEnd = 0
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const id = view.getUint32(offset)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (id === 0x666d7420 && body + 16 <= bytes.length) {
      format = view.getUint16(body, true)
      channels = view.getUint16(body + 2, true)
      sampleRate = view.getUint32(body + 4, true)
      bits = view.getUint16(body + 14, true)
      // WAVE_FORMAT_EXTENSIBLE carries the real format in its sub-format GUID.
      if (format === 0xfffe && body + 26 <= bytes.length) format = view.getUint16(body + 24, true)
    } else if (id === 0x64617461) {
      dataStart = body
      dataEnd = Math.min(bytes.length, body + size)
      break
    }
    offset = body + size + (size % 2)
  }

  const bytesPerSample = bits / 8
  const isPcm = format === 1 && [2, 4].includes(bytesPerSample)
  const isFloat = format === 3 && bits === 32
  if (dataStart < 0 || channels < 1 || sampleRate < 1 || (!isPcm && !isFloat)) return null

  const frames = Math.floor((dataEnd - dataStart) / (bytesPerSample * channels))
  const mono = new Float32Array(frames)
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0
    for (let channel = 0; channel < channels; channel++) {
      const at = dataStart + (frame * channels + channel) * bytesPerSample
      if (isFloat) sum += view.getFloat32(at, true)
      else if (bytesPerSample === 2) sum += view.getInt16(at, true) / 32768
      else sum += view.getInt32(at, true) / 2147483648
    }
    mono[frame] = sum / channels
  }
  if (sampleRate === EMBEDDING_AUDIO_SAMPLE_RATE) return mono

  const outLength = Math.floor((frames * EMBEDDING_AUDIO_SAMPLE_RATE) / sampleRate)
  const out = new Float32Array(outLength)
  const step = sampleRate / EMBEDDING_AUDIO_SAMPLE_RATE
  for (let i = 0; i < outLength; i++) {
    const position = i * step
    const left = Math.floor(position)
    const right = Math.min(left + 1, frames - 1)
    out[i] = mono[left] + (mono[right] - mono[left]) * (position - left)
  }
  return out
}

/** Consecutive windows the encoder can take, capped so a very long recording stays bounded. */
export function splitAudioWindows(samples: Float32Array): Float32Array[] {
  const size = EMBEDDING_AUDIO_WINDOW_SECONDS * EMBEDDING_AUDIO_SAMPLE_RATE
  const windows: Float32Array[] = []
  for (let start = 0; start < samples.length; start += size) {
    if (windows.length === EMBEDDING_AUDIO_MAX_WINDOWS) break
    windows.push(samples.subarray(start, Math.min(start + size, samples.length)))
  }
  return windows
}

/**
 * One vector per window of a recording, or null when audio embeddings are off,
 * the recording is too short, or any window fails (a partial set would index
 * only the start of the recording).
 */
export async function embedAudio(samples: Float32Array): Promise<Float32Array[] | null> {
  if (!isAudioEmbeddingEnabled()) return null
  if (samples.length < MIN_AUDIO_SECONDS * EMBEDDING_AUDIO_SAMPLE_RATE) return null

  const vectors: Float32Array[] = []
  for (const window of splitAudioWindows(samples)) {
    // A short tail adds nothing the previous window did not cover.
    if (vectors.length > 0 && window.length < MIN_AUDIO_SECONDS * EMBEDDING_AUDIO_SAMPLE_RATE) {
      break
    }
    const vector = await generateAudioEmbedding(window)
    if (!vector) return null
    vectors.push(vector)
  }
  return vectors
}
