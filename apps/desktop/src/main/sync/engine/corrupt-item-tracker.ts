import { createLogger } from '../../lib/logger'
import type { RecordPullItemResponse } from '@memry/contracts/sync-api'
import { parsePullItems } from './pull-envelope'
import { decryptPullBatch } from '../sync-crypto-batch'
import { withRetry } from '@memry/sync-client/retry'
import { postToServer } from '../http-client'
import type { SyncContext } from './sync-context'
import type { QuarantineManager } from './quarantine-manager'
import {
  CORRUPT_ITEM_COOLDOWN_MS,
  MAX_CORRUPT_ITEMS,
  PULL_REQUEST_MAX_IDS,
  itemRefKey
} from './sync-context'

const log = createLogger('CorruptItemTracker')

export type ResolveDeviceKey = (deviceId: string) => Promise<Uint8Array | null>

export interface ItemRef {
  id: string
  type: string
}

export interface RecoveredItem {
  id: string
  type: string
  content: string
  clock?: Record<string, number>
  deletedAt?: number
  operation: string
}

export interface RefetchResult {
  recovered: RecoveredItem[]
  permanentFailures: ItemRef[]
  missing: ItemRef[]
  invalid: ItemRef[]
}

export class CorruptItemTracker {
  /**
   * (type, id) -> cooldown entry, capped at MAX_CORRUPT_ITEMS.
   *
   * Insertion order is kept equal to `failedAt` order (see `markFailed`), so
   * eviction is "delete from the front" without a sort.
   */
  private corruptItems = new Map<string, { failedAt: number; attempts: number }>()
  private evictionLogged = false
  private ctx: SyncContext
  private quarantine: QuarantineManager
  private resolveDeviceKey: ResolveDeviceKey

  constructor(ctx: SyncContext, quarantine: QuarantineManager, resolveDeviceKey: ResolveDeviceKey) {
    this.ctx = ctx
    this.quarantine = quarantine
    this.resolveDeviceKey = resolveDeviceKey
  }

  shouldRetry(ref: ItemRef): boolean {
    const entry = this.corruptItems.get(itemRefKey(ref.type, ref.id))
    if (!entry) return true
    if (Date.now() - entry.failedAt > CORRUPT_ITEM_COOLDOWN_MS) {
      this.corruptItems.delete(itemRefKey(ref.type, ref.id))
      return true
    }
    return false
  }

  markFailed(ref: ItemRef): void {
    const key = itemRefKey(ref.type, ref.id)
    const entry = this.corruptItems.get(key)
    if (entry) {
      entry.attempts++
      entry.failedAt = Date.now()
      // Re-insert so Map iteration order stays `failedAt` order. `set` on an
      // existing key does not move it, and `failedAt` is mutated in place, so
      // without this the eviction below would drop arbitrary entries instead of
      // the coldest ones.
      this.corruptItems.delete(key)
      this.corruptItems.set(key, entry)
    } else {
      this.corruptItems.set(key, { failedAt: Date.now(), attempts: 1 })
    }
    this.evictOverflow()
  }

  clearExpired(): void {
    const now = Date.now()
    for (const [id, entry] of this.corruptItems) {
      if (now - entry.failedAt > CORRUPT_ITEM_COOLDOWN_MS) {
        this.corruptItems.delete(id)
      }
    }
  }

  clear(): void {
    this.corruptItems.clear()
    this.evictionLogged = false
  }

  /**
   * Keep the map at MAX_CORRUPT_ITEMS. Expired entries go first (they are dead
   * weight already), then the oldest `failedAt` entries — the ones whose
   * cooldown is closest to lapsing. An evicted entry only means the item is
   * eligible for one more re-fetch on the next pull that carries it, never a
   * hot loop: the very next failure re-inserts the cooldown.
   */
  private evictOverflow(): void {
    if (this.corruptItems.size <= MAX_CORRUPT_ITEMS) return
    this.clearExpired()

    let overflow = this.corruptItems.size - MAX_CORRUPT_ITEMS
    if (overflow <= 0) return

    for (const key of this.corruptItems.keys()) {
      if (overflow <= 0) break
      this.corruptItems.delete(key)
      overflow--
    }

    if (!this.evictionLogged) {
      this.evictionLogged = true
      log.warn('Corrupt-item tracker at cap — evicting coldest entries', {
        cap: MAX_CORRUPT_ITEMS
      })
    }
  }

  /**
   * Re-fetches items by id, in `/sync/pull`-sized chunks. `missing`: the
   * server no longer has them. `invalid`: the server returned them, but they
   * still fail the envelope schema.
   */
  async refetch(
    failedItems: ItemRef[],
    token: string,
    vaultKey: Uint8Array
  ): Promise<RefetchResult> {
    const eligible = failedItems.filter((ref) => this.shouldRetry(ref))
    const total: RefetchResult = { recovered: [], permanentFailures: [], missing: [], invalid: [] }
    if (eligible.length === 0) return total

    log.info('Attempting re-fetch for corrupt items', { count: eligible.length })
    for (let i = 0; i < eligible.length; i += PULL_REQUEST_MAX_IDS) {
      const chunk = await this.refetchChunk(
        eligible.slice(i, i + PULL_REQUEST_MAX_IDS),
        token,
        vaultKey
      )
      for (const key of Object.keys(total) as Array<keyof RefetchResult>) {
        ;(total[key] as unknown[]).push(...chunk[key])
      }
    }
    return total
  }

  private async refetchChunk(
    eligible: ItemRef[],
    token: string,
    vaultKey: Uint8Array
  ): Promise<RefetchResult> {
    try {
      const pullResult = await withRetry(
        () =>
          postToServer<{ items: RecordPullItemResponse[] }>(
            '/sync/pull',
            { itemIds: Array.from(new Set(eligible.map((ref) => ref.id))) },
            token
          ),
        {
          signal: this.ctx.abortController?.signal ?? undefined,
          isOnline: () => this.ctx.deps.network.online
        }
      )

      const parsed = parsePullItems(pullResult.value)
      if (parsed.kind === 'not_envelope') {
        log.error('Re-fetch: invalid response')
        for (const ref of eligible) this.markFailed(ref)
        return { recovered: [], permanentFailures: eligible, missing: [], invalid: [] }
      }

      // The pull endpoint matches ids across ALL negotiated types, so an id
      // shared by two types (project 'inbox' vs tag 'inbox') returns BOTH
      // rows. Only process the (type, id) pairs this refetch actually asked
      // for — the sibling type was not corrupt and must not be re-branded here.
      const requested = new Set(eligible.map((ref) => itemRefKey(ref.type, ref.id)))
      const requestedItems = parsed.items.filter((item) =>
        requested.has(itemRefKey(item.type, item.id))
      )

      // A requested pair the server no longer returns (row purged/repaired
      // away) would otherwise vanish from the accounting entirely: never
      // recovered, never failed, re-requested on every page forever. Mark it
      // failed (cooldown) and report it permanent so it surfaces once.
      const invalid = parsed.invalid.filter((ref) => requested.has(itemRefKey(ref.type, ref.id)))
      const returned = new Set(
        [...requestedItems, ...invalid].map((item) => itemRefKey(item.type, item.id))
      )
      const missing = eligible.filter((ref) => !returned.has(itemRefKey(ref.type, ref.id)))
      for (const ref of invalid) this.markFailed(ref)
      for (const ref of missing) {
        this.markFailed(ref)
        log.warn('Re-fetch: item no longer on server', { itemId: ref.id, itemType: ref.type })
      }

      const signerIds = new Set(requestedItems.map((i) => i.signerDeviceId))
      for (const sid of signerIds) {
        await this.resolveDeviceKey(sid)
      }

      const { decrypted, failures } = await decryptPullBatch(requestedItems, vaultKey, {
        workerBridge: this.ctx.deps.workerBridge,
        resolveDeviceKey: (id) => this.resolveDeviceKey(id)
      })

      const permanentFailures: ItemRef[] = [...missing, ...invalid]
      for (const failure of failures) {
        if (failure.isSignatureError) {
          this.quarantine.quarantineItem(
            failure.id,
            failure.type,
            failure.signerDeviceId,
            failure.error
          )
        } else {
          this.markFailed({ id: failure.id, type: failure.type })
        }
        permanentFailures.push({ id: failure.id, type: failure.type })
        log.warn('Re-fetch: item failed again', {
          itemId: failure.id,
          itemType: failure.type,
          error: failure.error
        })
      }

      return { recovered: decrypted, permanentFailures, missing, invalid }
    } catch (error) {
      log.error('Re-fetch request failed', {
        error: error instanceof Error ? error.message : String(error)
      })
      for (const ref of eligible) this.markFailed(ref)
      return { recovered: [], permanentFailures: eligible, missing: [], invalid: [] }
    }
  }
}
