import { VaultLocksChannels } from '@memry/contracts/ipc-channels'
import { invoke, subscribe } from '../lib/ipc'
import type {
  VaultLockExternalEditRestoredEvent,
  VaultLockSetInput,
  VaultLockState
} from '@memry/contracts/vault-locks-api'

export const vaultLocksApi = {
  list: (): Promise<VaultLockState> => invoke(VaultLocksChannels.invoke.LIST),
  set: (input: VaultLockSetInput): Promise<VaultLockState> =>
    invoke(VaultLocksChannels.invoke.SET, input)
}

export const vaultLocksEvents = {
  onVaultLocksChanged: (callback: (state: VaultLockState) => void): (() => void) =>
    subscribe<VaultLockState>(VaultLocksChannels.events.CHANGED, callback),
  onVaultLockExternalEditRestored: (
    callback: (event: VaultLockExternalEditRestoredEvent) => void
  ): (() => void) =>
    subscribe<VaultLockExternalEditRestoredEvent>(
      VaultLocksChannels.events.EXTERNAL_EDIT_RESTORED,
      callback
    )
}
