import { createLogger } from '../../lib/logger'
import { EVENT_CHANNELS } from '@memry/contracts/ipc-events'
import type { QueueClearedEvent, SyncStatusChangedEvent } from '@memry/contracts/ipc-events'
import type { PushItem, PushResponse, SyncItemType } from '@memry/contracts/sync-api'
import { RECORD_CLOCK_REQUIRED_ITEM_TYPES, RecordPushItemSchema } from '@memry/contracts/sync-api'
import { secureCleanup } from '../../crypto/index'
import { encryptPushBatch } from '../sync-crypto-batch'
import { getHandler, getRemoteSyncAdapter } from '../item-handlers'
import { mergeUnknownPayloadFields } from '../unknown-fields'
import { coalesceSyncOperations } from '@memry/sync-client/queue'
import { withRetry, type RetryResult } from '@memry/sync-client/retry'
import { engineAuthRetryDeps, withAuthRetry } from '../auth-retry'
import { postToServer, RateLimitError, SyncServerError } from '../http-client'
import { classifyError } from '../sync-errors'
import { syncErrorTelemetry } from '../sync-error-telemetry'
import { isBinaryFileType } from '@memry/shared/file-types'
import { isNoteKnownDeleted } from '../pending-deletes'
import { SyncTimer } from '@memry/sync-client/sync-timer'
import { trackMainEvent } from '../../telemetry/track'
import { PushLagTrace } from './sync-latency-telemetry'
import type { SyncContext } from './sync-context'
import type { SyncStateManager } from './sync-state-manager'
import {
  MAX_PUSH_ITERATIONS,
  MIN_PUSH_BATCH_SIZE,
  PUSH_CEILING_RAISE_AFTER_CLEAN_PUSHES,
  YIELD_EVERY_N_ITEMS,
  CRDT_SNAPSHOT_CONCURRENCY,
  PUSH_DEBOUNCE_MS,
  yieldToEventLoop
} from './sync-context'

const log = createLogger('PushCoordinator')

const RECORD_CLOCK_REQUIRED_TYPE_SET = new Set<string>(RECORD_CLOCK_REQUIRED_ITEM_TYPES)

export class PushCoordinator {
  private ctx: SyncContext
  private stateManager: SyncStateManager
  private pushDebounceTimer: ReturnType<typeof setTimeout> | null = null
  private pendingPushRequested = false
  private lastPushStartedAt = Number.NEGATIVE_INFINITY
  private awaitedCycle: Promise<void> | null = null
  private stopped = false
  /**
   * Batch size the server was last able to take, or null while the configured
   * size is still believed good.
   *
   * Kept on the instance, not per run: a vault big enough to be refused at 100
   * is refused at 100 on every cycle too, so re-discovering the ceiling each
   * time would spend the same handful of doomed requests forever. It doubles
   * back after PUSH_CEILING_RAISE_AFTER_CLEAN_PUSHES clean full-size pushes
   * (#2293): one transient 5xx used to pin it low until restart.
   */
  private pushBatchCeiling: number | null = null
  private cleanPushesAtCeiling = 0
  suppressPushDuringPull = false
  /** The generation of the push that owns the queue, 0 when none does. */
  private inFlightGeneration = 0
  private lastPushGeneration = 0
  private readonly settledWaiters = new Set<() => void>()

  /**
   * True from lock acquisition until the push released it, which spans every
   * dequeue and its payload-conditional ack. A conflict requeue carries the
   * placeholder payload '{}', so one coalesced into a row this push dequeued is
   * invisible to that ack and deleted with it; the socket fast path, which
   * takes no sync lock, waits while this is set (#2300, protocol 06 §6.6.2).
   * Only the owning push clears it, so a zombie push that the stale-lock
   * watchdog abandoned cannot clear the gate of the push after it.
   */
  get pushInFlight(): boolean {
    return this.inFlightGeneration !== 0
  }

  /** Resolves true once no push is in flight, false after `timeoutMs`. Leaves no waiter behind. */
  whenPushSettled(timeoutMs: number): Promise<boolean> {
    if (!this.pushInFlight) return Promise.resolve(true)
    return new Promise((resolve) => {
      const settle = (): void => {
        clearTimeout(timer)
        this.settledWaiters.delete(settle)
        resolve(true)
      }
      const timer = setTimeout(() => {
        this.settledWaiters.delete(settle)
        resolve(false)
      }, timeoutMs)
      this.settledWaiters.add(settle)
    })
  }

  /**
   * The stale-lock watchdog abandoned the push: it can no longer be waited
   * for, so it stops holding the gate. Its late ack can still delete a
   * requeue coalesced into a row it dequeued, the watchdog's accepted overlap
   * (protocol 06 §6.6.2).
   */
  resetPushInFlight(): void {
    this.inFlightGeneration = 0
    this.settlePushWaiters()
  }

  private settlePushWaiters(): void {
    for (const settle of [...this.settledWaiters]) settle()
  }

  constructor(ctx: SyncContext, stateManager: SyncStateManager) {
    this.ctx = ctx
    this.stateManager = stateManager
  }

  async push(): Promise<void> {
    const pendingCount = this.ctx.deps.queue.getPendingCount()
    log.debug('Push entered', {
      queuePending: pendingCount,
      queueTotal: this.ctx.deps.queue.getSize(),
      syncing: this.ctx.syncing,
      fullSyncActive: this.ctx.fullSyncActive
    })

    if (pendingCount === 0) {
      log.debug('Push skipped: queue empty')
      return
    }

    const release = await this.ctx.acquireLock()
    if (!release) {
      log.debug('Push skipped', { syncing: this.ctx.syncing, paused: this.stateManager.isPaused() })
      return
    }

    let released = false
    const generation = ++this.lastPushGeneration
    this.inFlightGeneration = generation
    const cleanup = (): void => {
      if (released) return
      released = true
      if (this.inFlightGeneration === generation) {
        this.inFlightGeneration = 0
        this.settlePushWaiters()
      }
      this.ctx.releaseLock()
      release()
    }

    const timer = new SyncTimer()
    const pushLag = new PushLagTrace()
    const startTime = Date.now()
    let pushedCount = 0
    let quotaEventSent = false
    let signatureEventSent = false
    let lastServerTime = 0
    let vaultKey: Uint8Array | null = null
    let signingKeyBytes: Uint8Array | null = null

    try {
      this.stateManager.setState('syncing')
      this.ctx.abortController = new AbortController()
      const abortSignal = this.ctx.abortController.signal

      let token = await this.ctx.deps.getAccessToken()
      if (!token) {
        log.debug('Push aborted: no access token')
        return
      }

      const signingKeys = await this.ctx.deps.getSigningKeys()
      if (!signingKeys) {
        log.debug('Push aborted: no signing keys')
        return
      }
      signingKeyBytes = signingKeys.secretKey

      vaultKey = await this.ctx.deps.getVaultKey()
      if (!vaultKey) {
        log.debug('Push aborted: no vault key')
        return
      }

      // Rows the server rejected during THIS call. They keep their remaining
      // retry budget but must not be dequeued again before the next sync cycle:
      // this loop has no backoff, so re-pushing a rejected row here would spend
      // every attempt on one burst of requests and permanently park the edit.
      // A row that `markSuccess` declined to delete (it changed while in flight)
      // is intentionally absent — that re-push consumes no attempt and is how
      // the newer payload reaches the server.
      const rejectedThisCycle = new Set<string>()

      try {
        let batchSize = Math.min(
          this.ctx.options.pushBatchSize,
          this.pushBatchCeiling ?? this.ctx.options.pushBatchSize
        )

        for (let iteration = 0; iteration < MAX_PUSH_ITERATIONS; iteration++) {
          if (abortSignal.aborted) break
          // One rejected signature condemns every other row in the queue too:
          // they are all signed by the same device key. Dequeuing the next
          // batch would just burn requests on the same verdict.
          if (signatureEventSent) break

          const preDequeueCount = this.ctx.deps.queue.getPendingCount()
          const rawCount = this.ctx.deps.queue.getRawPendingCount()
          if (preDequeueCount !== rawCount) {
            log.error('Push: Drizzle vs raw SQL mismatch!', {
              drizzle: preDequeueCount,
              raw: rawCount
            })
          }
          const items = this.ctx.deps.queue.dequeue(batchSize, rejectedThisCycle)
          if (items.length === 0) {
            log.debug('Push complete: nothing left to push this cycle', {
              preDequeueCount,
              rawCount,
              deferredToNextCycle: rejectedThisCycle.size
            })
            break
          }

          const dedupedItems = this.deduplicateByItemId(items)
          // Payload as it stood at dequeue. A local mutation made while this
          // batch is in flight coalesces into the same row (queue.ts enqueue),
          // so the ack below must only delete rows that still look like this.
          const payloadAtDequeue = new Map(dedupedItems.map((item) => [item.id, item.payload]))

          if (this.ctx.deps.crdtProvider) {
            const snapshotNoteIds = dedupedItems
              .filter((item) => {
                if (item.operation !== 'create') return false
                if (item.type !== 'note' && item.type !== 'journal') return false
                // The body goes before the record, so a create the server then
                // refuses as delete-wins has already republished the body.
                if (isNoteKnownDeleted(this.ctx.deps.db, item.itemId)) return false
                try {
                  const parsed = JSON.parse(item.payload) as { fileType?: string }
                  if (parsed.fileType && isBinaryFileType(parsed.fileType)) return false
                } catch {
                  /* no payload parse = assume text */
                }
                return true
              })
              .map((item) => item.itemId)
            if (snapshotNoteIds.length > 0) {
              // One call, not one per note: the provider batches these onto
              // `POST /sync/crdt/snapshot/batch` and only falls back to a
              // request per note when the server has no such endpoint. A
              // seeded vault used to spend ~750ms per body here.
              //
              // Wrapped because a snapshot failure must never block the record
              // push — that used to fall out of `parallelWithLimit` swallowing
              // rejections at this call site, and moving the fan-out into the
              // provider would otherwise have moved that guarantee with it.
              try {
                const snapshotResults = await this.ctx.deps.crdtProvider.pushSnapshotsForNotes(
                  snapshotNoteIds,
                  { concurrency: CRDT_SNAPSHOT_CONCURRENCY, signal: abortSignal }
                )
                const failedSnapshots = [...snapshotResults.values()].filter((ok) => !ok).length
                if (failedSnapshots > 0) {
                  // Not a push failure: the record still goes to /sync/push
                  // below, and the provider has already restored each failed
                  // note's pending-snapshot debt so the scheduler, close() and
                  // the pending-note replay retry it.
                  log.warn('Push: some CRDT snapshots failed', { count: failedSnapshots })
                }
              } catch (err) {
                log.warn('Push: the CRDT snapshot pass threw', {
                  count: snapshotNoteIds.length,
                  error: err
                })
              }
            }
          }

          timer.startPhase('encrypt')
          const encryptedItems = await encryptPushBatch(
            dedupedItems,
            vaultKey,
            signingKeys.secretKey,
            signingKeys.deviceId,
            {
              workerBridge: this.ctx.deps.workerBridge,
              queue: this.ctx.deps.queue,
              extractPayloadMetadata: (p) => this.extractPayloadMetadata(p),
              resolvePushPayload: (item, deviceId, key) =>
                this.resolvePushPayload(item, deviceId, key),
              onItemTooLarge: (item) => this.reportItemTooLarge(item)
            }
          )
          timer.endPhase(dedupedItems.length)

          const pushItems = this.dropUnsendableItems(encryptedItems, rejectedThisCycle)
          if (pushItems.length === 0) {
            // Everything this batch held was retired above, so there is nothing
            // to send. `continue` instead of `break`: the next dequeue skips
            // the rows just rejected and the rest of the queue still drains.
            continue
          }

          timer.startPhase('network')
          // A batch that can still be split answers a 5xx by splitting, never by
          // resending itself. One that cannot has no smaller shape to try, so
          // only then does the retry ladder back off and resend it (#2293).
          const splittable = pushItems.length > MIN_PUSH_BATCH_SIZE
          let response: RetryResult<PushResponse>
          try {
            response = await withRetry(
              () =>
                withAuthRetry(
                  (authToken) =>
                    postToServer<PushResponse>(
                      '/sync/push',
                      { items: pushItems.map((p) => p.pushItem) },
                      authToken
                    ),
                  token!,
                  engineAuthRetryDeps(this.ctx.deps),
                  (fresh) => {
                    token = fresh
                  }
                ),
              {
                signal: abortSignal,
                isOnline: () => this.ctx.deps.network.online,
                retryOn5xx: !splittable
              }
            )
          } catch (error) {
            timer.endPhase()
            // A batch the server cannot take is refused identically however
            // often it is resent: Cloudflare terminates an oversized
            // /sync/push at the edge (outcome `exceededCpu`, empty 503 body)
            // before any of our code runs, so there is no per-item verdict to
            // act on and nothing gets marked. Halving is the only move that
            // makes progress; without it the whole run ends here and the same
            // rows come back next cycle forever (2026-08-27 → 09-01, one vault
            // stuck at 2914 pending). Halved from the size SENT, so the next
            // request is strictly smaller than the refused one.
            if (error instanceof SyncServerError && error.statusCode >= 500 && splittable) {
              batchSize = Math.max(MIN_PUSH_BATCH_SIZE, Math.floor(pushItems.length / 2))
              this.pushBatchCeiling = batchSize
              this.cleanPushesAtCeiling = 0
              log.warn('Push: server refused the batch, halving it', {
                statusCode: error.statusCode,
                batchSize
              })
              continue
            }
            throw error
          }
          timer.endPhase()

          log.info('Push: server response', {
            iteration,
            accepted: response.value.accepted.length,
            rejected: response.value.rejected.length,
            serverTime: response.value.serverTime
          })

          lastServerTime = response.value.serverTime
          pushLag.record(dedupedItems, response.value, this.ctx.deps.queue)
          if (pushItems.length >= batchSize) batchSize = this.raiseCeilingAfterCleanPush(batchSize)
          const acceptedSet = new Set(response.value.accepted)
          for (let pi = 0; pi < pushItems.length; pi++) {
            if (this.ctx.abortController?.signal.aborted) break
            if (pi > 0 && pi % YIELD_EVERY_N_ITEMS === 0) await yieldToEventLoop()
            const { queueId, pushItem } = pushItems[pi]
            if (acceptedSet.has(pushItem.id)) {
              this.ctx.deps.queue.markSuccess(queueId, payloadAtDequeue.get(queueId))
              this.markItemSynced(pushItem.id, pushItem.type)
              pushedCount++
              this.stateManager.emitItemSynced(pushItem.id, pushItem.type, 'push')
            } else {
              const rejection = response.value.rejected.find((r) => r.id === pushItem.id)
              const reason = rejection?.reason ?? 'Unknown rejection'
              if (reason === 'SYNC_REPLAY_DETECTED') {
                log.info('Push: replay detected, server already has this or newer', {
                  queueId: queueId.slice(0, 8),
                  itemId: pushItem.id.slice(0, 8)
                })
                this.ctx.deps.queue.markSuccess(queueId, payloadAtDequeue.get(queueId))
                this.markItemSynced(pushItem.id, pushItem.type)
              } else if (reason === 'SYNC_DELETE_WINS') {
                // The server holds a tombstone that outranks this upsert and
                // wrote nothing, so a retry is refused identically every time.
                // Deliberately no local delete and no markItemSynced: this
                // device's pull cursor is still behind the tombstone, so the
                // next pull applies the delete through the handler that owns
                // the type's delete semantics.
                log.info('Push: item refused, a delete already won for this id', {
                  queueId: queueId.slice(0, 8),
                  itemId: pushItem.id.slice(0, 8),
                  type: pushItem.type
                })
                this.ctx.deps.queue.markSuccess(queueId, payloadAtDequeue.get(queueId))
              } else if (reason === 'SYNC_INVALID_SIGNATURE') {
                // Every item this device signs is rejected the same way: its
                // keychain signing key is not the key its device id is
                // registered under, and no payload change can fix that. Left
                // on the generic path this burned one retry attempt per row
                // and dead-lettered the whole vault silently — 497 rejections
                // in 20 minutes, then edits that never sync again (#2218).
                // No markFailed here on purpose: the queue keeps its full
                // budget so the rows push normally once the device is
                // re-registered.
                log.error("Push: server rejected this device's signature", {
                  itemId: pushItem.id.slice(0, 8),
                  signerDeviceId: pushItem.signerDeviceId
                })
                // Reached at most once per run: the break below ends the item
                // loop and the flag ends the outer one, so no repeat guard.
                signatureEventSent = true
                trackMainEvent('sync_error', {
                  surface: 'sync',
                  action: 'push_device_key_mismatch',
                  result: 'failed',
                  errorCode: 'device_key_mismatch',
                  source: 'push',
                  dimensions: { transport: 'record' }
                })
                this.ctx.lastErrorInfo = {
                  category: 'device_key_mismatch',
                  message: 'errors:sync.deviceKeyMismatch',
                  retryable: false
                }
                this.ctx.lastError = 'errors:sync.deviceKeyMismatch'
                this.stateManager.setState('error')
                void this.ctx.deps.onDeviceKeyMismatch?.()
                break
              } else if (reason === 'STORAGE_QUOTA_EXCEEDED') {
                log.warn('Push: storage quota exceeded', { itemId: pushItem.id.slice(0, 8) })
                // Only this item is refused (#2293): the rest of the response is
                // still acked below, and the run keeps dequeuing because the
                // server refuses only items that grow storage. A delete or a
                // shrinking update commits, and blocking it would block the way
                // out of the quota. Never a throw, so engine.push() records a
                // success and sync_error must be emitted here, once per run.
                if (!quotaEventSent) {
                  quotaEventSent = true
                  trackMainEvent('sync_error', {
                    surface: 'sync',
                    action: 'push_quota_exceeded',
                    result: 'failed',
                    errorCode: 'storage_quota_exceeded',
                    source: 'push',
                    dimensions: { transport: 'record' }
                  })
                }
                this.ctx.deps.queue.markFailed(queueId, reason)
                rejectedThisCycle.add(queueId)
                this.ctx.lastErrorInfo = {
                  category: 'storage_quota_exceeded',
                  message: 'errors:sync.storageQuotaExceeded',
                  retryable: false
                }
                this.ctx.lastError = 'errors:sync.storageQuotaExceeded'
                this.stateManager.setState('error')
              } else {
                log.warn('Push: item rejected', {
                  queueId: queueId.slice(0, 8),
                  itemId: pushItem.id.slice(0, 8),
                  reason
                })
                this.ctx.deps.queue.markFailed(queueId, reason)
                rejectedThisCycle.add(queueId)
              }
            }
          }
        }

        log.info('Push timing', timer.finish())

        if (pushedCount > 0) {
          this.stateManager.recordHistory('push', pushedCount, Date.now() - startTime)
          this.stateManager.updateLastSyncAt()
          this.ctx.rateLimitConsecutive = 0
          if (lastServerTime > 0) this.stateManager.checkClockSkew(lastServerTime)
          // The push response's maxCursor never moves LAST_CURSOR (#2283,
          // protocol 05 §5.5): peer rows below it may still be unpulled, and
          // every read is `server_cursor > ?`, so they would be skipped for good.

          if (this.ctx.deps.queue.getPendingCount() === 0) {
            this.ctx.deps.emitToRenderer(EVENT_CHANNELS.QUEUE_CLEARED, {
              itemCount: pushedCount,
              duration: Date.now() - startTime
            } satisfies QueueClearedEvent)
          }
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          log.debug('Push aborted (likely network change)')
          return
        }
        const errorInfo = classifyError(error)
        this.ctx.lastErrorInfo = errorInfo
        this.ctx.lastError = errorInfo.message
        if (
          errorInfo.category === 'device_revoked' ||
          errorInfo.category === 'auth_expired' ||
          errorInfo.category === 'network_offline' ||
          error instanceof RateLimitError
        ) {
          throw error
        }
        // Swallowed here (the user sees the error banner via state), so
        // engine.push() records sync_run_completed success — the sync_error for
        // this terminal outcome must be emitted from inside this catch.
        trackMainEvent('sync_error', {
          surface: 'sync',
          action: 'push_failed',
          result: 'failed',
          ...syncErrorTelemetry(errorInfo),
          metrics: { durationMs: Date.now() - startTime },
          source: 'push',
          dimensions: { transport: 'record' }
        })
        this.stateManager.setState('error')
        this.stateManager.recordHistory('error', 0, Date.now() - startTime, errorInfo.message)
      }
    } finally {
      try {
        if (vaultKey && signingKeyBytes) {
          secureCleanup(vaultKey, signingKeyBytes)
        } else if (vaultKey) {
          secureCleanup(vaultKey)
        } else if (signingKeyBytes) {
          secureCleanup(signingKeyBytes)
        }
      } finally {
        cleanup()
      }
    }
  }

  /**
   * Leading edge with a trailing guard (#2289): a request more than
   * PUSH_DEBOUNCE_MS after the last push started goes out now, anything closer
   * arms one timer for the rest of the window. So at most one push per window.
   *
   * A request that finds a cycle running is held in `pendingPushRequested` and
   * runs once when that cycle ends, never through a new timer: re-arming used to
   * re-debounce every window until a long cycle finished.
   */
  requestPush(): void {
    if (this.stopped || this.stateManager.isPaused() || this.suppressPushDuringPull) return
    this.pendingPushRequested = true
    if (!this.ctx.deps.network.online) return
    if (this.pushDebounceTimer) return

    const sinceLastPush = Date.now() - this.lastPushStartedAt
    if (sinceLastPush > PUSH_DEBOUNCE_MS) {
      this.firePendingPush()
      return
    }
    this.pushDebounceTimer = setTimeout(() => {
      this.pushDebounceTimer = null
      this.firePendingPush()
    }, PUSH_DEBOUNCE_MS - sinceLastPush)
  }

  /**
   * The engine's signal that a cycle ended: the sync lock was released or a
   * fullSync returned. Needed because a cycle started directly (start()'s first
   * fullSync, a manual sync, stop()'s final push) has no `ctx.inFlightSync` to
   * wait on. Idempotent: with nothing pending it does nothing.
   *
   * Deferred a microtask so the push never starts inside `releaseLock()` itself.
   */
  onSyncCycleEnded(): void {
    if (!this.pendingPushRequested || this.pushDebounceTimer) return
    queueMicrotask(() => {
      if (!this.pushDebounceTimer) this.firePendingPush()
    })
  }

  private firePendingPush(): void {
    if (this.stopped || !this.pendingPushRequested) return
    if (this.stateManager.isPaused()) {
      this.pendingPushRequested = false
      return
    }
    if (!this.ctx.deps.network.online) return
    if (this.ctx.syncing || this.ctx.fullSyncActive) {
      this.runAfterInFlightCycle()
      return
    }
    this.pendingPushRequested = false
    this.lastPushStartedAt = Date.now()
    this.ctx.scheduleSync(() => (this.ctx.doPush ?? (() => this.push()))())
  }

  private runAfterInFlightCycle(): void {
    const inFlight = this.ctx.inFlightSync
    // No promise: a directly started cycle, which ends in onSyncCycleEnded().
    if (!inFlight || inFlight === this.awaitedCycle) return
    this.awaitedCycle = inFlight
    const onSettled = (): void => {
      if (this.awaitedCycle === inFlight) this.awaitedCycle = null
      this.firePendingPush()
    }
    void inFlight.then(onSettled, onSettled)
  }

  /** Engine teardown: nothing requested before or during stop() may push after it. */
  stop(): void {
    this.stopped = true
    if (this.pushDebounceTimer) {
      clearTimeout(this.pushDebounceTimer)
      this.pushDebounceTimer = null
    }
    this.pendingPushRequested = false
  }

  clearPendingAfterFullSync(): void {
    this.pendingPushRequested = false
    if (this.pushDebounceTimer) {
      clearTimeout(this.pushDebounceTimer)
      this.pushDebounceTimer = null
    }
  }

  /** Returns the batch size for the next request after a clean full-size push. */
  private raiseCeilingAfterCleanPush(batchSize: number): number {
    if (this.pushBatchCeiling === null) return batchSize
    this.cleanPushesAtCeiling++
    if (this.cleanPushesAtCeiling < PUSH_CEILING_RAISE_AFTER_CLEAN_PUSHES) return batchSize
    this.cleanPushesAtCeiling = 0
    const configured = this.ctx.options.pushBatchSize
    const raised = Math.min(configured, batchSize * 2)
    this.pushBatchCeiling = raised >= configured ? null : raised
    log.info('Push: batches land cleanly again, raising the batch size', { batchSize: raised })
    return raised
  }

  private markItemSynced(itemId: string, type: SyncItemType): void {
    try {
      const adapter = this.ctx.deps.adapters?.getRemote(type) ?? getRemoteSyncAdapter(type)
      if (adapter?.markPushSynced) {
        adapter.markPushSynced(this.ctx.deps.db, itemId)
        return
      }

      getHandler(type)?.markPushSynced?.(this.ctx.deps.db, itemId)
    } catch (err) {
      log.warn('Failed to mark item syncedAt after push', { itemId, type, error: err })
    }
  }

  /**
   * Collapse rows that `enqueue` could not coalesce — it only folds into an
   * `attempts = 0` row, so a failed push leaves the next edit to open a second
   * row for the same `(type, itemId)`.
   *
   * The retained row must be the NEWEST one. `dequeue` orders
   * `desc(priority), asc(createdAt)`, so at equal priority the batch arrives
   * oldest-first; keeping the first row seen would keep the stale payload.
   * That only looked harmless because `resolvePushPayload` rebuilds from the
   * DB via the OPTIONAL `handler.buildPushPayload` — for a type without it
   * (`settings`) the frozen payload is all the push has, so the older row
   * pushed the older state and the newer edit was deleted unpushed (#953).
   * Keeping the newest row also keeps the row that live mutations coalesce
   * into (`attempts = 0`), so the payload-conditional ack still guards it.
   */
  private deduplicateByItemId(
    items: Array<typeof import('@memry/db-schema/schema/sync-queue').syncQueue.$inferSelect>
  ): typeof items {
    const seen = new Map<string, (typeof items)[0]>()
    const superseded: Array<{ id: string; payload: string }> = []

    for (const item of items) {
      const key = `${item.type}:${item.itemId}`
      const older = seen.get(key)
      if (!older) {
        seen.set(key, item)
        continue
      }
      // Fold the operation with the same precedence `enqueue` uses, or a
      // create that was never acked would be downgraded to the newer row's
      // update and pushed for an id the server has never seen.
      seen.set(key, {
        ...item,
        operation: coalesceSyncOperations(older.operation, item.operation)
      })
      superseded.push({ id: older.id, payload: older.payload })
    }

    if (superseded.length > 0) {
      log.info('Push: dropped superseded queue rows', { removed: superseded.length })
      for (const row of superseded) {
        this.ctx.deps.queue.markSuccess(row.id, row.payload)
      }
    }

    return Array.from(seen.values())
  }

  /**
   * The client encrypt cap rejects a note before any HTTP request, so the
   * server's 413 path — the one that raises the note-too-large toast — is never
   * reached. Without this the rejection lived only on the sync-queue row and
   * the note simply stopped syncing (#1465). Deliberately does not move the
   * engine's own state or pause the queue: one oversized note must not stall
   * every other note, which is how the server-413 path already behaves.
   */
  private reportItemTooLarge(item: { itemId: string; type: string; payload: string }): void {
    if (item.type !== 'note' && item.type !== 'journal') {
      log.warn('Push: item over the sync size cap', { itemId: item.itemId, type: item.type })
      return
    }

    const title = this.extractPayloadTitle(item.payload)
    log.error('Push: note over the sync size cap, it will not sync', {
      itemId: item.itemId,
      type: item.type,
      title
    })
    trackMainEvent('sync_error', {
      surface: 'sync',
      action: 'push_note_too_large',
      result: 'failed',
      errorCode: 'note_too_large',
      source: 'push',
      dimensions: { transport: 'record' }
    })
    const event: SyncStatusChangedEvent = {
      status: 'error',
      pendingCount: this.ctx.deps.queue.getPendingCount(),
      error: 'A note is too large to sync',
      errorCategory: 'note_too_large',
      ...(title ? { errorNoteTitle: title } : {})
    }
    this.ctx.deps.emitToRenderer(EVENT_CHANNELS.STATUS_CHANGED, event)
  }

  private extractPayloadTitle(payload: string): string | undefined {
    try {
      const parsed = JSON.parse(payload) as { title?: unknown }
      return typeof parsed.title === 'string' && parsed.title ? parsed.title : undefined
    } catch {
      return undefined
    }
  }

  private extractPayloadMetadata(payload: string): {
    clock?: Record<string, number>
    stateVector?: string
  } {
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>
      const clockValue = parsed.clock
      const stateVectorValue = parsed.stateVector
      return {
        clock:
          clockValue && typeof clockValue === 'object' && !Array.isArray(clockValue)
            ? (clockValue as Record<string, number>)
            : undefined,
        stateVector: typeof stateVectorValue === 'string' ? stateVectorValue : undefined
      }
    } catch (err) {
      log.warn('Failed to parse payload metadata', { error: err })
      return {}
    }
  }

  private resolvePushPayload(
    item: { itemId: string; type: string; operation: string; payload: string },
    deviceId: string,
    vaultKey: Uint8Array
  ): string {
    if (item.operation === 'delete') return this.ensureRequiredClock(item, item.payload, deviceId)

    try {
      const adapter =
        this.ctx.deps.adapters?.getRemote(item.type as SyncItemType) ??
        getRemoteSyncAdapter(item.type as SyncItemType)
      const fresh =
        adapter?.buildPushPayload?.(
          this.ctx.deps.db,
          item.itemId,
          deviceId,
          item.operation,
          vaultKey
        ) ??
        getHandler(item.type as SyncItemType)?.buildPushPayload?.(
          this.ctx.deps.db,
          item.itemId,
          deviceId,
          item.operation,
          vaultKey
        )
      if (!fresh) {
        log.debug('Push: item no longer exists locally, using frozen payload', {
          itemId: item.itemId.slice(0, 8),
          type: item.type
        })
        return this.ensureRequiredClock(item, item.payload, deviceId)
      }

      // The freshly built payload is a projection of local columns, so any key
      // this build's schema stripped on apply is missing from it. Put those
      // back before the item leaves the device (#2183).
      return this.ensureRequiredClock(
        item,
        mergeUnknownPayloadFields(this.ctx.deps.db, item.type, item.itemId, fresh),
        deviceId
      )
    } catch (err) {
      log.warn('Push: failed to build fresh payload, using frozen', {
        itemId: item.itemId.slice(0, 8),
        type: item.type,
        error: err
      })
      return this.ensureRequiredClock(item, item.payload, deviceId)
    }
  }

  /**
   * Last-resort clock repair before a payload leaves the device. The handlers'
   * `buildPushPayload` repair (#1215/#1223) only reaches a create/update whose
   * row still exists locally — a delete, an orphaned row, or a handler throw
   * falls back to the FROZEN queue payload, and a frozen payload written by a
   * pre-#1223 build has no clock. The server requires a clock on every item of
   * a clock-required type and one clock-less item fails the whole batch, so a
   * single such row blocks the queue forever (Jerry's 601-pending Fedora
   * install). Stamping only when the clock is absent keeps handler-built clocks
   * untouched; the invented first clock is not persisted (deletes and orphans
   * have no row to persist to), which matches buildDeletePayload's own
   * `{ id, clock: increment({}, deviceId) }` fallback.
   *
   * A payload that is not a JSON OBJECT used to leave here untouched — the
   * repair gave up on exactly the input it exists for, and the clock-less item
   * still went out and 400'd the batch (#2320). A delete is rebuilt from
   * nothing instead, because a tombstone carries no body worth keeping and
   * `{ id, clock }` is already its documented fallback shape. A create/update
   * is NOT: inventing a body for one would push an empty record over the
   * server's copy and blank every field it holds. Those stay untouched here
   * and are retired by `dropUnsendableItems` before the request instead.
   */
  private ensureRequiredClock(
    item: { itemId: string; type: string; operation: string },
    payload: string,
    deviceId: string
  ): string {
    if (!RECORD_CLOCK_REQUIRED_TYPE_SET.has(item.type)) return payload

    let parsed: Record<string, unknown> | null = null
    try {
      const value: unknown = JSON.parse(payload)
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        parsed = value as Record<string, unknown>
      }
    } catch {
      parsed = null
    }

    if (!parsed) {
      if (item.operation !== 'delete') {
        log.error('Push: payload is not a JSON object and cannot be clock-stamped', {
          itemId: item.itemId.slice(0, 8),
          type: item.type,
          operation: item.operation
        })
        return payload
      }
      log.warn('Push: rebuilt an unreadable delete payload around a first clock', {
        itemId: item.itemId.slice(0, 8),
        type: item.type
      })
      return JSON.stringify({ id: item.itemId, clock: { [deviceId]: 1 } })
    }

    const clock = parsed.clock
    if (clock && typeof clock === 'object' && !Array.isArray(clock)) return payload
    log.info('Push: stamped missing clock on outgoing payload', {
      itemId: item.itemId.slice(0, 8),
      type: item.type
    })
    return JSON.stringify({ ...parsed, clock: { [deviceId]: 1 } })
  }

  /**
   * Drop items the server can only refuse, BEFORE the request.
   *
   * `/sync/push` used to answer one schema-invalid item with a request-level
   * 400 that named no item: nothing was marked, the same batch was dequeued
   * next cycle, and a vault stopped syncing entirely (#2320). The server now
   * rejects per item, but a client that keeps producing such an item would
   * still burn a round trip per cycle on a verdict that can never change, and
   * an OLD server answers the whole batch with the old 400. Validating against
   * the same contract the server uses makes the rejection local and final.
   *
   * Verdict only: the original item is what gets sent, never `safeParse`'s
   * output. `RecordPushItemSchema` omits `stateVector`, so sending the parsed
   * value would strip the CRDT state vector off every note on the wire.
   */
  private dropUnsendableItems(
    pushItems: Array<{ queueId: string; pushItem: PushItem }>,
    rejectedThisCycle: Set<string>
  ): Array<{ queueId: string; pushItem: PushItem }> {
    const sendable: Array<{ queueId: string; pushItem: PushItem }> = []
    let dropped = 0

    for (const entry of pushItems) {
      const verdict = RecordPushItemSchema.safeParse(entry.pushItem)
      if (verdict.success) {
        sendable.push(entry)
        continue
      }

      const reason = verdict.error.issues[0]?.message ?? 'validation failed'
      log.error('Push: item cannot satisfy the sync contract, dropping it', {
        queueId: entry.queueId.slice(0, 8),
        itemId: entry.pushItem.id.slice(0, 8),
        type: entry.pushItem.type,
        reason
      })
      this.ctx.deps.queue.markFailed(entry.queueId, `Invalid push item: ${reason}`)
      rejectedThisCycle.add(entry.queueId)
      dropped++
    }

    if (dropped > 0) {
      trackMainEvent('sync_error', {
        surface: 'sync',
        action: 'push_item_invalid',
        result: 'failed',
        errorCode: 'push_item_invalid',
        source: 'push',
        metrics: { itemCount: dropped },
        dimensions: { transport: 'record' }
      })
    }

    return sendable
  }
}
