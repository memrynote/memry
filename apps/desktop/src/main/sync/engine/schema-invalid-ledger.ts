import { app } from 'electron'
import { z } from 'zod'
import type { QuarantinedItemInfo } from '@memry/contracts/ipc-events'
import { createLogger } from '../../lib/logger'
import type { ItemRef } from './corrupt-item-tracker'
import type { SyncStateManager } from './sync-state-manager'
import {
  CORRUPT_ITEM_COOLDOWN_MS,
  NOTE_BODY_ITEM_TYPE,
  SYNC_STATE_KEYS,
  itemRefKey
} from './sync-context'

const log = createLogger('SchemaInvalidLedger')

/**
 * `payload`: the handler schema refused it, usually a newer peer's shape; only
 * a different app version can accept it. `envelope`: the pull envelope schema
 * refused it, usually a server fault; it is retried on the corrupt-item
 * cooldown too, since the fix can ship on the server. `blob_missing`: the
 * server holds the row live but lost its payload (#2302); nothing was applied
 * and the local row, if any, is kept. Held here so the manifest does not count
 * it server-only (a full re-pull every check), and retried on the cooldown
 * because a later push of the item heals it. `pending_intent`: the item was
 * refused because this device's own edit of it is not clocked yet (#2301); it
 * is re-fetched at every pull start, right after the pending intents drain,
 * and is not a quarantined item.
 */
export type SchemaInvalidKind = 'payload' | 'envelope' | 'blob_missing' | 'pending_intent'

const LedgerEntrySchema = z.object({
  id: z.string(),
  type: z.string(),
  // An older build reads a kind it does not know as 'payload' (never a throw).
  kind: z.enum(['payload', 'envelope', 'blob_missing', 'pending_intent']).catch('payload'),
  lastRefusedByVersion: z.string(),
  failedAt: z.number()
})
type LedgerEntry = z.infer<typeof LedgerEntrySchema>

/**
 * Items this build refused to apply (#2285). The one global cursor moves past
 * them, so this persisted ledger is what brings them back: the pull re-fetches
 * them by id once another app version is running (or, for envelope failures,
 * after the cooldown). Entries a later apply accepts are resolved.
 */
export class SchemaInvalidLedger {
  constructor(
    private stateManager: SyncStateManager,
    private appVersion: () => string = () => app.getVersion()
  ) {}

  record(refs: ItemRef[], kind: SchemaInvalidKind): void {
    if (refs.length === 0) return
    const entries = this.read()
    const lastRefusedByVersion = this.appVersion()
    for (const ref of refs) {
      entries[itemRefKey(ref.type, ref.id)] = {
        id: ref.id,
        type: ref.type,
        kind,
        lastRefusedByVersion,
        failedAt: Date.now()
      }
    }
    this.write(entries)
  }

  resolve(refs: ItemRef[]): void {
    const entries = this.read()
    const before = Object.keys(entries).length
    for (const ref of refs) delete entries[itemRefKey(ref.type, ref.id)]
    if (Object.keys(entries).length !== before) this.write(entries)
  }

  /**
   * Entries another app version refused, envelope or blob_missing entries past
   * the cooldown, and every pending_intent entry.
   */
  retryable(): ItemRef[] {
    const entries = Object.values(this.read())
    if (entries.length === 0) return []
    const version = this.appVersion()
    const now = Date.now()
    return entries
      .filter(
        (entry) =>
          entry.kind === 'pending_intent' ||
          entry.lastRefusedByVersion !== version ||
          (entry.kind !== 'payload' && now - entry.failedAt > CORRUPT_ITEM_COOLDOWN_MS)
      )
      .map(({ id, type }) => ({ id, type }))
  }

  has(type: string, id: string): boolean {
    return itemRefKey(type, id) in this.read()
  }

  /**
   * Neither an edit waiting on its intent nor a refused change-feed body
   * (#2297) is a quarantined item: each heals by itself and asks nothing of
   * the user.
   */
  quarantinedItems(): QuarantinedItemInfo[] {
    const entries = Object.values(this.read()).filter(
      (entry) => entry.kind !== 'pending_intent' && entry.type !== NOTE_BODY_ITEM_TYPE
    )
    return entries.map((entry) => ({
      itemId: entry.id,
      itemType: entry.type,
      signerDeviceId: '',
      failedAt: entry.failedAt,
      attemptCount: 1,
      lastError: `schema_invalid:${entry.kind} (app ${entry.lastRefusedByVersion})`,
      permanent: false
    }))
  }

  private read(): Record<string, LedgerEntry> {
    const raw = this.stateManager.getStateValue(SYNC_STATE_KEYS.SCHEMA_INVALID_ITEMS)
    if (!raw) return {}
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      log.error('Unreadable schema-invalid ledger, starting a new one', { error })
      return {}
    }
    const entries: Record<string, LedgerEntry> = {}
    if (typeof parsed !== 'object' || parsed === null) return entries
    for (const [key, value] of Object.entries(parsed)) {
      const entry = LedgerEntrySchema.safeParse(value)
      if (entry.success) entries[key] = entry.data
      else log.warn('Dropping an unreadable schema-invalid ledger entry', { key })
    }
    return entries
  }

  private write(entries: Record<string, LedgerEntry>): void {
    this.stateManager.setStateValue(SYNC_STATE_KEYS.SCHEMA_INVALID_ITEMS, JSON.stringify(entries))
  }
}
