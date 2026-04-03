import { app, BrowserWindow, utilityProcess } from 'electron'
import { existsSync } from 'fs'
import path from 'path'

import { SettingsChannels } from '@memry/contracts/ipc-channels'

import { createLogger } from '../lib/logger'
import type {
  VoiceModelMainToWorkerMessage,
  VoiceModelProgressMessage,
  VoiceModelProgressPhase,
  VoiceModelWorkerToMainMessage
} from './voice-model-protocol'

const logger = createLogger('Inbox:VoiceModel')

const MODEL_NAME = 'Whisper Small'
const REQUEST_TIMEOUT_MS = 5 * 60_000
const START_TIMEOUT_MS = 10_000
const SHUTDOWN_TIMEOUT_MS = 3_000

export interface VoiceModelStatus {
  name: string
  downloaded: boolean
  loaded: boolean
  loading: boolean
  error: string | null
}

type PendingRequest = {
  resolve: (value: VoiceModelWorkerToMainMessage) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

function getVoiceModelMarkerPath(): string {
  return path.join(app.getPath('userData'), 'models', 'voice-transcription', 'whisper-small.json')
}

function isVoiceModelDownloaded(): boolean {
  return bridge.isLoaded || existsSync(getVoiceModelMarkerPath())
}

function emitProgress(phase: VoiceModelProgressPhase, progress: number, status: string): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send(SettingsChannels.events.VOICE_MODEL_PROGRESS, {
      phase,
      progress,
      status
    })
  })
}

class VoiceModelBridge {
  private process: ReturnType<typeof utilityProcess.fork> | null = null
  private pendingRequests = new Map<string, PendingRequest>()
  private readyPromise: Promise<void> | null = null
  private requestCounter = 0
  private loaded = false
  private loading = false
  private error: string | null = null
  private shuttingDown = false

  get isLoaded(): boolean {
    return this.loaded
  }

  get status(): VoiceModelStatus {
    return {
      name: MODEL_NAME,
      downloaded: isVoiceModelDownloaded(),
      loaded: this.loaded,
      loading: this.loading,
      error: this.error
    }
  }

  async downloadModel(): Promise<void> {
    await this.start()
    const requestId = this.nextRequestId()
    const response = await this.sendRequest({
      type: 'download-model',
      requestId
    })

    if (response.type === 'error') {
      throw new Error(response.error)
    }

    if (response.type !== 'download-model-result') {
      throw new Error(`Unexpected response type: ${response.type}`)
    }
  }

  async transcribe(audioBuffer: Buffer): Promise<string> {
    await this.start()
    const requestId = this.nextRequestId()
    const response = await this.sendRequest({
      type: 'transcribe',
      requestId,
      audioBuffer: new Uint8Array(audioBuffer)
    })

    if (response.type === 'error') {
      throw new Error(response.error)
    }

    if (response.type !== 'transcribe-result') {
      throw new Error(`Unexpected response type: ${response.type}`)
    }

    return response.transcription
  }

  async stop(): Promise<void> {
    if (!this.process) {
      this.readyPromise = null
      return
    }

    const activeProcess = this.process
    this.shuttingDown = true
    this.loading = false
    this.loaded = false

    activeProcess.postMessage({ type: 'shutdown' } satisfies VoiceModelMainToWorkerMessage)

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        activeProcess.kill()
        resolve()
      }, SHUTDOWN_TIMEOUT_MS)

      activeProcess.once('exit', () => {
        clearTimeout(timeout)
        resolve()
      })
    })

    this.process = null
    this.readyPromise = null
    this.shuttingDown = false
  }

  reset(): void {
    this.shuttingDown = true
    this.process?.kill()
    this.process = null
    this.readyPromise = null
    this.rejectAll(new Error('Voice transcription utility reset'))
    this.loaded = false
    this.loading = false
    this.error = null
    this.shuttingDown = false
  }

  private async start(): Promise<void> {
    if (this.process) {
      await this.readyPromise
      return
    }

    const workerPath = path.join(__dirname, 'voice-transcription-worker.js')
    const child = utilityProcess.fork(workerPath, [], {
      serviceName: 'VoiceTranscription',
      stdio: 'pipe',
      env: {
        ...process.env,
        MEMRY_USER_DATA_PATH: app.getPath('userData')
      },
      allowLoadingUnsignedLibraries: process.platform === 'darwin'
    })

    this.process = child
    child.stdout?.on('data', (chunk: Buffer | string) => {
      const output = chunk.toString().trim()
      if (output) {
        logger.info(`Voice transcription utility stdout: ${output}`)
      }
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const output = chunk.toString().trim()
      if (output) {
        logger.error(`Voice transcription utility stderr: ${output}`)
      }
    })

    this.readyPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const error = new Error('Voice transcription utility failed to start within timeout')
        logger.error('Voice transcription utility start timeout', {
          workerPath,
          pid: child.pid
        })
        this.failProcess(error)
        reject(error)
      }, START_TIMEOUT_MS)

      const cleanup = (): void => {
        clearTimeout(timeout)
        child.off('message', onMessage)
        child.off('error', onFatalError)
        child.off('exit', onExitBeforeReady)
      }

      const onMessage = (message: VoiceModelWorkerToMainMessage): void => {
        if (message.type !== 'ready') return

        cleanup()
        this.setupProcessHandlers(child)
        logger.info('Voice transcription utility ready')
        resolve()
      }

      const onFatalError = (type: string, location: string, report: string): void => {
        cleanup()
        const error = new Error(`Voice transcription utility fatal error: ${type} at ${location}`)
        logger.error('Voice transcription utility fatal error', { type, location, report })
        this.failProcess(error)
        reject(error)
      }

      const onExitBeforeReady = (code: number): void => {
        cleanup()
        const error = new Error(`Voice transcription utility exited unexpectedly (code ${code})`)
        this.failProcess(error)
        reject(error)
      }

      child.on('message', onMessage)
      child.on('error', onFatalError)
      child.on('exit', onExitBeforeReady)
    })

    await this.readyPromise
  }

  private setupProcessHandlers(child: ReturnType<typeof utilityProcess.fork>): void {
    child.on('message', (message: VoiceModelWorkerToMainMessage) => {
      if (message.type === 'ready') {
        return
      }

      if (message.type === 'progress') {
        this.applyProgress(message)
        return
      }

      if ('requestId' in message) {
        const pending = this.pendingRequests.get(message.requestId)
        if (!pending) {
          return
        }

        clearTimeout(pending.timer)
        this.pendingRequests.delete(message.requestId)

        if (message.type === 'error') {
          this.error = message.error
          this.loading = false
          pending.reject(new Error(message.error))
          return
        }

        pending.resolve(message)
      }
    })

    child.on('error', (type: string, location: string, report: string) => {
      const error = new Error(`Voice transcription utility fatal error: ${type} at ${location}`)
      logger.error('Voice transcription utility fatal error', { type, location, report })
      this.failProcess(error)
    })

    child.on('exit', (code: number) => {
      if (this.shuttingDown && code === 0) {
        this.process = null
        this.readyPromise = null
        return
      }

      const error = new Error(`Voice transcription utility exited unexpectedly (code ${code})`)
      this.failProcess(error)
    })
  }

  private applyProgress(message: VoiceModelProgressMessage): void {
    if (message.phase === 'ready') {
      this.loaded = true
      this.loading = false
      this.error = null
    } else if (message.phase === 'error') {
      this.loaded = false
      this.loading = false
      this.error = message.status
    } else {
      this.loading = true
      this.error = null
    }

    emitProgress(message.phase, message.progress, message.status)
  }

  private sendRequest(
    message: Extract<VoiceModelMainToWorkerMessage, { requestId: string }>
  ): Promise<VoiceModelWorkerToMainMessage> {
    if (!this.process) {
      return Promise.reject(new Error('Voice transcription utility is not running'))
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(message.requestId)
        reject(new Error(`Voice transcription request timed out: ${message.type}`))
      }, REQUEST_TIMEOUT_MS)

      this.pendingRequests.set(message.requestId, { resolve, reject, timer })
      this.process!.postMessage(message)
    })
  }

  private nextRequestId(): string {
    this.requestCounter += 1
    return `voice_${this.requestCounter}_${Date.now()}`
  }

  private failProcess(error: Error): void {
    if (this.process) {
      this.process = null
    }
    this.readyPromise = null
    this.loaded = false
    this.loading = false
    this.error = error.message
    this.rejectAll(error)
  }

  private rejectAll(error: Error): void {
    for (const [requestId, pending] of this.pendingRequests) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pendingRequests.delete(requestId)
    }
  }
}

const bridge = new VoiceModelBridge()

export async function downloadVoiceModel(): Promise<boolean> {
  try {
    await bridge.downloadModel()
    return true
  } catch {
    return false
  }
}

export function getVoiceModelStatus(): VoiceModelStatus {
  return bridge.status
}

export async function transcribeWithLocalModel(audioBuffer: Buffer): Promise<string> {
  return bridge.transcribe(audioBuffer)
}

export function unloadVoiceModel(): void {
  bridge.reset()
}

export async function stopVoiceModel(): Promise<void> {
  await bridge.stop()
}
