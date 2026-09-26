import type { SyncSocketEvent } from '@memry/contracts/sync-socket'
import { createLogger } from '../../lib/logger'
import { secureCleanup } from '../../crypto/index'
import { trackMainLog } from '../../telemetry/diagnostics'
import { decryptPullBatch } from '../sync-crypto-batch'
import {
  beginPageApply,
  isPageApplyQuiescent,
  whenPageApplyQuiescent,
  type PageApplyHandle
} from '../bulk-apply'
import type { ItemApplier } from '../apply-item'
import type { DrizzleDb } from '@memry/sync-client/item-handlers/types'
import type { SyncWorkerBridge } from '../worker-bridge'
import { sortByApplyOrder } from './apply-order'
import { applyDecryptedItem, type DecryptedItemOperation } from './apply-decrypted'
import { carriesCrdtBody } from './pull-envelope'
import { traceSocketApplied } from './sync-latency-telemetry'

const log = createLogger('SocketApply')

type DecryptedPullItem = Awaited<ReturnType<typeof decryptPullBatch>>['decrypted'][number]
type ChangesAvailable = Extract<SyncSocketEvent, { kind: 'changes_available' }>

/**
 * How long a frame may wait for a pull page's transaction and file flush, and
 * for a local push, to finish. Past it the items are dropped: the wake pull is
 * already running and delivers them anyway.
 */
export const SOCKET_APPLY_QUIESCENCE_TIMEOUT_MS = 5_000

/**
 * Items one frame applies. The apply is one synchronous run on the main thread,
 * so it is bounded; the rest reach the device through the wake pull.
 */
export const SOCKET_APPLY_MAX_ITEMS = 50

/**
 * Everything the socket fast path (#2300, protocol 09 §9.13) may touch. There
 * is no state writer: the cursor is readable for the skip filter and nothing
 * here can write it, quarantine an item, record a schema-invalid entry or mark
 * one corrupt. The wake pull that runs after every frame owns all of that.
 */
export interface SocketApplyDeps {
  /** The data DB a frame's page session runs on, as the pull's pages do. */
  db: DrizzleDb
  /** The pull's applier: pending-delete guard, handlers, vector clock rules. */
  applier: Pick<ItemApplier, 'apply'>
  /**
   * Read only: the highest cursor whose rows the pull has applied or owns, so
   * max(LAST_CURSOR, the running pull's owned-through mark). A frame at or
   * below it may carry versions older than rows already applied.
   */
  appliedCursor(): number
  /** False while paused, offline, cancelled, stopped or in a full sync. */
  eligible(): boolean
  /**
   * True while a push owns the queue: a conflict requeue coalesced into a row
   * that push already dequeued is deleted by its ack (protocol 06 §6.6.2). A
   * frame waits for it like for a page apply, then re-checks synchronously.
   */
  pushInFlight(): boolean
  /** Resolves true once no push is in flight, false after `timeoutMs`. */
  whenPushSettled(timeoutMs: number): Promise<boolean>
  isQuarantined(id: string, type: string): boolean
  getVaultKey(): Promise<Uint8Array | null>
  getDevicePublicKey(deviceId: string): Promise<Uint8Array | null>
  workerBridge?: SyncWorkerBridge
  /** Same switch the pull flips around its apply loop. */
  setPushSuppressed(suppressed: boolean): void
  isPushSuppressed(): boolean
  /** Renderer event for a row the apply changed ('applied' or 'conflict'). */
  onApplied(item: DecryptedPullItem, operation: DecryptedItemOperation): void
  /**
   * Conflict event and push-back requeue, exactly as the pull reports it. The
   * requeue runs in the item's savepoint; renderer events go through `page`.
   */
  onConflict(item: DecryptedPullItem, page: Pick<PageApplyHandle, 'afterCommit'>): void
  /** Sends the merged rows back, as the pull does after conflicts. */
  requestPush(): void
  /**
   * The pull's body debt for a note or journal record the frame changed
   * (#2297): the durable `record` row and the unmerged flag that withholds a
   * snapshot claim (#2299). It commits with the item. The frame lands no body;
   * the wake pull's re-delivery batches it.
   */
  oweRecordBody(noteId: string): void
}

export type SocketApplyOutcome =
  | {
      kind: 'skipped'
      reason: 'no_items' | 'ineligible' | 'covered' | 'no_key' | 'nothing_valid' | 'busy' | 'error'
    }
  | { kind: 'applied'; applied: number; leftToFeed: number }

export interface SocketApplier {
  /**
   * Never throws and never writes sync state. Safe to fire and forget. Frames
   * run one at a time in arrival order.
   */
  apply(frame: ChangesAvailable): Promise<SocketApplyOutcome>
}

export function createSocketApplier(deps: SocketApplyDeps): SocketApplier {
  const isCovered = (frame: ChangesAvailable): boolean =>
    typeof frame.cursor === 'number' && frame.cursor <= deps.appliedCursor()
  let busyReported = false

  const reportBusy = (cause: 'page_apply' | 'push_in_flight'): void => {
    if (busyReported) return
    busyReported = true
    log.warn('Socket items dropped: the wait did not settle; the pull delivers them', { cause })
    trackMainLog('warn', { scope: 'SocketApply', action: 'socket_items_busy', errorCode: cause })
  }

  /**
   * One page session per frame, like a pull page: each item's apply, conflict
   * requeue and body owe commit together on a SAVEPOINT or not at all, and the
   * note file ops are journaled before COMMIT (#2385). They land in this same
   * synchronous run; a failed op stays journaled for the next pull's replay.
   */
  const applyNow = (
    decrypted: DecryptedPullItem[],
    vaultKey: Uint8Array
  ): { applied: number; changed: number; leftToFeed: number } => {
    let applied = 0
    let changed = 0
    let leftToFeed = 0
    let conflicts = 0
    const wasSuppressed = deps.isPushSuppressed()
    deps.setPushSuppressed(true)
    try {
      const page = beginPageApply(deps.db)
      try {
        for (const dec of sortByApplyOrder(decrypted)) {
          let settled: ReturnType<typeof applyDecryptedItem> | null
          try {
            settled = page.savepoint(() => {
              const outcome = applyDecryptedItem(deps.applier, dec, vaultKey, page)
              const { result, operation } = outcome
              if (result === 'parse_error' || result === 'schema_invalid') return null
              // The pull's order: report the conflict, then owe the body. A
              // skipped version was owed by whatever applied it.
              if (result === 'conflict') deps.onConflict(dec, page)
              if (result !== 'skipped' && carriesCrdtBody(dec, operation)) {
                deps.oweRecordBody(dec.id)
              }
              return outcome
            })
          } catch (error) {
            // A missing FK parent or a pending sync intent included: the pull
            // defers it. A throw after the apply rolled the item back whole.
            log.debug('Socket item left to the pull', {
              type: dec.type,
              error: error instanceof Error ? error.name : 'unknown'
            })
            leftToFeed++
            continue
          }
          if (!settled) {
            leftToFeed++
            continue
          }
          applied++
          // A skipped row changed nothing, and every ITEM_SYNCED makes the
          // renderer refetch; the pull has the same rule.
          if (settled.result === 'skipped') continue
          changed++
          if (settled.result === 'conflict') conflicts++
          const { operation } = settled
          page.afterCommit(() => deps.onApplied(dec, operation))
        }
        page.commit()
      } catch (error) {
        page.rollback()
        throw error
      }
      page.flushFilesSync()
    } finally {
      deps.setPushSuppressed(wasSuppressed)
    }
    if (conflicts > 0) deps.requestPush()
    return { applied, changed, leftToFeed }
  }

  const run = async (frame: ChangesAvailable): Promise<SocketApplyOutcome> => {
    const items = frame.items ?? []
    if (items.length === 0) return { kind: 'skipped', reason: 'no_items' }
    if (!deps.eligible()) return { kind: 'skipped', reason: 'ineligible' }
    if (isCovered(frame)) return { kind: 'skipped', reason: 'covered' }

    const bounded = items.slice(0, SOCKET_APPLY_MAX_ITEMS)
    const candidates = bounded.filter((item) => !deps.isQuarantined(item.id, item.type))
    const vaultKey = await deps.getVaultKey()
    if (!vaultKey) return { kind: 'skipped', reason: 'no_key' }
    try {
      const deviceKeys = new Map<string, Promise<Uint8Array | null>>()
      // Signature verification happens here, in the same batch decrypt the
      // pull uses. A failure of any kind is not recorded: the pull decides
      // quarantine, corruption and key mismatch with the page context.
      const { decrypted, failures } = await decryptPullBatch(candidates, vaultKey, {
        workerBridge: deps.workerBridge,
        resolveDeviceKey: (id) => {
          let key = deviceKeys.get(id)
          if (!key) {
            key = deps.getDevicePublicKey(id)
            deviceKeys.set(id, key)
          }
          return key
        }
      })
      if (decrypted.length === 0) return { kind: 'skipped', reason: 'nothing_valid' }

      const deadline = Date.now() + SOCKET_APPLY_QUIESCENCE_TIMEOUT_MS
      // Checked here, in this function's own continuation, and not inside a
      // helper that returns: any microtask between that return and this code
      // could commit a page and start its file flush, or start a push. From
      // the check below to the last file write nothing is awaited, so neither
      // can start in between (bulk-apply.ts, protocol 09 §9.13).
      while (!isPageApplyQuiescent() || deps.pushInFlight()) {
        const remaining = deadline - Date.now()
        const cause = isPageApplyQuiescent() ? 'push_in_flight' : 'page_apply'
        const settled =
          remaining > 0 &&
          (cause === 'page_apply'
            ? await whenPageApplyQuiescent(remaining)
            : await deps.whenPushSettled(remaining))
        if (!settled) {
          reportBusy(cause)
          return { kind: 'skipped', reason: 'busy' }
        }
      }
      if (!deps.eligible()) return { kind: 'skipped', reason: 'ineligible' }
      if (isCovered(frame)) return { kind: 'skipped', reason: 'covered' }

      const outcome = applyNow(decrypted, vaultKey)
      traceSocketApplied(frame.committedAtMs, frame.cursor, outcome.changed)
      return {
        kind: 'applied',
        applied: outcome.applied,
        leftToFeed: outcome.leftToFeed + failures.length + (items.length - candidates.length)
      }
    } finally {
      secureCleanup(vaultKey)
    }
  }

  const runSafely = async (frame: ChangesAvailable): Promise<SocketApplyOutcome> => {
    try {
      return await run(frame)
    } catch (error) {
      log.warn('Socket items dropped; the wake pull delivers them', {
        error: error instanceof Error ? error.message : String(error)
      })
      return { kind: 'skipped', reason: 'error' }
    }
  }

  // One frame at a time, in arrival order: two frames racing through their
  // decrypts could otherwise apply an older version after a newer one.
  let tail: Promise<unknown> = Promise.resolve()
  return {
    apply(frame) {
      const next = tail.then(() => runSafely(frame))
      tail = next
      return next
    }
  }
}
