import { Worker } from 'worker_threads'
import { join } from 'path'
import { createLogger } from '../lib/logger'
import { trackMainError } from '../telemetry/diagnostics'
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
  startedAt: number
}

const REQUEST_TIMEOUT_MS = 60_000

/**
 * Hard cap on simultaneously in-flight worker requests.
 *
 * Nothing bounded `pendingRequests` before: every entry pins the caller's
 * promise callbacks, which close over the request's items, vault key and
 * signing key. Sync only ever has a handful of batches in flight, so anything
 * near this number means the worker has stopped answering and requests are
 * stacking up faster than they time out. Rejecting at the door makes the caller
 * fall back to main-thread crypto — same crypto, same result — and three such
 * rejections latch the bridge off for the session (see recordRequestFailure).
 */
export const MAX_PENDING_REQUESTS = 1000

/** How often the stale-pending sweep runs while requests are outstanding. */
const PENDING_SWEEP_INTERVAL_MS = 30_000

/**
 * Age at which the sweep considers a pending request abandoned.
 *
 * Deliberately past REQUEST_TIMEOUT_MS: the per-request timer is the primary
 * path and must keep owning the timeout, so the sweep can only ever collect an
 * entry whose own timer never fired. The grace period keeps the two from racing
 * on the same request.
 */
const PENDING_STALE_AFTER_MS = REQUEST_TIMEOUT_MS + 5_000

/**
 * Consecutive failed worker requests before the bridge stops offering itself.
 *
 * `isRunning` can only see that the thread has not exited, so a worker that is
 * alive but never answers keeps being chosen and costs a full
 * REQUEST_TIMEOUT_MS per batch before sync-crypto-batch degrades to
 * main-thread crypto. Counting failures gives that case an exit.
 *
 * 3 rather than 1: a single failure is noise — one transient timeout under load
 * should not cost the session its worker. 3 rather than more: the worst case is
 * paid in whole minutes, and 3 silent batches is a bounded ~3 minutes of
 * degraded-but-correct sync, after which the worker costs nothing for the rest
 * of the session.
 */
export const MAX_CONSECUTIVE_FAILURES = 3

export class SyncWorkerBridge {
  private worker: Worker | null = null
  private pendingRequests = new Map<string, PendingRequest>()
  private readyPromise: Promise<void> | null = null
  private requestCounter = 0
  private consecutiveFailures = 0
  private latchedOff = false
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  /** Non-null for exactly as long as a stop() is inside its shutdown window. */
  private stopPromise: Promise<void> | null = null

  async start(): Promise<void> {
    // stop() keeps `this.worker` non-null for the whole of its 3 s shutdown
    // window, so the guard below cannot tell "running" from "being torn down".
    // Without this wait a start() issued inside that window returned having
    // spawned nothing, reset nothing and awaited no `ready`; stop()'s
    // continuation then nulled the field and left the caller believing a worker
    // was running when there was none, so every later batch rejected with
    // 'Worker not started' and three of those latch the bridge off for the
    // session. Waiting the stop out is what a lifecycle caller means by
    // "start"; the wait is bounded by stop()'s own 3 s timeout, and the loop
    // re-checks in case another stop() began while this one waited. A stop()
    // failure belongs to the stop caller, not to this start().
    while (this.stopPromise) await this.stopPromise.catch(() => {})

    if (this.worker) return

    // A freshly spawned thread is not the thread that failed, so it gets a
    // clean slate. Reaching here after a latch (stop() then start()) is the
    // only in-session way back to worker crypto.
    this.consecutiveFailures = 0
    this.latchedOff = false

    const workerPath = join(__dirname, 'sync-worker.js')
    const worker = new Worker(workerPath)
    this.worker = worker

    this.readyPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.disposeFailedWorker(worker)
        reject(new Error('Worker failed to start within timeout'))
      }, 10_000)

      const initErrorHandler = (err: Error): void => {
        clearTimeout(timeout)
        log.error('Sync worker init error', err)
        this.disposeFailedWorker(worker)
        reject(err)
      }

      const onMessage = (msg: WorkerToMainMessage): void => {
        if (msg.type === 'ready') {
          clearTimeout(timeout)
          worker.off('message', onMessage)
          worker.off('error', initErrorHandler)
          this.setupMessageHandler()
          log.info('Sync worker ready')
          resolve()
        }
      }

      worker.on('message', onMessage)
      worker.on('error', initErrorHandler)
    })

    await this.readyPromise
  }

  // A worker that never reached ready must not stay attached: isRunning would
  // report true and route crypto batches to a dead thread. Detach so callers
  // fall back to main-thread crypto.
  //
  // Scoped to the thread this start() spawned, on the same identity rule as
  // isAbandoned(): a start() that waited out a stop() can have put a live
  // thread in the field before this start()'s 10 s init timeout gets here, and
  // the unscoped version would tear that one down instead.
  private disposeFailedWorker(worker: Worker): void {
    if (this.worker === worker) {
      this.worker = null
      this.readyPromise = null
    }
    worker.removeAllListeners()
    void worker.terminate()
  }

  /**
   * True when `worker` is no longer the thread this bridge routes to.
   *
   * The handlers below are permanent, and stop()'s 3 s timeout walks away from
   * a thread that is still alive: terminate() lands later, and by then a
   * start() may have put a *different* thread in `this.worker`. Anything the
   * abandoned thread says after that must not touch live state — its
   * unconditional `this.worker = null` alone was enough to wedge every later
   * batch on `Worker not started`.
   *
   * Detaching on the way out is what stops the abandoned thread talking to the
   * bridge at all, `message` and `error` included, not just the `exit` that
   * usually gets there first.
   */
  private isAbandoned(worker: Worker): boolean {
    if (worker === this.worker) return false
    worker.removeAllListeners()
    return true
  }

  private setupMessageHandler(): void {
    const worker = this.worker
    if (!worker) return

    worker.on('message', (msg: WorkerToMainMessage) => {
      if (this.isAbandoned(worker)) return

      // `ready` is consumed by start(); `shutdown-ack` is the expected reply to
      // stop() and carries no requestId. Neither is a dropped reply.
      if (msg.type === 'ready' || msg.type === 'shutdown-ack') return

      if ('requestId' in msg) {
        const pending = this.pendingRequests.get(msg.requestId)
        if (pending) {
          clearTimeout(pending.timer)
          this.pendingRequests.delete(msg.requestId)
          if (this.pendingRequests.size === 0) this.stopSweepTimer()
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

    worker.on('error', (err: Error) => {
      if (this.isAbandoned(worker)) return

      log.error('Sync worker error', err)
      this.rejectAll(err)
    })

    worker.on('exit', (code) => {
      if (this.isAbandoned(worker)) return

      if (code !== 0) {
        log.error('Sync worker exited unexpectedly', { code })
        log.warn('Crypto operations will fall back to main thread')
        trackMainError('sync', 'crypto_worker_exited', new Error(`Worker exited with code ${code}`))
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
    this.stopSweepTimer()
  }

  /**
   * Backstop for pending entries whose own timeout never fired — the map is
   * otherwise only ever drained by a reply, a per-request timer, or rejectAll.
   * The interval exists only while requests are outstanding and stops itself as
   * soon as the map empties, so an idle bridge costs no wakeups.
   */
  private ensureSweepTimer(): void {
    if (this.sweepTimer) return
    this.sweepTimer = setInterval(() => this.sweepStalePending(), PENDING_SWEEP_INTERVAL_MS)
    this.sweepTimer.unref?.()
  }

  private stopSweepTimer(): void {
    if (!this.sweepTimer) return
    clearInterval(this.sweepTimer)
    this.sweepTimer = null
  }

  private sweepStalePending(): void {
    const now = Date.now()
    let swept = 0
    for (const [id, pending] of this.pendingRequests) {
      if (now - pending.startedAt <= PENDING_STALE_AFTER_MS) continue
      clearTimeout(pending.timer)
      this.pendingRequests.delete(id)
      pending.reject(new Error('Worker request abandoned: no reply and no timeout'))
      swept++
    }
    if (swept > 0) {
      log.warn('Swept abandoned worker requests', { count: swept })
    }
    if (this.pendingRequests.size === 0) this.stopSweepTimer()
  }

  /**
   * Only worker-infrastructure failures reach here, never a crypto verdict.
   * The worker returns per-item outcomes in-band — `encrypt-batch-result.errors`
   * and `decrypt-batch-result.failures`, including signature mismatches — and
   * never rejects the request for them. A rejection therefore always means the
   * worker was unreachable: not started, timed out, crashed/exited, protocol
   * drift (`{ type: 'error' }`), or an unexpected response type. Latching on
   * these cannot hide a bad item; the main-thread path re-runs the same crypto.
   *
   * The thread is left alive rather than terminated. Terminating buys nothing
   * once the bridge stops routing to it, and it would remove the stop()/start()
   * recovery path above.
   */
  private recordRequestFailure(err: unknown): void {
    this.consecutiveFailures += 1
    if (this.latchedOff || this.consecutiveFailures < MAX_CONSECUTIVE_FAILURES) return

    this.latchedOff = true
    // Only the failure count and the transport error text; crypto error
    // messages never travel this path, so no key material or plaintext.
    log.warn('Sync worker latched off after repeated failures — using main-thread crypto', {
      consecutiveFailures: this.consecutiveFailures,
      error: err instanceof Error ? err.message : String(err)
    })
    // Once per session by construction (latchedOff guard above). A build that
    // ships a broken sync-worker.js must be chartable by platform/version.
    trackMainError('sync', 'crypto_worker_latched', err)
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

    if (this.pendingRequests.size >= MAX_PENDING_REQUESTS) {
      // Never enqueued, so nothing to sweep later. The caller degrades to
      // main-thread crypto rather than waiting behind a wedged worker.
      log.warn('Worker request queue full — rejecting request', {
        pending: this.pendingRequests.size,
        cap: MAX_PENDING_REQUESTS
      })
      return Promise.reject(new Error('Worker request queue full'))
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(msg.requestId)
        if (this.pendingRequests.size === 0) this.stopSweepTimer()
        reject(new Error(`Worker request timed out: ${msg.type}`))
      }, REQUEST_TIMEOUT_MS)

      this.pendingRequests.set(msg.requestId, { resolve, reject, timer, startedAt: Date.now() })
      this.ensureSweepTimer()
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
    errors: Array<{ queueId: string; itemId: string; error: string; code?: 'item_too_large' }>
  }> {
    const requestId = this.nextRequestId()
    try {
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

      this.consecutiveFailures = 0
      return { results: response.results, errors: response.errors }
    } catch (err) {
      this.recordRequestFailure(err)
      throw err
    }
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
    try {
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

      this.consecutiveFailures = 0
      return { results: response.results, failures: response.failures }
    } catch (err) {
      this.recordRequestFailure(err)
      throw err
    }
  }

  // sync-crypto-batch gates every batch on this, so a latched bridge sends it
  // straight to main-thread crypto without a round trip. stop() deliberately
  // checks `this.worker` instead, so a latched-but-alive thread is still shut
  // down cleanly.
  //
  // A thread already told to shut down is not running either: it may never
  // answer again, and a batch handed to it inside the shutdown window buys a
  // full REQUEST_TIMEOUT_MS wait and a latch step for a reply that is not
  // coming. Main-thread crypto is the same crypto and is available now.
  get isRunning(): boolean {
    return this.worker !== null && !this.latchedOff && this.stopPromise === null
  }

  stop(): Promise<void> {
    // A second stop() means the same thing as the one already in flight —
    // posting another shutdown and racing a second exit against the same thread
    // only gives the two overlapping windows to null `this.worker` out from
    // under each other.
    if (this.stopPromise) return this.stopPromise

    const worker = this.worker
    if (!worker) return Promise.resolve()

    this.stopPromise = this.shutdownWorker(worker).finally(() => {
      this.stopPromise = null
    })
    return this.stopPromise
  }

  private async shutdownWorker(worker: Worker): Promise<void> {
    worker.postMessage({ type: 'shutdown' } satisfies MainToWorkerMessage)

    await new Promise<void>((resolve) => {
      const onExit = (): void => {
        this.rejectAll(new Error('Worker exited'))
        clearTimeout(timeout)
        resolve()
      }

      const timeout = setTimeout(() => {
        // Detach before terminating. terminate() still emits 'exit', and a
        // stop()/start() cycle can have handed the bridge a fresh worker by
        // then — the stale handler would reject that worker's in-flight
        // requests with 'Worker exited'.
        worker.off('exit', onExit)
        this.rejectAll(new Error('Worker shutdown timeout'))
        void worker.terminate()
        resolve()
      }, 3_000)

      worker.once('exit', onExit)
    })

    this.worker = null
    log.info('Sync worker stopped')
  }
}
