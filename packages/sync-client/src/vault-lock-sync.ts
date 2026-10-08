import type { DrizzleDb } from '@memry/sync-client/drizzle-db'
import { eq } from 'drizzle-orm'
import { vaultLocks } from '@memry/db-schema/schema/vault-locks'
import type { VectorClock } from '@memry/contracts/sync-api'
import { RecordSyncController, incrementClock } from '@memry/sync-core'
import { recoverOfflineDocClock } from './offline-clock'
import type { SyncQueueManager } from './queue'

interface VaultLockSyncDeps {
  queue: SyncQueueManager
  db: DrizzleDb
  getDeviceId: () => string | null
}

let instance: VaultLockSyncService | null = null

export function initVaultLockSyncService(deps: VaultLockSyncDeps): VaultLockSyncService {
  instance = new VaultLockSyncService(deps)
  return instance
}

export function getVaultLockSyncService(): VaultLockSyncService | null {
  return instance
}

export function resetVaultLockSyncService(): void {
  instance = null
}

export class VaultLockSyncService {
  private controller: RecordSyncController<Record<string, unknown>, [], []>

  constructor(deps: VaultLockSyncDeps) {
    const load = (lockId: string): Record<string, unknown> | undefined =>
      deps.db.select().from(vaultLocks).where(eq(vaultLocks.id, lockId)).get() as
        Record<string, unknown> | undefined

    this.controller = new RecordSyncController({
      type: 'vault_lock',
      queue: deps.queue,
      getDeviceId: deps.getDeviceId,
      load,
      applyLocalChange: ({ itemId, local, deviceId }) => {
        const existingClock = (local.clock as VectorClock) ?? {}
        const newClock = incrementClock(existingClock, deviceId)

        deps.db.update(vaultLocks).set({ clock: newClock }).where(eq(vaultLocks.id, itemId)).run()

        return { ...local, clock: newClock }
      },
      serialize: (local) => local,
      recoverPendingChange: (lockId, deviceId) =>
        recoverOfflineDocClock(load(lockId), deviceId, (clock) =>
          deps.db.update(vaultLocks).set({ clock }).where(eq(vaultLocks.id, lockId)).run()
        )
    })
  }

  enqueueCreate(lockId: string): void {
    this.controller.enqueueCreate(lockId)
  }

  enqueueUpdate(lockId: string): void {
    this.controller.enqueueUpdate(lockId)
  }

  enqueueRecoveredUpdate(lockId: string): void {
    this.controller.enqueueRecoveredUpdate(lockId)
  }

  /** Unlocking is an update (`locked: false`); a lock record is never deleted. */
  enqueueDelete(): void {}
}
