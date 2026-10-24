const TARGET_SAMPLE_RATE = 16_000
// Matches the detail player's PLAYBACK_BAR_COUNT so playback can render the
// stored envelope directly instead of re-decoding the whole file.
const WAVEFORM_BUCKETS = 60

interface PreparedVoiceMemo {
  data: ArrayBuffer
  duration: number
  format: 'wav'
  waveform: number[]
}

/** Raw RMS per bucket (0..1); consumers normalize for display. */
function computeWaveform(audioBuffer: AudioBuffer, buckets: number): number[] {
  const samples = audioBuffer.getChannelData(0)
  if (samples.length === 0) return []
  const bucketSize = Math.max(1, Math.floor(samples.length / buckets))
  const waveform: number[] = []
  for (let i = 0; i < buckets; i += 1) {
    const start = i * bucketSize
    if (start >= samples.length) break
    const end = Math.min(start + bucketSize, samples.length)
    let sum = 0
    for (let j = start; j < end; j += 1) {
      sum += samples[j] * samples[j]
    }
    waveform.push(Math.round(Math.sqrt(sum / (end - start)) * 10000) / 10000)
  }
  return waveform
}

async function decodeAudioBlob(blob: Blob): Promise<AudioBuffer> {
  // `blob.arrayBuffer()` hands back a buffer nobody else holds, so `decodeAudioData`
  // may detach it directly. Copying it first only doubled the encoded bytes in memory.
  const arrayBuffer = await blob.arrayBuffer()
  const audioContext = new AudioContext()

  try {
    return await audioContext.decodeAudioData(arrayBuffer)
  } finally {
    void audioContext.close()
  }
}

async function renderMonoWavAudio(audioBuffer: AudioBuffer): Promise<AudioBuffer> {
  if (audioBuffer.numberOfChannels === 1 && audioBuffer.sampleRate === TARGET_SAMPLE_RATE) {
    return audioBuffer
  }

  const frameCount = Math.ceil(audioBuffer.duration * TARGET_SAMPLE_RATE)
  const offlineContext = new OfflineAudioContext(1, frameCount, TARGET_SAMPLE_RATE)
  const source = offlineContext.createBufferSource()
  source.buffer = audioBuffer
  source.connect(offlineContext.destination)
  source.start(0)

  try {
    return await offlineContext.startRendering()
  } finally {
    // Rendering is done, so drop the graph's hold on the full-rate decode (~100 MB for a
    // 5-minute stereo memo) before the caller allocates the WAV buffer.
    source.disconnect()
    source.buffer = null
  }
}

function encodePcm16Wav(audioBuffer: AudioBuffer): ArrayBuffer {
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

export async function prepareVoiceMemoAudio(blob: Blob): Promise<PreparedVoiceMemo> {
  // Deliberately not kept in a local: holding the decode would keep the full-rate buffer
  // reachable through the WAV encode and the waveform pass that follow.
  const rendered = await renderMonoWavAudio(await decodeAudioBlob(blob))

  return {
    data: encodePcm16Wav(rendered),
    duration: rendered.duration,
    format: 'wav',
    waveform: computeWaveform(rendered, WAVEFORM_BUCKETS)
  }
}
