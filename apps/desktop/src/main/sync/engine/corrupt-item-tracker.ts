import { createLogger } from '../../lib/logger'
import type { RecordPullItemResponse } from '@memry/contracts/sync-api'
import { RecordPullResponseSchema } from '@memry/contracts/sync-api'
import { decryptPullBatch } from '../sync-crypto-batch'
import { withRetry } from '../retry'
import { postToServer } from '../http-client'
import type { SyncContext } from './sync-context'
import type { QuarantineManager } from './quarantine-manager'
import { CORRUPT_ITEM_COOLDOWN_MS, itemRefKey } from './sync-context'

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

export class CorruptItemTracker {
  private corruptItems = new Map<string, { failedAt: number; attempts: number }>()
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
    const entry = this.corruptItems.get(itemRefKey(ref.type, ref.id))
    if (entry) {
      entry.attempts++
      entry.failedAt = Date.now()
    } else {
      this.corruptItems.set(itemRefKey(ref.type, ref.id), { failedAt: Date.now(), attempts: 1 })
    }
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
  }

  async refetch(
    failedItems: ItemRef[],
    token: string,
    vaultKey: Uint8Array
  ): Promise<{ recovered: RecoveredItem[]; permanentFailures: ItemRef[] }> {
    const eligible = failedItems.filter((ref) => this.shouldRetry(ref))
    if (eligible.length === 0) return { recovered: [], permanentFailures: [] }

    log.info('Attempting re-fetch for corrupt items', { count: eligible.length })

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

      const parsed = RecordPullResponseSchema.safeParse(pullResult.value)
      if (!parsed.success) {
        log.error('Re-fetch: invalid response', { error: parsed.error.message })
        for (const ref of eligible) this.markFailed(ref)
        return { recovered: [], permanentFailures: eligible }
      }

      // The pull endpoint matches ids across ALL negotiated types, so an id
      // shared by two types (project 'inbox' vs tag 'inbox') returns BOTH
      // rows. Only process the (type, id) pairs this refetch actually asked
      // for — the sibling type was not corrupt and must not be re-branded here.
      const requested = new Set(eligible.map((ref) => itemRefKey(ref.type, ref.id)))
      const requestedItems = parsed.data.items.filter((item) =>
        requested.has(itemRefKey(item.type, item.id))
      )

      // A requested pair the server no longer returns (row purged/repaired
      // away) would otherwise vanish from the accounting entirely: never
      // recovered, never failed, re-requested on every page forever. Mark it
      // failed (cooldown) and report it permanent so it surfaces once.
      const returned = new Set(requestedItems.map((item) => itemRefKey(item.type, item.id)))
      const missing = eligible.filter((ref) => !returned.has(itemRefKey(ref.type, ref.id)))
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

      const permanentFailures: ItemRef[] = [...missing]
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

      return { recovered: decrypted, permanentFailures }
    } catch (error) {
      log.error('Re-fetch request failed', {
        error: error instanceof Error ? error.message : String(error)
      })
      for (const ref of eligible) this.markFailed(ref)
      return { recovered: [], permanentFailures: eligible }
    }
  }
}
