import { createLogger } from '../../lib/logger'
import { EVENT_CHANNELS } from '@memry/contracts/ipc-events'
import type {
  ConflictDetectedEvent,
  InitialSyncProgressEvent,
  ItemRecoveredEvent,
  ItemCorruptEvent
} from '@memry/contracts/ipc-events'
import type {
  RecordChangesResponse,
  RecordPullItemResponse,
  SyncItemType
} from '@memry/contracts/sync-api'
import { RecordPullResponseSchema } from '@memry/contracts/sync-api'
import { secureCleanup } from '../../crypto/index'
import { decryptPullBatch } from '../sync-crypto-batch'
import { getRemoteSyncAdapter } from '../item-handlers'
import { MissingSyncParentError } from '@memry/sync-client/item-handlers/types'
import { withRetry } from '@memry/sync-client/retry'
import { engineAuthRetryDeps, withAuthRetry } from '../auth-retry'
import { postToServer, getFromServer, RateLimitError } from '../http-client'
import { classifyError } from '../sync-errors'
import { syncErrorTelemetry } from '../sync-error-telemetry'
import { isBinaryFileType } from '@memry/shared/file-types'
import { SyncTimer } from '@memry/sync-client/sync-timer'
import { recordBootstrapBytes } from '../bootstrap-metrics'
import { trackMainEvent } from '../../telemetry/track'
import { trackMainLog } from '../../telemetry/diagnostics'
import type { SyncContext } from './sync-context'
import type { SyncStateManager } from './sync-state-manager'
import type { QuarantineManager } from './quarantine-manager'
import type { CrdtSyncCoordinator } from './crdt-sync-coordinator'
import type { PushCoordinator } from './push-coordinator'
import { CorruptItemTracker } from './corrupt-item-tracker'
import { repairOrphans, type OrphanRef } from './orphan-repair'
import {
  SYNC_STATE_KEYS,
  PULL_REQUEST_MAX_IDS,
  YIELD_EVERY_N_ITEMS,
  yieldToEventLoop,
  itemRefKey
} from './sync-context'

const log = createLogger('PullCoordinator')

type DecryptedPullItem = Awaited<ReturnType<typeof decryptPullBatch>>['decrypted'][number]

/**
 * FK parents must apply before their children (e.g. a task references its
 * project), but server cursor order is last-update order, not dependency
 * order. Lower rank applies first; unlisted types use the default middle rank.
 */
const PULL_APPLY_ORDER: Record<string, number> = {
  project: 0,
  folder_config: 0,
  tag_definition: 0,
  filter: 0,
  settings: 0,
  calendar_source: 0,
  agent_conversation: 0,
  task: 2,
  agent_message: 2,
  calendar_event: 2,
  calendar_external_event: 2,
  calendar_binding: 3
}

const applyRank = (type: string): number => PULL_APPLY_ORDER[type] ?? 1

export const sortByApplyOrder = <T extends { type: string }>(items: T[]): T[] =>
  [...items].sort((a, b) => applyRank(a.type) - applyRank(b.type))

// Why a page stopped the pull run:
// - 'transition': key material is mid-swap (sign-in/recovery) — momentary, do
//   not advance the cursor, the flow re-pulls cleanly once the key settles.
// - 'mismatch': the local key does not match the account — do not advance,
//   recovery must run first.
// - 'breaker': the key is right but the page's payloads are undecryptable
//   (server-side poisoned data) — advance past the page, mark items corrupt.
type PageStopReason = 'none' | 'transition' | 'mismatch' | 'breaker'

interface PullRunState {
  timer: SyncTimer
  startTime: number
  pulledCount: number
  totalConflictsResolved: number
  processedIds: Set<string>
  crdtNoteIds: string[]
  accessJwt: string
  vaultKey: Uint8Array
  /** Set when the run stopped on a page it could not apply — no success finalize. */
  refused?: boolean
}

export class PullCoordinator {
  private ctx: SyncContext
  private stateManager: SyncStateManager
  private quarantine: QuarantineManager
  private crdtSync: CrdtSyncCoordinator
  private pushCoordinator: PushCoordinator
  private corruptTracker: CorruptItemTracker
  private deviceKeyCache = new Map<string, Uint8Array | null>()
  /** Items whose apply threw (e.g. FK parent not pulled yet) — retried once after all pages land */
  private pendingApplyRetries: DecryptedPullItem[] = []
  /** Items still missing an FK parent after the deferred retry — repaired at end of run (#837) */
  private orphanedItems: OrphanRef[] = []

  constructor(
    ctx: SyncContext,
    stateManager: SyncStateManager,
    quarantine: QuarantineManager,
    crdtSync: CrdtSyncCoordinator,
    pushCoordinator: PushCoordinator
  ) {
    this.ctx = ctx
    this.stateManager = stateManager
    this.quarantine = quarantine
    this.crdtSync = crdtSync
    this.pushCoordinator = pushCoordinator
    this.corruptTracker = new CorruptItemTracker(ctx, quarantine, (id) => this.resolveDeviceKey(id))
  }

  async pull(): Promise<void> {
    const release = await this.ctx.acquireLock()
    if (!release) return

    const cleanup = this.createPullCleanup(release)
    let vaultKey: Uint8Array | null = null
    this.deviceKeyCache.clear()

    try {
      const pullStartedAt = Date.now()
      this.stateManager.setState('syncing')
      this.ctx.abortController = new AbortController()

      const credentials = await this.getPullCredentials()
      if (!credentials) return
      vaultKey = credentials.vaultKey

      const runState = this.createPullRunState(
        credentials.accessJwt,
        credentials.vaultKey,
        pullStartedAt
      )
      this.pendingApplyRetries = []
      this.orphanedItems = []
      try {
        await this.pullChanges(runState)
        await this.applyDeferredRetries(runState)
        await this.repairOrphanedItems(runState)
        if (runState.refused) {
          // The run stopped on a page it could not apply. Recording a success
          // history row and a fresh lastSyncAt here is what made a failing
          // Retry look like a clean sync in the 2026-07-18 incident.
          log.warn('Pull finished on a refused page — not recording a successful sync', {
            pulledCount: runState.pulledCount
          })
        } else {
          this.finalizePullSuccess(runState)
        }
      } catch (error) {
        this.handlePullError(error, runState.startTime)
      }
    } finally {
      this.cleanupAfterPull(vaultKey, cleanup)
    }
  }

  periodicPull(): void {
    if (
      this.ctx.syncing ||
      this.ctx.fullSyncActive ||
      this.stateManager.isPaused() ||
      !this.ctx.deps.network.online
    ) {
      log.debug('Periodic pull skipped', {
        syncing: this.ctx.syncing,
        fullSyncActive: this.ctx.fullSyncActive,
        paused: this.stateManager.isPaused(),
        online: this.ctx.deps.network.online
      })
      return
    }
    this.ctx.scheduleSync(() => this.pull())
  }

  async resolveDeviceKey(deviceId: string): Promise<Uint8Array | null> {
    if (this.deviceKeyCache.has(deviceId)) {
      return this.deviceKeyCache.get(deviceId)!
    }
    const key = await this.ctx.deps.getDevicePublicKey(deviceId)
    this.deviceKeyCache.set(deviceId, key)
    return key
  }

  clearCaches(): void {
    this.deviceKeyCache.clear()
    this.corruptTracker.clear()
  }

  private createPullCleanup(release: () => void): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      this.ctx.releaseLock()
      release()
    }
  }

  private async getPullCredentials(): Promise<{ accessJwt: string; vaultKey: Uint8Array } | null> {
    const accessJwt = await this.ctx.deps.getAccessToken()
    if (!accessJwt) return null

    const vaultKey = await this.ctx.deps.getVaultKey()
    if (!vaultKey) return null

    return { accessJwt, vaultKey }
  }

  private createPullRunState(
    accessJwt: string,
    vaultKey: Uint8Array,
    startTime: number
  ): PullRunState {
    return {
      timer: new SyncTimer(),
      startTime,
      pulledCount: 0,
      totalConflictsResolved: 0,
      processedIds: new Set<string>(),
      crdtNoteIds: [],
      accessJwt,
      vaultKey
    }
  }

  // Oldest-first on purpose, even though the progressive open (#1830) would
  // rather show recent notes first: /sync/changes is a strictly ascending
  // `server_cursor > ?` feed, and the cursor persisted after each page below
  // is the crash-resume watermark. Applying newest-first would need either a
  // descending server feed with a two-ended resume contract (that is P2.2 pack
  // ordering) or buffering every page before applying — which kills the
  // page-by-page fill and makes an interrupted first sync silently skip the
  // older pages the advanced cursor now claims were applied.
  private async pullChanges(runState: PullRunState): Promise<void> {
    let cursor = this.stateManager.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)
    let hasMore = true

    type ChangesRetryResult = Awaited<ReturnType<typeof this.fetchChangesPage>>
    let changesResult: ChangesRetryResult
    let prefetchedNext: Promise<ChangesRetryResult> | null = null

    while (hasMore) {
      if (this.ctx.abortController!.signal.aborted) break

      if (prefetchedNext) {
        changesResult = await prefetchedNext
        prefetchedNext = null
      } else {
        changesResult = await this.fetchChangesPage(runState, cursor)
      }

      const changes = changesResult.value
      const stop = await this.pullChangesPage(changes, runState)
      this.emitInitialSyncProgress(changes, runState.pulledCount)

      // Key-state stops ('transition' mid sign-in/recovery, 'mismatch') must
      // NOT advance the persisted cursor: the failures are a key problem that
      // resolves out-of-band, and advancing made the next manual Retry resume
      // past the failing page and report a clean sync while the items were
      // never applied.
      if (stop === 'transition' || stop === 'mismatch') {
        runState.refused = true
        break
      }

      this.stateManager.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, String(changes.nextCursor))
      cursor = String(changes.nextCursor)
      hasMore = changes.hasMore

      // Circuit breaker (key matches the account but the page's payloads are
      // undecryptable — server-side poisoned data): the cursor DOES advance,
      // because these items can never decrypt no matter how often they are
      // re-pulled, and pinning the cursor here would block every later item
      // from ever reaching this device. The failures were marked corrupt and
      // surfaced; the run still ends in an error state, not a fake success.
      if (stop === 'breaker') {
        runState.refused = true
        break
      }

      if (hasMore && !this.ctx.abortController?.signal.aborted) {
        prefetchedNext = this.fetchChangesPage(runState, cursor)
        prefetchedNext.catch(() => {})
      }
    }
  }

  private async fetchChangesPage(
    runState: PullRunState,
    pageCursor: string | null | undefined
  ): ReturnType<typeof withRetry<RecordChangesResponse>> {
    return withRetry(
      () => {
        const cp = pageCursor ? `&cursor=${pageCursor}` : ''
        return withAuthRetry(
          (authToken) =>
            getFromServer<RecordChangesResponse>(
              `/sync/changes?limit=${this.ctx.options.pullPageLimit}${cp}`,
              authToken
            ),
          runState.accessJwt,
          engineAuthRetryDeps(this.ctx.deps),
          (fresh) => {
            runState.accessJwt = fresh
          }
        )
      },
      {
        signal: this.ctx.abortController!.signal,
        isOnline: () => this.ctx.deps.network.online
      }
    )
  }

  private async pullChangesPage(
    changes: RecordChangesResponse,
    runState: PullRunState
  ): Promise<PageStopReason> {
    const itemIds = Array.from(
      new Set([...changes.items.map((item) => item.id), ...changes.deleted])
    )
    if (itemIds.length === 0) return 'none'

    // A changes page holds up to PULL_PAGE_LIMIT (500) refs, but POST
    // /sync/pull accepts at most PULL_REQUEST_MAX_IDS (100) ids, so the page is
    // pulled in slices — which also keeps decrypt/apply memory at the profile
    // it had when the page size WAS 100. Stop semantics per slice:
    // - 'transition'/'mismatch' return immediately: the caller does not
    //   advance the cursor, so unpulled slices re-arrive next cycle.
    // - 'breaker' must NOT abort the remaining slices: the caller advances the
    //   cursor past the WHOLE page, so a slice skipped here would neither be
    //   re-pulled nor marked corrupt — silent loss. Every slice runs (each
    //   marks its own failures), then the breaker is reported.
    let breakerTripped = false
    for (let i = 0; i < itemIds.length; i += PULL_REQUEST_MAX_IDS) {
      const slice = itemIds.slice(i, i + PULL_REQUEST_MAX_IDS)
      const pageResult = await this.processPage(slice, runState)
      runState.pulledCount += pageResult.applied
      runState.totalConflictsResolved += pageResult.conflicts
      await this.applyCrdtBatch(runState)

      if (pageResult.stop === 'transition' || pageResult.stop === 'mismatch') {
        return pageResult.stop
      }
      if (pageResult.stop === 'breaker') breakerTripped = true
    }

    return breakerTripped ? 'breaker' : 'none'
  }

  private async applyCrdtBatch(runState: PullRunState): Promise<void> {
    if (runState.crdtNoteIds.length === 0 || !this.ctx.deps.crdtProvider) return

    runState.timer.startPhase('crdt-batch')
    await this.crdtSync.applyCrdtBatch(runState.crdtNoteIds, runState.accessJwt, runState.vaultKey)
    runState.timer.endPhase(runState.crdtNoteIds.length)
    runState.crdtNoteIds.length = 0
  }

  private emitInitialSyncProgress(changes: RecordChangesResponse, pulledCount: number): void {
    if (!this.ctx.fullSyncActive) return

    const estimatedTotal = changes.hasMore
      ? pulledCount + this.ctx.options.pullPageLimit
      : pulledCount
    this.ctx.deps.emitToRenderer(EVENT_CHANNELS.INITIAL_SYNC_PROGRESS, {
      phase: 'notes',
      processedItems: pulledCount,
      totalItems: estimatedTotal
    } satisfies InitialSyncProgressEvent)
  }

  private finalizePullSuccess(runState: PullRunState): void {
    log.info('Pull timing', runState.timer.finish())
    this.stateManager.recordHistory('pull', runState.pulledCount, Date.now() - runState.startTime)
    this.stateManager.updateLastSyncAt()
    this.ctx.rateLimitConsecutive = 0

    if (runState.totalConflictsResolved > 0) {
      log.info('Pull: re-enqueued merged items for push-back', {
        conflicts: runState.totalConflictsResolved
      })
      this.ctx.requestPush()
    }

    if (runState.pulledCount > 0) {
      void import('../../vault/property-definitions')
        .then(({ PropertyDefinitionsService }) => {
          const service = PropertyDefinitionsService.get()
          service.reload().catch((err: unknown) => {
            log.warn('Failed to reload property definitions after pull:', err)
          })
        })
        .catch(() => {
          // Service not initialized yet — skip
        })
    }
  }

  private handlePullError(error: unknown, startedAt: number): void {
    if (error instanceof DOMException && error.name === 'AbortError') {
      log.debug('Pull aborted (likely network change)')
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

    // Swallowed here, so engine.pull() records sync_run_completed success —
    // the sync_error for this terminal outcome must be emitted from inside
    // this handler.
    trackMainEvent('sync_error', {
      surface: 'sync',
      action: 'pull_failed',
      result: 'failed',
      ...syncErrorTelemetry(errorInfo),
      metrics: { durationMs: Date.now() - startedAt },
      source: 'pull',
      dimensions: { transport: 'record' }
    })
    this.stateManager.setState('error')
    this.stateManager.recordHistory('error', 0, Date.now() - startedAt, errorInfo.message)
  }

  private cleanupAfterPull(vaultKey: Uint8Array | null, cleanup: () => void): void {
    this.deviceKeyCache.clear()
    // Cooldown entries otherwise only expire when a later pull happens to
    // re-fetch the same item, so a burst of corruption that then stops leaves
    // the tracker holding every entry for the rest of the session. Sweeping
    // here is O(entries) once per pull and drops nothing that is still live.
    this.corruptTracker.clearExpired()
    try {
      if (vaultKey) secureCleanup(vaultKey)
    } finally {
      cleanup()
    }
  }

  /**
   * Re-apply items whose first apply threw. By the time every page has landed,
   * FK parents (projects, conversations, sources) exist locally, so ordering
   * failures from cursor-ordered pages resolve here. Items that fail again are
   * dropped until their next server-side update.
   */
  private async applyDeferredRetries(runState: PullRunState): Promise<void> {
    if (this.pendingApplyRetries.length === 0) return

    const retries = sortByApplyOrder(this.pendingApplyRetries)
    this.pendingApplyRetries = []
    let applied = 0
    let failed = 0

    for (let i = 0; i < retries.length; i++) {
      if (this.ctx.abortController?.signal.aborted) break
      if (i > 0 && i % YIELD_EVERY_N_ITEMS === 0) await yieldToEventLoop()
      const dec = retries[i]
      try {
        const contentBytes = new TextEncoder().encode(dec.content)
        const itemOp = dec.deletedAt ? 'delete' : (dec.operation as 'create' | 'update')
        const result = this.ctx.applier.apply({
          itemId: dec.id,
          type: dec.type as Parameters<typeof this.ctx.applier.apply>[0]['type'],
          operation: itemOp,
          content: contentBytes,
          clock: dec.clock,
          deletedAt: dec.deletedAt,
          vaultKey: runState.vaultKey
        })

        if (result === 'parse_error') {
          failed++
          continue
        }
        if (result === 'conflict') {
          this.handleConflict(dec)
          runState.totalConflictsResolved++
        }

        if (
          (dec.type === 'note' || dec.type === 'journal') &&
          this.ctx.deps.crdtProvider &&
          itemOp !== 'delete'
        ) {
          let isBinary = false
          try {
            const p = JSON.parse(dec.content) as { fileType?: string }
            if (p.fileType && isBinaryFileType(p.fileType)) isBinary = true
          } catch {
            /* safe to skip CRDT on parse failure */
          }
          if (!isBinary) runState.crdtNoteIds.push(dec.id)
        }

        runState.processedIds.add(itemRefKey(dec.type, dec.id))
        runState.pulledCount++
        applied++
        this.stateManager.emitItemSynced(dec.id, dec.type, 'pull', itemOp)
      } catch (retryError) {
        failed++
        if (retryError instanceof MissingSyncParentError) {
          // Not a dead end: the parent may simply sit outside this run's cursor
          // window, or be gone everywhere. repairOrphanedItems() tells them
          // apart instead of dropping the item until some future remote update
          // (which, for a cascade-deleted project, never comes) — #837.
          this.orphanedItems.push({
            item: dec,
            parentType: retryError.parentType,
            parentId: retryError.parentId
          })
          log.warn('Pull: deferred retry still missing FK parent — queued for repair', {
            itemId: dec.id,
            type: dec.type,
            parentType: retryError.parentType,
            parentId: retryError.parentId
          })
          continue
        }
        log.error('Pull: deferred retry failed — item skipped until next remote update', {
          itemId: dec.id,
          type: dec.type,
          error: retryError instanceof Error ? retryError.message : String(retryError)
        })
        // For an item that never gets another server-side update this is
        // permanent absence on this device — count the drop per type.
        trackMainLog('error', {
          scope: 'PullCoordinator',
          action: 'pull_apply_dropped',
          errorCode: dec.type
        })
      }
    }

    log.info('Pull: deferred apply retries processed', { retried: retries.length, applied, failed })
  }

  /** See `repairOrphans` — resolves items left unwritable by a missing FK parent (#837). */
  private async repairOrphanedItems(runState: PullRunState): Promise<void> {
    const orphans = this.orphanedItems
    this.orphanedItems = []
    await repairOrphans({
      orphans,
      ctx: this.ctx,
      corruptTracker: this.corruptTracker,
      accessJwt: runState.accessJwt,
      vaultKey: runState.vaultKey,
      applyItem: (item) => this.applyOrphan(item, runState)
    })
  }

  private applyOrphan(dec: DecryptedPullItem, runState: PullRunState): void {
    const itemOp = dec.deletedAt ? 'delete' : (dec.operation as 'create' | 'update')
    this.ctx.applier.apply({
      itemId: dec.id,
      type: dec.type as Parameters<typeof this.ctx.applier.apply>[0]['type'],
      operation: itemOp,
      content: new TextEncoder().encode(dec.content),
      clock: dec.clock,
      deletedAt: dec.deletedAt,
      vaultKey: runState.vaultKey
    })
    runState.processedIds.add(itemRefKey(dec.type, dec.id))
    runState.pulledCount++
    this.stateManager.emitItemSynced(dec.id, dec.type, 'pull', itemOp)
  }

  private async processPage(
    itemIds: string[],
    runState: PullRunState
  ): Promise<{ applied: number; conflicts: number; stop: PageStopReason }> {
    const { vaultKey, timer, processedIds, crdtNoteIds } = runState
    const pullResult = await withRetry(
      () =>
        withAuthRetry(
          (authToken) =>
            postToServer<{ items: RecordPullItemResponse[] }>('/sync/pull', { itemIds }, authToken),
          runState.accessJwt,
          engineAuthRetryDeps(this.ctx.deps),
          (fresh) => {
            runState.accessJwt = fresh
          }
        ),
      { signal: this.ctx.abortController!.signal, isOnline: () => this.ctx.deps.network.online }
    )

    const parsed = RecordPullResponseSchema.safeParse(pullResult.value)
    if (!parsed.success) {
      log.error('Invalid pull response from server', { error: parsed.error.message })
      log.warn('pull_page_dropped', {
        reason: 'invalid_pull_response',
        droppedCount: itemIds.length
      })
      // The cursor still advances past this page, so these items may never
      // apply — a server-side contract regression must be chartable.
      trackMainEvent('sync_error', {
        surface: 'sync',
        action: 'pull_page_dropped',
        result: 'failed',
        errorCode: 'invalid_pull_response',
        metrics: { itemCount: itemIds.length },
        source: 'pull',
        dimensions: { transport: 'record' }
      })
      return { applied: 0, conflicts: 0, stop: 'none' }
    }

    log.debug('Pull: response parsed', {
      requestedCount: itemIds.length,
      receivedCount: parsed.data.items.length
    })

    // Bootstrap throughput (#1835), UNITS: this channel counts base64
    // CHARACTERS (`String.length` of `encryptedData` + `encryptedKey`), which
    // are ~0.75x the actual octets on the wire. The crdt snapshot site and the
    // attachments channel count real byteLength/octet totals instead — do not
    // compare per-second rates across channels naively. Aggregated in memory;
    // no-op outside a fresh-device bootstrap window.
    recordBootstrapBytes(
      'records',
      parsed.data.items.reduce(
        (sum, item) => sum + item.blob.encryptedData.length + item.blob.encryptedKey.length,
        0
      )
    )

    const signerIds = new Set(parsed.data.items.map((i) => i.signerDeviceId))
    await Promise.all(Array.from(signerIds).map((sid) => this.resolveDeviceKey(sid)))
    log.debug('Pull: device keys prefetched', { signerCount: signerIds.size })

    let pageApplied = 0
    let pageSkipped = 0
    let pageFailed = 0
    let cryptoFailCount = 0
    let pageConflicts = 0

    const itemsToProcess = parsed.data.items.filter((item) => {
      if (processedIds.has(itemRefKey(item.type, item.id))) {
        pageSkipped++
        return false
      }
      if (this.quarantine.isQuarantined(item.id, item.type)) {
        pageSkipped++
        return false
      }
      return true
    })

    timer.startPhase('encrypt')
    const { decrypted, failures } = await decryptPullBatch(itemsToProcess, vaultKey, {
      workerBridge: this.ctx.deps.workerBridge,
      resolveDeviceKey: (id) => this.resolveDeviceKey(id)
    })
    timer.endPhase(itemsToProcess.length)

    // When EVERY item in the page fails to decrypt or verify, per-item
    // corruption is not a plausible explanation — the vault key itself is the
    // suspect (e.g. this device's master key no longer matches the account).
    // Confirm against the account verifier before branding anything: a
    // confirmed mismatch must not quarantine items, mark them corrupt, or
    // toast security warnings — those side effects outlive the key problem and
    // keep scaring the user after recovery. Stop the cycle and escalate once.
    const everyItemFailed =
      itemsToProcess.length > 0 &&
      decrypted.length === 0 &&
      failures.length === itemsToProcess.length
    if (everyItemFailed && this.ctx.deps.checkAccountKey) {
      const keyCheck = await this.ctx.deps.checkAccountKey()
      if (keyCheck === 'mismatch') {
        this.ctx.lastError =
          'All items failed with crypto errors — possible vault key mismatch. ' +
          `${failures.length} item(s) could not be decrypted.`
        this.ctx.lastErrorInfo = {
          category: 'crypto_failure',
          message: this.ctx.lastError,
          retryable: false
        }
        this.stateManager.setState('error')
        log.error(
          'Pull: vault key does not match the account — stopping cycle without recording item failures',
          { failedCount: failures.length }
        )
        // Ends the run as 'refused', never a throw — engine.pull() records a
        // success, so the incident-class event must be emitted here.
        trackMainEvent('sync_error', {
          surface: 'sync',
          action: 'vault_key_mismatch',
          result: 'failed',
          errorCode: 'vault_key_mismatch',
          metrics: { itemCount: failures.length },
          source: 'pull',
          dimensions: { transport: 'record' }
        })
        this.ctx.deps.onVaultKeyMismatch?.()
        return { applied: 0, conflicts: 0, stop: 'mismatch' }
      }
      if (keyCheck === 'transition') {
        // Sign-in / recovery / linking is mid-swap: the failures are expected
        // and momentary. Stop this cycle quietly — the flow restarts sync with
        // the settled key, and the next cycle re-pulls these items cleanly.
        log.info(
          'Pull: key material is being re-established — stopping cycle without recording item failures',
          { failedCount: failures.length }
        )
        return { applied: 0, conflicts: 0, stop: 'transition' }
      }
    }

    for (const failure of failures) {
      if (failure.isSignatureError) {
        this.quarantine.quarantineItem(
          failure.id,
          failure.type,
          failure.signerDeviceId,
          failure.error
        )
        pageFailed++
        continue
      }
      log.error('Pull: failed to process item', {
        itemId: failure.id,
        type: failure.type,
        signerDeviceId: failure.signerDeviceId,
        isCryptoError: failure.isCryptoError,
        error: failure.error
      })
      pageFailed++
      if (failure.isCryptoError) cryptoFailCount++
    }

    const parseErrorIds: Array<{ id: string; type: string }> = []

    timer.startPhase('apply')
    this.pushCoordinator.suppressPushDuringPull = true
    const orderedDecrypted = sortByApplyOrder(decrypted)
    try {
      for (let i = 0; i < orderedDecrypted.length; i++) {
        if (this.ctx.abortController?.signal.aborted) break
        if (i > 0 && i % YIELD_EVERY_N_ITEMS === 0) await yieldToEventLoop()
        const dec = orderedDecrypted[i]
        try {
          const contentBytes = new TextEncoder().encode(dec.content)
          const itemOp = dec.deletedAt ? 'delete' : (dec.operation as 'create' | 'update')
          const result = this.ctx.applier.apply({
            itemId: dec.id,
            type: dec.type as Parameters<typeof this.ctx.applier.apply>[0]['type'],
            operation: itemOp,
            content: contentBytes,
            clock: dec.clock,
            deletedAt: dec.deletedAt,
            vaultKey
          })

          if (result === 'parse_error') {
            parseErrorIds.push({ id: dec.id, type: dec.type })
            pageFailed++
            continue
          }

          if (result === 'conflict') {
            this.handleConflict(dec)
            pageConflicts++
          }

          if (
            (dec.type === 'note' || dec.type === 'journal') &&
            this.ctx.deps.crdtProvider &&
            itemOp !== 'delete'
          ) {
            let isBinary = false
            try {
              const p = JSON.parse(dec.content) as { fileType?: string }
              if (p.fileType && isBinaryFileType(p.fileType)) isBinary = true
            } catch {
              /* safe to skip CRDT on parse failure */
            }
            if (!isBinary) crdtNoteIds.push(dec.id)
          }

          processedIds.add(itemRefKey(dec.type, dec.id))
          pageApplied++
          this.stateManager.emitItemSynced(dec.id, dec.type, 'pull', itemOp)
        } catch (applyError) {
          log.error('Pull: failed to apply decrypted item — deferring for retry', {
            itemId: dec.id,
            type: dec.type,
            error: applyError instanceof Error ? applyError.message : String(applyError),
            ...(applyError instanceof MissingSyncParentError
              ? { parentType: applyError.parentType, parentId: applyError.parentId }
              : {})
          })
          this.pendingApplyRetries.push(dec)
          pageFailed++
        }
      }
    } finally {
      this.pushCoordinator.suppressPushDuringPull = false
    }
    timer.endPhase(decrypted.length)

    const cryptoRefetchRefs = failures
      .filter((f) => f.isCryptoError)
      .map((f) => ({ id: f.id, type: f.type }))
    const parseRefetchRefs = parseErrorIds.map((p) => ({ id: p.id, type: p.type }))
    const allRefetchRefs = [...cryptoRefetchRefs, ...parseRefetchRefs]

    if (allRefetchRefs.length > 0 && pageApplied > 0) {
      this.corruptTracker.clearExpired()
      const { recovered, permanentFailures } = await this.corruptTracker.refetch(
        allRefetchRefs,
        runState.accessJwt,
        vaultKey
      )

      for (const dec of recovered) {
        try {
          const contentBytes = new TextEncoder().encode(dec.content)
          const itemOp = dec.deletedAt ? 'delete' : (dec.operation as 'create' | 'update')
          const result = this.ctx.applier.apply({
            itemId: dec.id,
            type: dec.type as Parameters<typeof this.ctx.applier.apply>[0]['type'],
            operation: itemOp,
            content: contentBytes,
            clock: dec.clock,
            deletedAt: dec.deletedAt,
            vaultKey
          })
          if (result === 'applied' || result === 'conflict') {
            processedIds.add(itemRefKey(dec.type, dec.id))
            pageApplied++
            pageFailed--
            this.stateManager.emitItemSynced(dec.id, dec.type, 'pull', itemOp)
            this.ctx.deps.emitToRenderer(EVENT_CHANNELS.ITEM_RECOVERED, {
              itemId: dec.id,
              type: dec.type
            } satisfies ItemRecoveredEvent)
            log.info('Pull: recovered corrupt item', { itemId: dec.id, type: dec.type })
          }
        } catch (err) {
          log.error('Pull: failed to apply recovered item', {
            itemId: dec.id,
            error: err instanceof Error ? err.message : String(err)
          })
          trackMainLog('error', {
            scope: 'PullCoordinator',
            action: 'pull_apply_dropped',
            errorCode: dec.type
          })
        }
      }

      for (const ref of permanentFailures) {
        this.ctx.deps.emitToRenderer(EVENT_CHANNELS.ITEM_CORRUPT, {
          itemId: ref.id,
          type: ref.type,
          error: 'Item corrupt after re-fetch attempt'
        } satisfies ItemCorruptEvent)
      }

      if (recovered.length > 0 || permanentFailures.length > 0) {
        log.info('Pull: re-fetch summary', {
          recovered: recovered.length,
          permanentFailures: permanentFailures.length
        })
      }
    }

    log.info('Pull page processed', {
      total: parsed.data.items.length,
      applied: pageApplied,
      skipped: pageSkipped,
      failed: pageFailed,
      conflicts: pageConflicts
    })

    let stop: PageStopReason = 'none'
    if (
      pageFailed > 0 &&
      pageFailed === cryptoFailCount &&
      parsed.data.items.length > 0 &&
      pageApplied === 0
    ) {
      this.ctx.lastError =
        'All items failed with crypto errors — possible vault key mismatch. ' +
        `${cryptoFailCount} item(s) could not be decrypted.`
      this.ctx.lastErrorInfo = {
        category: 'crypto_failure',
        message: this.ctx.lastError,
        retryable: false
      }
      this.stateManager.setState('error')
      log.error('Pull: circuit breaker tripped — all items failed crypto', { cryptoFailCount })
      // 2026-07-18 poisoned-payload incident class: previously only a log line
      // and a renderer event with no listener — invisible until a support
      // email. The run ends 'refused' (no throw), so emit from here.
      trackMainEvent('sync_error', {
        surface: 'sync',
        action: 'pull_breaker_tripped',
        result: 'failed',
        errorCode: 'crypto_breaker',
        metrics: { itemCount: cryptoFailCount },
        source: 'pull',
        dimensions: { transport: 'record' }
      })
      // The account key check above said 'match' (or was unavailable), so
      // these payloads are undecryptable with the CORRECT key — server-side
      // poisoned data that no amount of re-pulling can fix. Record each item
      // in the corrupt tracker (cooldown) and surface it, so the caller can
      // advance the cursor past this page without silently losing track of
      // what failed.
      for (const failure of failures) {
        if (!failure.isCryptoError) continue
        this.corruptTracker.markFailed({ id: failure.id, type: failure.type })
        this.ctx.deps.emitToRenderer(EVENT_CHANNELS.ITEM_CORRUPT, {
          itemId: failure.id,
          type: failure.type,
          error: failure.error
        } satisfies ItemCorruptEvent)
      }
      stop = 'breaker'
    }

    return { applied: pageApplied, conflicts: pageConflicts, stop }
  }

  private handleConflict(dec: {
    id: string
    type: string
    content: string
    clock?: Record<string, number>
  }): void {
    let remoteVersion: Record<string, unknown> = {}
    try {
      const parsedRemote = JSON.parse(dec.content) as unknown
      if (parsedRemote && typeof parsedRemote === 'object' && !Array.isArray(parsedRemote)) {
        remoteVersion = parsedRemote as Record<string, unknown>
      }
      if (dec.clock) remoteVersion.clock = dec.clock
    } catch {
      log.warn('Failed to parse remote content for conflict event', { itemId: dec.id })
    }

    const localVersion = this.fetchLocalItem(dec.id, dec.type)

    this.ctx.deps.emitToRenderer(EVENT_CHANNELS.CONFLICT_DETECTED, {
      itemId: dec.id,
      type: dec.type,
      localVersion,
      remoteVersion,
      localClock: (localVersion.clock as Record<string, number>) ?? undefined,
      remoteClock: dec.clock ?? undefined
    } satisfies ConflictDetectedEvent)

    this.ctx.deps.queue.enqueue({
      type: dec.type as SyncItemType,
      itemId: dec.id,
      operation: 'update',
      payload: '{}'
    })

    // Conflict rate per item type is the core health metric for the
    // field-merge strategy; only canvas had a conflict event before.
    trackMainLog('info', {
      scope: 'PullCoordinator',
      action: 'conflict_resolved',
      errorCode: dec.type
    })
  }

  private fetchLocalItem(itemId: string, type: string): Record<string, unknown> {
    try {
      const adapter =
        this.ctx.deps.adapters?.getRemote(type as SyncItemType) ??
        getRemoteSyncAdapter(type as SyncItemType)
      return adapter?.fetchLocal?.(this.ctx.deps.db, itemId) ?? {}
    } catch {
      log.warn('Failed to fetch local item for conflict', { itemId, type })
      return {}
    }
  }
}
