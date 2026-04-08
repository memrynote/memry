import type { SyncAdapter, RemoteSyncAdapter, RecordLocalSyncAdapter } from './adapter'
import type { SyncItemType } from '@memry/contracts/sync-api'

export class SyncAdapterRegistry<TDb = unknown, TEmit = unknown> {
  private readonly adapters = new Map<SyncItemType, SyncAdapter<TDb, TEmit>>()

  constructor(adapters: Array<SyncAdapter<TDb, TEmit>>) {
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.type)) {
        throw new Error(`Duplicate sync adapter registration for ${adapter.type}`)
      }
      this.adapters.set(adapter.type, adapter)
    }
  }

  get(type: SyncItemType): SyncAdapter<TDb, TEmit> | undefined {
    return this.adapters.get(type)
  }

  getLocal(type: SyncItemType): RecordLocalSyncAdapter | undefined {
    return this.get(type)?.local
  }

  getRemote(type: SyncItemType): RemoteSyncAdapter<TDb, TEmit> | undefined {
    return this.get(type)?.remote
  }

  getAll(): Array<SyncAdapter<TDb, TEmit>> {
    return Array.from(this.adapters.values())
  }

  getAllLocal(): RecordLocalSyncAdapter[] {
    return this.getAll()
      .map((adapter) => adapter.local)
      .filter((adapter): adapter is RecordLocalSyncAdapter => Boolean(adapter))
  }

  getAllRemote(): Array<RemoteSyncAdapter<TDb, TEmit>> {
    return this.getAll()
      .map((adapter) => adapter.remote)
      .filter((adapter): adapter is RemoteSyncAdapter<TDb, TEmit> => Boolean(adapter))
  }
}

export function createSyncAdapterRegistry<TDb = unknown, TEmit = unknown>(
  adapters: Array<SyncAdapter<TDb, TEmit>>
): SyncAdapterRegistry<TDb, TEmit> {
  return new SyncAdapterRegistry(adapters)
}
