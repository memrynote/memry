import { app, utilityProcess } from 'electron'
import path from 'path'

import { createLogger } from '../lib/logger'
import { getLogShip } from '../telemetry/log-ship'
import type {
  ImageProcessingMainToWorkerMessage,
  ImageProcessingWorkerToMainMessage,
  InboxImageMetadataPayload
} from './protocol'

const logger = createLogger('ImageProcessing')

const REQUEST_TIMEOUT_MS = 60_000
const START_TIMEOUT_MS = 10_000
const SHUTDOWN_TIMEOUT_MS = 3_000
const IDLE_SHUTDOWN_MS = 30_000
// Bounds how many requests are posted to the worker (and therefore how many
// request timeout timers exist) at once. Queued work waits without a timer so a
// burst cannot time out while it is merely waiting its turn.
const MAX_IN_FLIGHT_REQUESTS = 4
// Backstop so a runaway caller cannot grow the wait queue without limit.
const MAX_QUEUED_REQUESTS = 256

export interface ImageProcessingThumbnailResult {
  data: Buffer
  width: number
  height: number
  format: 'webp' | 'png'
}

export interface InboxImageProcessingResult {
  metadata: InboxImageMetadataPayload
  thumbnailData: Buffer | null
}

type PendingRequest = {
  resolve: (value: ImageProcessingWorkerToMainMessage) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type QueuedRequest = {
  message: Extract<ImageProcessingMainToWorkerMessage, { requestId: string }>
  resolve: (value: ImageProcessingWorkerToMainMessage) => void
  reject: (error: Error) => void
}

class ImageProcessingBridge {
  private process: ReturnType<typeof utilityProcess.fork> | null = null
  private pendingRequests = new Map<string, PendingRequest>()
  private queuedRequests: QueuedRequest[] = []
  private readyPromise: Promise<void> | null = null
  private requestCounter = 0
  private shuttingDown = false
  private idleShutdownTimer: ReturnType<typeof setTimeout> | null = null

  async generateThumbnail(
    filePath: string,
    mimeType: string
  ): Promise<ImageProcessingThumbnailResult | null> {
    await this.start()
    const requestId = this.nextRequestId()
    const response = await this.sendRequest({
      type: 'generate-thumbnail',
      requestId,
      filePath,
      mimeType
    })

    if (response.type === 'error') {
      throw new Error(response.error)
    }

    if (response.type !== 'thumbnail-result') {
      throw new Error(`Unexpected response type: ${response.type}`)
    }

    if (!response.result) {
      return null
    }

    return {
      data: Buffer.from(response.result.data),
      width: response.result.width,
      height: response.result.height,
      format: response.result.format
    }
  }

  async processInboxImage(filePath: string): Promise<InboxImageProcessingResult | null> {
    await this.start()
    const requestId = this.nextRequestId()
    const response = await this.sendRequest({
      type: 'process-inbox-image',
      requestId,
      filePath
    })

    if (response.type === 'error') {
      throw new Error(response.error)
    }

    if (response.type !== 'inbox-image-result') {
      throw new Error(`Unexpected response type: ${response.type}`)
    }

    if (!response.result) {
      return null
    }

    return {
      metadata: response.result.metadata,
      thumbnailData: response.result.thumbnailData
        ? Buffer.from(response.result.thumbnailData)
        : null
    }
  }

  async stop(): Promise<void> {
    this.clearIdleShutdown()

    if (!this.process) {
      this.readyPromise = null
      return
    }

    const activeProcess = this.process
    this.shuttingDown = true
    activeProcess.postMessage({ type: 'shutdown' } satisfies ImageProcessingMainToWorkerMessage)

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
    this.rejectAll(new Error('Image processing utility stopped'))
  }

  reset(): void {
    this.shuttingDown = true
    this.clearIdleShutdown()
    this.process?.kill()
    this.process = null
    this.readyPromise = null
    this.rejectAll(new Error('Image processing utility reset'))
    this.shuttingDown = false
  }

  private async start(): Promise<void> {
    this.clearIdleShutdown()

    if (this.process) {
      await this.readyPromise
      return
    }

    const workerPath = path.join(__dirname, 'image-processing-worker.js')
    const child = utilityProcess.fork(workerPath, [], {
      serviceName: 'ImageProcessing',
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
        logger.info(`Image processing utility stdout: ${output}`)
      }
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const output = chunk.toString().trim()
      if (output) {
        logger.error(`Image processing utility stderr: ${output}`)
      }
    })

    this.readyPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const error = new Error('Image processing utility failed to start within timeout')
        logger.error('Image processing utility start timeout', {
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

      const onMessage = (message: ImageProcessingWorkerToMainMessage): void => {
        if (message.type === 'log') {
          getLogShip()?.ingestForwarded(message.record, 'ImageProcessing')
          return
        }

        if (message.type !== 'ready') return

        cleanup()
        this.setupProcessHandlers(child)
        logger.info('Image processing utility ready')
        resolve()
      }

      const onFatalError = (type: string, location: string, report: string): void => {
        cleanup()
        const error = new Error(`Image processing utility fatal error: ${type} at ${location}`)
        logger.error('Image processing utility fatal error', { type, location, report })
        this.failProcess(error)
        reject(error)
      }

      const onExitBeforeReady = (code: number): void => {
        cleanup()
        const error = new Error(`Image processing utility exited unexpectedly (code ${code})`)
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
    child.on('message', (message: ImageProcessingWorkerToMainMessage) => {
      if (message.type === 'log') {
        getLogShip()?.ingestForwarded(message.record, 'ImageProcessing')
        return
      }

      if (message.type === 'ready') {
        return
      }

      if ('requestId' in message) {
        const pending = this.pendingRequests.get(message.requestId)
        if (!pending) {
          return
        }

        clearTimeout(pending.timer)
        this.pendingRequests.delete(message.requestId)
        this.drainQueue()

        if (message.type === 'error') {
          this.scheduleIdleShutdown()
          pending.reject(new Error(message.error))
          return
        }

        this.scheduleIdleShutdown()
        pending.resolve(message)
      }
    })

    child.on('error', (type: string, location: string, report: string) => {
      const error = new Error(`Image processing utility fatal error: ${type} at ${location}`)
      logger.error('Image processing utility fatal error', { type, location, report })
      this.failProcess(error)
    })

    child.on('exit', (code: number) => {
      if (this.shuttingDown && code === 0) {
        this.process = null
        this.readyPromise = null
        return
      }

      const error = new Error(`Image processing utility exited unexpectedly (code ${code})`)
      this.failProcess(error)
    })
  }

  private sendRequest(
    message: Extract<ImageProcessingMainToWorkerMessage, { requestId: string }>
  ): Promise<ImageProcessingWorkerToMainMessage> {
    if (!this.process) {
      return Promise.reject(new Error('Image processing utility is not running'))
    }

    if (this.queuedRequests.length >= MAX_QUEUED_REQUESTS) {
      logger.warn('Image processing queue is full, rejecting request', {
        type: message.type,
        queued: this.queuedRequests.length,
        inFlight: this.pendingRequests.size
      })
      return Promise.reject(
        new Error(
          `Image processing is busy (${MAX_QUEUED_REQUESTS} images already waiting); try again once the current images finish`
        )
      )
    }

    this.clearIdleShutdown()

    return new Promise((resolve, reject) => {
      this.queuedRequests.push({ message, resolve, reject })
      this.drainQueue()
    })
  }

  // Only ever called while the process is alive: every path that clears
  // `this.process` also runs `rejectAll`, which empties the queue.
  private drainQueue(): void {
    while (this.queuedRequests.length > 0 && this.pendingRequests.size < MAX_IN_FLIGHT_REQUESTS) {
      const next = this.queuedRequests.shift()!

      const timer = setTimeout(() => {
        this.pendingRequests.delete(next.message.requestId)
        this.drainQueue()
        this.scheduleIdleShutdown()
        next.reject(new Error(`Image processing request timed out: ${next.message.type}`))
      }, REQUEST_TIMEOUT_MS)

      this.pendingRequests.set(next.message.requestId, {
        resolve: next.resolve,
        reject: next.reject,
        timer
      })
      this.process!.postMessage(next.message)
    }
  }

  private nextRequestId(): string {
    this.requestCounter += 1
    return `image_${this.requestCounter}_${Date.now()}`
  }

  private failProcess(error: Error): void {
    this.clearIdleShutdown()
    if (this.process) {
      this.process = null
    }
    this.readyPromise = null
    this.rejectAll(error)
  }

  private rejectAll(error: Error): void {
    for (const [requestId, pending] of this.pendingRequests) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pendingRequests.delete(requestId)
    }

    const queued = this.queuedRequests
    this.queuedRequests = []
    for (const request of queued) {
      request.reject(error)
    }
  }

  private scheduleIdleShutdown(): void {
    this.clearIdleShutdown()

    if (!this.process || this.pendingRequests.size > 0 || this.shuttingDown) {
      return
    }

    this.idleShutdownTimer = setTimeout(() => {
      this.idleShutdownTimer = null
      if (!this.process || this.pendingRequests.size > 0 || this.shuttingDown) {
        return
      }

      void this.stop().catch((error) => {
        logger.warn('Image processing utility idle shutdown failed', {
          error: error instanceof Error ? error.message : String(error)
        })
      })
    }, IDLE_SHUTDOWN_MS)
  }

  private clearIdleShutdown(): void {
    if (!this.idleShutdownTimer) {
      return
    }

    clearTimeout(this.idleShutdownTimer)
    this.idleShutdownTimer = null
  }
}

const bridge = new ImageProcessingBridge()

export function generateThumbnailInImageProcess(
  filePath: string,
  mimeType: string
): Promise<ImageProcessingThumbnailResult | null> {
  return bridge.generateThumbnail(filePath, mimeType)
}

export function processInboxImageAttachment(
  filePath: string
): Promise<InboxImageProcessingResult | null> {
  return bridge.processInboxImage(filePath)
}

export function resetImageProcessingForTests(): void {
  bridge.reset()
}

export async function stopImageProcessing(): Promise<void> {
  await bridge.stop()
}
