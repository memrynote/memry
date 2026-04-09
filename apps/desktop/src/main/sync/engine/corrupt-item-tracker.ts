import { createLogger } from '../../lib/logger'
import type { RecordPullItemResponse } from '@memry/contracts/sync-api'
import { RecordPullResponseSchema } from '@memry/contracts/sync-api'
import { decryptPullBatch } from '../sync-crypto-batch'
import { withRetry } from '../retry'
import { postToServer } from '../http-client'
import type { SyncContext } from './sync-context'
import type { QuarantineManager } from './quarantine-manager'
import { CORRUPT_ITEM_COOLDOWN_MS } from './sync-context'

const log = createLogger('CorruptItemTracker')

export type ResolveDeviceKey = (deviceId: string) => Promise<Uint8Array | null>

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

  shouldRetry(itemId: string): boolean {
    const entry = this.corruptItems.get(itemId)
    if (!entry) return true
    if (Date.now() - entry.failedAt > CORRUPT_ITEM_COOLDOWN_MS) {
      this.corruptItems.delete(itemId)
      return true
    }
    return false
  }

  markFailed(itemId: string): void {
    const entry = this.corruptItems.get(itemId)
    if (entry) {
      entry.attempts++
      entry.failedAt = Date.now()
    } else {
      this.corruptItems.set(itemId, { failedAt: Date.now(), attempts: 1 })
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
    failedItemIds: string[],
    token: string,
    vaultKey: Uint8Array
  ): Promise<{ recovered: RecoveredItem[]; permanentFailures: string[] }> {
    const eligible = failedItemIds.filter((id) => this.shouldRetry(id))
    if (eligible.length === 0) return { recovered: [], permanentFailures: [] }

    log.info('Attempting re-fetch for corrupt items', { count: eligible.length })

    try {
      const pullResult = await withRetry(
        () =>
          postToServer<{ items: RecordPullItemResponse[] }>(
            '/sync/pull',
            { itemIds: eligible },
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
        for (const id of eligible) this.markFailed(id)
        return { recovered: [], permanentFailures: eligible }
      }

      const signerIds = new Set(parsed.data.items.map((i) => i.signerDeviceId))
      for (const sid of signerIds) {
        await this.resolveDeviceKey(sid)
      }

      const { decrypted, failures } = await decryptPullBatch(parsed.data.items, vaultKey, {
        workerBridge: this.ctx.deps.workerBridge,
        resolveDeviceKey: (id) => this.resolveDeviceKey(id)
      })

      const permanentFailures: string[] = []
      for (const failure of failures) {
        if (failure.isSignatureError) {
          this.quarantine.quarantineItem(
            failure.id,
            failure.type,
            failure.signerDeviceId,
            failure.error
          )
        } else {
          this.markFailed(failure.id)
        }
        permanentFailures.push(failure.id)
        log.warn('Re-fetch: item failed again', { itemId: failure.id, error: failure.error })
      }

      return { recovered: decrypted, permanentFailures }
    } catch (error) {
      log.error('Re-fetch request failed', {
        error: error instanceof Error ? error.message : String(error)
      })
      for (const id of eligible) this.markFailed(id)
      return { recovered: [], permanentFailures: eligible }
    }
  }
}
