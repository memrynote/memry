import { Worker } from 'worker_threads'
import { join } from 'path'
import { createLogger } from '../lib/logger'
import type {
  MainToWorkerMessage,
  WorkerToMainMessage,
  RawPushItem,
  EncryptedPushResult,
  PullItemForDecrypt,
  DecryptedPullItem,
  DecryptionFailure
} from './worker-protocol'

const log = createLogger('SyncWorkerBridge')

type PendingRequest = {
  resolve: (value: WorkerToMainMessage) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const REQUEST_TIMEOUT_MS = 60_000

export class SyncWorkerBridge {
  private worker: Worker | null = null
  private pendingRequests = new Map<string, PendingRequest>()
  private readyPromise: Promise<void> | null = null
  private requestCounter = 0

  async start(): Promise<void> {
    if (this.worker) return

    const workerPath = join(__dirname, 'sync-worker.js')
    this.worker = new Worker(workerPath)

    this.readyPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.disposeFailedWorker()
        reject(new Error('Worker failed to start within timeout'))
      }, 10_000)

      const initErrorHandler = (err: Error): void => {
        clearTimeout(timeout)
        log.error('Sync worker init error', err)
        this.disposeFailedWorker()
        reject(err)
      }

      const onMessage = (msg: WorkerToMainMessage): void => {
        if (msg.type === 'ready') {
          clearTimeout(timeout)
          this.worker!.off('message', onMessage)
          this.worker!.off('error', initErrorHandler)
          this.setupMessageHandler()
          log.info('Sync worker ready')
          resolve()
        }
      }

      this.worker!.on('message', onMessage)
      this.worker!.on('error', initErrorHandler)
    })

    await this.readyPromise
  }

  // A worker that never reached ready must not stay attached: isRunning would
  // report true and route crypto batches to a dead thread. Detach so callers
  // fall back to main-thread crypto.
  private disposeFailedWorker(): void {
    const worker = this.worker
    this.worker = null
    this.readyPromise = null
    if (worker) {
      worker.removeAllListeners()
      void worker.terminate()
    }
  }

  private setupMessageHandler(): void {
    if (!this.worker) return

    this.worker.on('message', (msg: WorkerToMainMessage) => {
      // `ready` is consumed by start(); `shutdown-ack` is the expected reply to
      // stop() and carries no requestId. Neither is a dropped reply.
      if (msg.type === 'ready' || msg.type === 'shutdown-ack') return

      if ('requestId' in msg) {
        const pending = this.pendingRequests.get(msg.requestId)
        if (pending) {
          clearTimeout(pending.timer)
          this.pendingRequests.delete(msg.requestId)
          pending.resolve(msg)
          return
        }
        // Late reply after a timeout, or a requestId this bridge never issued.
        // Silently dropping it left the caller's 60s timeout unexplained in
        // user logs. requestId is a counter + timestamp, never key material.
        log.warn('Dropped worker reply with no pending request', {
          type: msg.type,
          requestId: msg.requestId
        })
        return
      }

      log.warn('Dropped off-protocol worker message', {
        type: (msg as { type?: unknown }).type
      })
    })

    this.worker.on('error', (err: Error) => {
      log.error('Sync worker error', err)
      this.rejectAll(err)
    })

    this.worker.on('exit', (code) => {
      if (code !== 0) {
        log.error('Sync worker exited unexpectedly', { code })
        log.warn('Crypto operations will fall back to main thread')
        this.rejectAll(new Error(`Worker exited with code ${code}`))
      }
      this.worker = null
    })
  }

  private rejectAll(err: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer)
      pending.reject(err)
      this.pendingRequests.delete(id)
    }
  }

  private nextRequestId(): string {
    return `req_${++this.requestCounter}_${Date.now()}`
  }

  private sendRequest(
    msg: MainToWorkerMessage & { requestId: string }
  ): Promise<WorkerToMainMessage> {
    if (!this.worker) {
      return Promise.reject(new Error('Worker not started'))
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(msg.requestId)
        reject(new Error(`Worker request timed out: ${msg.type}`))
      }, REQUEST_TIMEOUT_MS)

      this.pendingRequests.set(msg.requestId, { resolve, reject, timer })
      this.worker!.postMessage(msg)
    })
  }

  async encryptBatch(
    items: RawPushItem[],
    vaultKey: Uint8Array,
    signingSecretKey: Uint8Array,
    signerDeviceId: string
  ): Promise<{
    results: EncryptedPushResult[]
    errors: Array<{ queueId: string; itemId: string; error: string }>
  }> {
    const requestId = this.nextRequestId()
    const response = await this.sendRequest({
      type: 'encrypt-batch',
      requestId,
      items,
      vaultKey: new Uint8Array(vaultKey),
      signingSecretKey: new Uint8Array(signingSecretKey),
      signerDeviceId
    })

    if (response.type === 'error') {
      throw new Error(response.error)
    }
    if (response.type !== 'encrypt-batch-result') {
      throw new Error(`Unexpected response type: ${response.type}`)
    }

    return { results: response.results, errors: response.errors }
  }

  async decryptBatch(
    items: PullItemForDecrypt[],
    vaultKey: Uint8Array,
    signerKeys: Record<string, string>
  ): Promise<{
    results: DecryptedPullItem[]
    failures: DecryptionFailure[]
  }> {
    const requestId = this.nextRequestId()
    const response = await this.sendRequest({
      type: 'decrypt-batch',
      requestId,
      items,
      vaultKey: new Uint8Array(vaultKey),
      signerKeys
    })

    if (response.type === 'error') {
      throw new Error(response.error)
    }
    if (response.type !== 'decrypt-batch-result') {
      throw new Error(`Unexpected response type: ${response.type}`)
    }

    return { results: response.results, failures: response.failures }
  }

  get isRunning(): boolean {
    return this.worker !== null
  }

  async stop(): Promise<void> {
    if (!this.worker) return

    this.worker.postMessage({ type: 'shutdown' } satisfies MainToWorkerMessage)

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.rejectAll(new Error('Worker shutdown timeout'))
        void this.worker?.terminate()
        resolve()
      }, 3_000)

      this.worker!.once('exit', () => {
        this.rejectAll(new Error('Worker exited'))
        clearTimeout(timeout)
        resolve()
      })
    })

    this.worker = null
    log.info('Sync worker stopped')
  }
}
