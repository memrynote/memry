import { mkdir, writeFile } from 'fs/promises'
import path from 'path'

import { createLogger } from '../lib/logger'
import type {
  VoiceModelMainToWorkerMessage,
  VoiceModelProgressPhase,
  VoiceModelWorkerToMainMessage
} from './voice-model-protocol'

const logger = createLogger('Inbox:VoiceModelWorker')

const MODEL_ID = 'Xenova/whisper-small'
const VOICE_MODEL_DTYPE = {
  encoder_model: 'fp32',
  decoder_model: 'q8',
  decoder_model_merged: 'q8',
  decoder_with_past_model: 'q8'
} as const
const VOICE_MODEL_SESSION_OPTIONS = {
  executionProviders: [{ name: 'cpu', useArena: false }],
  enableCpuMemArena: false,
  enableMemPattern: false,
  executionMode: 'sequential',
  graphOptimizationLevel: 'basic',
  intraOpNumThreads: 1,
  interOpNumThreads: 1
} as const

interface ModelProgress {
  status: string
  progress?: number
}

const parentPort = process.parentPort

if (!parentPort) {
  throw new Error('voice-transcription-worker.ts must be run as an Electron utility process')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let transcriber: any = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let loadPromise: Promise<any> | null = null

function getUserDataPath(): string {
  const userDataPath = process.env.MEMRY_USER_DATA_PATH

  if (!userDataPath) {
    throw new Error('MEMRY_USER_DATA_PATH is not configured')
  }

  return userDataPath
}

function getTransformersCacheDir(): string {
  return path.join(getUserDataPath(), 'models', 'transformers')
}

function getVoiceModelMarkerPath(): string {
  return path.join(getUserDataPath(), 'models', 'voice-transcription', 'whisper-small.json')
}

function emitProgress(phase: VoiceModelProgressPhase, progress: number, status: string): void {
  parentPort.postMessage({
    type: 'progress',
    phase,
    progress,
    status
  } satisfies VoiceModelWorkerToMainMessage)
}

async function writeDownloadMarker(): Promise<void> {
  const markerPath = getVoiceModelMarkerPath()
  await mkdir(path.dirname(markerPath), { recursive: true })
  await writeFile(
    markerPath,
    JSON.stringify({
      model: MODEL_ID,
      downloadedAt: new Date().toISOString()
    })
  )
}

async function loadVoicePipeline() {
  if (transcriber) {
    return transcriber
  }

  if (loadPromise) {
    return loadPromise
  }

  emitProgress('loading', 0, 'Initializing Whisper Small...')

  loadPromise = (async () => {
    const { pipeline, env } = await import('@huggingface/transformers')
    env.cacheDir = getTransformersCacheDir()

    transcriber = await pipeline('automatic-speech-recognition', MODEL_ID, {
      device: 'cpu',
      dtype: VOICE_MODEL_DTYPE,
      session_options: VOICE_MODEL_SESSION_OPTIONS,
      progress_callback: (progress: ModelProgress) => {
        if (progress.status === 'progress') {
          emitProgress(
            'downloading',
            Math.round(progress.progress ?? 0),
            'Downloading Whisper Small...'
          )
          return
        }

        if (progress.status === 'done') {
          emitProgress('loading', 95, 'Finalizing Whisper Small...')
        }
      }
    })

    await writeDownloadMarker()
    emitProgress('ready', 100, 'Whisper Small ready')
    logger.info('Voice model ready')
    return transcriber
  })()
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      transcriber = null
      emitProgress('error', 0, message)
      logger.error('Failed to load voice model', { message })
      throw error
    })
    .finally(() => {
      loadPromise = null
    })

  return loadPromise
}

function readChunkId(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3)
  )
}

function decodePcm16Wav(buffer: Buffer): { samples: Float32Array; sampleRate: number } {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)

  if (readChunkId(view, 0) !== 'RIFF' || readChunkId(view, 8) !== 'WAVE') {
    throw new Error('Unsupported WAV file')
  }

  let offset = 12
  let audioFormat = 0
  let channelCount = 0
  let sampleRate = 0
  let bitsPerSample = 0
  let dataOffset = -1
  let dataSize = 0

  while (offset + 8 <= view.byteLength) {
    const chunkId = readChunkId(view, offset)
    const chunkSize = view.getUint32(offset + 4, true)
    const chunkDataOffset = offset + 8

    if (chunkId === 'fmt ') {
      audioFormat = view.getUint16(chunkDataOffset, true)
      channelCount = view.getUint16(chunkDataOffset + 2, true)
      sampleRate = view.getUint32(chunkDataOffset + 4, true)
      bitsPerSample = view.getUint16(chunkDataOffset + 14, true)
    } else if (chunkId === 'data') {
      dataOffset = chunkDataOffset
      dataSize = chunkSize
      break
    }

    offset = chunkDataOffset + chunkSize + (chunkSize % 2)
  }

  if (audioFormat !== 1) {
    throw new Error('Only PCM WAV files are supported')
  }

  if (bitsPerSample !== 16) {
    throw new Error('Only 16-bit WAV files are supported')
  }

  if (channelCount < 1 || sampleRate < 1 || dataOffset < 0 || dataSize < 2) {
    throw new Error('Invalid WAV file')
  }

  const frameCount = Math.floor(dataSize / (channelCount * 2))
  const samples = new Float32Array(frameCount)

  let sampleOffset = dataOffset
  for (let frame = 0; frame < frameCount; frame += 1) {
    let sum = 0
    for (let channel = 0; channel < channelCount; channel += 1) {
      sum += view.getInt16(sampleOffset, true) / 32768
      sampleOffset += 2
    }
    samples[frame] = sum / channelCount
  }

  return { samples, sampleRate }
}

function normalizeTranscriptionResult(result: unknown): string {
  if (typeof result === 'string') {
    return result.trim()
  }

  if (typeof result === 'object' && result !== null && 'text' in result) {
    const { text } = result as { text?: string }
    if (typeof text === 'string') {
      return text.trim()
    }
  }

  throw new Error('Unexpected Whisper Small response')
}

async function handleDownloadModel(
  message: Extract<VoiceModelMainToWorkerMessage, { type: 'download-model' }>
): Promise<void> {
  try {
    await loadVoicePipeline()
    parentPort.postMessage({
      type: 'download-model-result',
      requestId: message.requestId
    } satisfies VoiceModelWorkerToMainMessage)
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error)
    parentPort.postMessage({
      type: 'error',
      requestId: message.requestId,
      error: failure
    } satisfies VoiceModelWorkerToMainMessage)
  }
}

async function handleTranscription(
  message: Extract<VoiceModelMainToWorkerMessage, { type: 'transcribe' }>
): Promise<void> {
  try {
    const pipeline = await loadVoicePipeline()
    const audioBuffer = Buffer.from(message.audioBuffer)
    const { samples, sampleRate } = decodePcm16Wav(audioBuffer)
    const result = await pipeline(samples, {
      sampling_rate: sampleRate,
      language: 'en',
      task: 'transcribe'
    })
    const transcription = normalizeTranscriptionResult(result)

    parentPort.postMessage({
      type: 'transcribe-result',
      requestId: message.requestId,
      transcription
    } satisfies VoiceModelWorkerToMainMessage)
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error)
    parentPort.postMessage({
      type: 'error',
      requestId: message.requestId,
      error: failure
    } satisfies VoiceModelWorkerToMainMessage)
  }
}

parentPort.on('message', (event) => {
  const message = event.data as VoiceModelMainToWorkerMessage

  switch (message.type) {
    case 'download-model':
      void handleDownloadModel(message)
      break
    case 'transcribe':
      void handleTranscription(message)
      break
    case 'shutdown':
      process.exit(0)
  }
})

process.on('uncaughtException', (error) => {
  logger.error('Uncaught voice transcription worker error', {
    message: error instanceof Error ? error.message : String(error)
  })
})

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled voice transcription worker rejection', {
    message: reason instanceof Error ? reason.message : String(reason)
  })
})

parentPort.postMessage({ type: 'ready' } satisfies VoiceModelWorkerToMainMessage)
