import type { SyncItemType } from '@memry/contracts/sync-api'
import { encryptItemForPush, decryptItemFromPull, initCrypto } from './crypto.js'
import type { DeviceIdentity, FetchFn, VectorClock, SyncItem, PullItemData } from './types.js'
import type { LocalBody, LocalVaultState } from './zero-loss-oracle/index.js'

interface ChangesResponse {
  items: Array<{
    id: string
    type: string
    version: number
    modifiedAt: number
    size: number
    stateVector?: string
  }>
  deleted: string[]
  hasMore: boolean
  nextCursor: number
}

interface PullResponse {
  items: PullItemData[]
}

interface PushResponse {
  accepted: string[]
  rejected: Array<{ id: string; reason: string }>
  serverTime: number
  maxCursor: number
}

export class SimulatedDevice {
  readonly identity: DeviceIdentity
  private fetchFn: FetchFn
  private items = new Map<string, SyncItem>()
  private lastCursor = 0
  private devicePublicKeys = new Map<string, Uint8Array>()
  /** Highest delete clock seen per id, local or pulled (#2409). */
  private tombstoneClocks = new Map<string, VectorClock>()
  /** CRDT documents pulled item by item: baseline revision and applied update sequences. */
  private bodies = new Map<string, LocalBody>()
  /** Each body's applied payloads (base64) in apply order, the harness's document content. */
  private bodyParts = new Map<string, string[]>()

  constructor(identity: DeviceIdentity, fetchFn: FetchFn) {
    this.identity = identity
    this.fetchFn = fetchFn
    this.devicePublicKeys.set(identity.deviceId, identity.signingPublicKey)
  }

  registerPeerDevice(deviceId: string, publicKey: Uint8Array): void {
    this.devicePublicKeys.set(deviceId, publicKey)
  }

  getItem(itemId: string): SyncItem | undefined {
    return this.items.get(itemId)
  }

  getAllItems(): Map<string, SyncItem> {
    return new Map(this.items)
  }

  getLastCursor(): number {
    return this.lastCursor
  }

  async createItem(
    type: SyncItemType,
    itemId: string,
    content: Record<string, unknown>,
    _changedFields?: string[]
  ): Promise<SyncItem> {
    await initCrypto()

    // A conforming client seeds a create from the id's last tombstone clock,
    // `increment(merge({}, T), device)`, so a re-create happens after the delete
    // (protocol 05 §5.8, #2409). With no tombstone this is `{device: 1}`.
    const clock: VectorClock = { ...this.tombstoneClocks.get(itemId) }
    clock[this.identity.deviceId] = (clock[this.identity.deviceId] ?? 0) + 1
    const item: SyncItem = {
      id: itemId,
      type,
      content,
      clock,
      operation: 'create'
    }
    this.items.set(itemId, item)
    return item
  }

  async updateItem(
    itemId: string,
    fields: Record<string, unknown>,
    _changedFields?: string[]
  ): Promise<SyncItem> {
    const existing = this.items.get(itemId)
    if (!existing) throw new Error(`Item ${itemId} not found on device ${this.identity.deviceId}`)

    const newClock = { ...existing.clock }
    const currentTick = newClock[this.identity.deviceId] ?? 0
    newClock[this.identity.deviceId] = currentTick + 1

    const updated: SyncItem = {
      ...existing,
      content: { ...existing.content, ...fields },
      clock: newClock,
      operation: 'update'
    }
    this.items.set(itemId, updated)
    return updated
  }

  async deleteItem(itemId: string): Promise<SyncItem> {
    const existing = this.items.get(itemId)
    if (!existing) throw new Error(`Item ${itemId} not found on device ${this.identity.deviceId}`)

    const newClock = { ...existing.clock }
    const currentTick = newClock[this.identity.deviceId] ?? 0
    newClock[this.identity.deviceId] = currentTick + 1

    const deleted: SyncItem = {
      ...existing,
      content: {},
      clock: newClock,
      operation: 'delete',
      deletedAt: Date.now()
    }
    this.items.set(itemId, deleted)
    this.recordTombstoneClock(itemId, newClock)
    return deleted
  }

  async push(items?: SyncItem[]): Promise<PushResponse> {
    await initCrypto()

    const toPush =
      items ??
      Array.from(this.items.values()).filter(
        (item) =>
          item.operation === 'create' || item.operation === 'update' || item.operation === 'delete'
      )

    if (toPush.length === 0) {
      return { accepted: [], rejected: [], serverTime: 0, maxCursor: 0 }
    }

    const pushItems = toPush.map((item) => {
      const contentBytes = new TextEncoder().encode(JSON.stringify(item.content))
      const { pushItem } = encryptItemForPush({
        id: item.id,
        type: item.type,
        operation: item.operation,
        content: contentBytes,
        vaultKey: this.identity.vaultKey,
        signingSecretKey: this.identity.signingSecretKey,
        signerDeviceId: this.identity.deviceId,
        clock: item.clock,
        deletedAt: item.deletedAt
      })
      return pushItem
    })

    const response = await this.fetchFn('http://localhost/sync/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.identity.accessToken}`
      },
      body: JSON.stringify({ items: pushItems })
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Push failed (${response.status}): ${body}`)
    }

    return response.json() as Promise<PushResponse>
  }

  async pull(): Promise<{ applied: number; items: SyncItem[] }> {
    await initCrypto()

    const applied: SyncItem[] = []
    let hasMore = true

    while (hasMore) {
      const changes = await this.fetchChanges()
      if (changes.items.length === 0 && changes.deleted.length === 0) {
        break
      }

      const allIds = [...changes.items.map((i) => i.id), ...changes.deleted]
      const pulled = await this.fetchItems(allIds)

      for (const item of pulled.items) {
        const signerKey = this.devicePublicKeys.get(item.signerDeviceId)
        if (!signerKey) {
          throw new Error(
            `Unknown signer device: ${item.signerDeviceId}. Call registerPeerDevice() first.`
          )
        }

        if (item.deletedAt) {
          this.items.delete(item.id)
          this.recordTombstoneClock(item.id, item.clock ?? {})
          applied.push({
            id: item.id,
            type: item.type as SyncItemType,
            content: {},
            clock: item.clock ?? {},
            operation: 'delete',
            deletedAt: item.deletedAt
          })
          continue
        }

        const { content } = decryptItemFromPull({
          id: item.id,
          type: item.type,
          operation: item.operation,
          cryptoVersion: item.cryptoVersion,
          encryptedKey: item.blob.encryptedKey,
          keyNonce: item.blob.keyNonce,
          encryptedData: item.blob.encryptedData,
          dataNonce: item.blob.dataNonce,
          signature: item.signature,
          signerDeviceId: item.signerDeviceId,
          metadata: item.clock ? { clock: item.clock } : undefined,
          vaultKey: this.identity.vaultKey,
          signerPublicKey: signerKey
        })

        const parsed = JSON.parse(new TextDecoder().decode(content)) as Record<string, unknown>
        const clock = item.clock ?? {}

        const syncItem: SyncItem = {
          id: item.id,
          type: item.type as SyncItemType,
          content: parsed,
          clock,
          operation: item.operation as 'create' | 'update'
        }

        this.items.set(item.id, syncItem)
        applied.push(syncItem)
      }

      this.lastCursor = changes.nextCursor
      hasMore = changes.hasMore
    }

    return { applied: applied.length, items: applied }
  }

  /**
   * Pulls each body the item-granular way (protocol 07): the snapshot as
   * baseline, then every update past its sequence through the batch endpoint.
   * Only sequences are kept: the harness checks what was applied, not the bytes.
   */
  async pullBodies(noteIds: string[]): Promise<void> {
    for (const noteId of noteIds) {
      const snapshot = (await this.request(`/sync/crdt/snapshot/${noteId}`)) as {
        snapshot: string | null
        sequenceNum: number
        revision: string | null
      }
      const parts = snapshot.snapshot ? [snapshot.snapshot] : []
      let since = snapshot.sequenceNum
      for (;;) {
        const batch = (await this.request('/sync/crdt/updates/batch', {
          notes: [{ noteId, since }]
        })) as {
          notes: Record<
            string,
            { updates: Array<{ sequenceNum: number; data: string }>; hasMore: boolean }
          >
        }
        const page = batch.notes[noteId]
        parts.push(...page.updates.map((u) => u.data))
        const last = page.updates.at(-1)
        if (!page.hasMore) {
          since = last?.sequenceNum ?? since
          break
        }
        // Alone in its request, a note always gets its first update (crdt.ts
        // planUpdatePage), so an empty page with more to come is a stuck pull.
        if (!last) throw new Error(`body pull for ${noteId} made no progress at ${since}`)
        since = last.sequenceNum
      }
      this.bodies.set(noteId, {
        snapshotRevision: snapshot.revision,
        appliedThrough: since,
        empty: parts.length === 0
      })
      this.bodyParts.set(noteId, parts)
    }
  }

  getBodyParts(noteId: string): string[] {
    return [...(this.bodyParts.get(noteId) ?? [])]
  }

  /** The device's records and bodies in the zero-loss oracle's local shape. */
  oracleState(): LocalVaultState {
    const records: LocalVaultState['records'] = {}
    for (const [id, clock] of this.tombstoneClocks) {
      records[id] = { type: 'unknown', clock, deleted: true }
    }
    for (const item of this.items.values()) {
      records[item.id] = {
        type: item.type,
        clock: item.clock,
        deleted: item.operation === 'delete'
      }
    }
    return { records, bodies: Object.fromEntries(this.bodies) }
  }

  private async request(path: string, body?: unknown): Promise<unknown> {
    const response = await this.fetchFn(`http://localhost${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.identity.accessToken}`
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
    if (!response.ok) {
      throw new Error(`${path} failed (${response.status}): ${await response.text()}`)
    }
    return response.json()
  }

  private recordTombstoneClock(itemId: string, clock: VectorClock): void {
    const merged = { ...this.tombstoneClocks.get(itemId) }
    for (const [device, tick] of Object.entries(clock)) {
      merged[device] = Math.max(merged[device] ?? 0, tick)
    }
    this.tombstoneClocks.set(itemId, merged)
  }

  private async fetchChanges(): Promise<ChangesResponse> {
    const cursorParam = this.lastCursor > 0 ? `&cursor=${this.lastCursor}` : ''
    const response = await this.fetchFn(`http://localhost/sync/changes?limit=100${cursorParam}`, {
      headers: { Authorization: `Bearer ${this.identity.accessToken}` }
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Changes failed (${response.status}): ${body}`)
    }

    return response.json() as Promise<ChangesResponse>
  }

  private async fetchItems(itemIds: string[]): Promise<PullResponse> {
    if (itemIds.length === 0) return { items: [] }

    const response = await this.fetchFn('http://localhost/sync/pull', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.identity.accessToken}`
      },
      body: JSON.stringify({ itemIds })
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Pull failed (${response.status}): ${body}`)
    }

    return response.json() as Promise<PullResponse>
  }
}
