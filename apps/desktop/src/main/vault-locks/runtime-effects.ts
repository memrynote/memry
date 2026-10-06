import { enqueueLocalSyncCreate, enqueueLocalSyncUpdate } from '../sync/local-mutations'

export function enqueueVaultLockCreate(lockId: string): void {
  enqueueLocalSyncCreate('vault_lock', lockId)
}

export function enqueueVaultLockUpdate(lockId: string): void {
  enqueueLocalSyncUpdate('vault_lock', lockId)
}
