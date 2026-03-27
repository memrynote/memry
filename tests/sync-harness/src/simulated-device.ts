import type { SyncItemType, SyncOperation } from '@memry/contracts/sync-api'
import { encryptItemForPush, decryptItemFromPull, initCrypto } from './crypto.js'
import type { DeviceIdentity, FetchFn, VectorClock, SyncItem, PullItemData } from './types.js'

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
    changedFields?: string[]
  ): Promise<SyncItem> {
    await initCrypto()

    const clock: VectorClock = { [this.identity.deviceId]: 1 }
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
    changedFields?: string[]
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
        operation: item.operation as SyncOperation,
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
            `Unknown signer device: ${item.signerDeviceId}. ` + `Call registerPeerDevice() first.`
          )
        }

        if (item.deletedAt) {
          this.items.delete(item.id)
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
