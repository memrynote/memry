import {
  VaultActivityChannels,
  type ListVaultActivityInput,
  type VaultActivityRetentionDays
} from '@memry/contracts/vault-activity-api'
import { invoke, subscribe } from '../lib/ipc'

export const vaultActivityApi = {
  list: (input: ListVaultActivityInput = {}) => invoke(VaultActivityChannels.invoke.LIST, input),
  clear: () => invoke(VaultActivityChannels.invoke.CLEAR),
  setRetention: (days: VaultActivityRetentionDays) =>
    invoke(VaultActivityChannels.invoke.SET_RETENTION, { days }),
  reveal: () => invoke(VaultActivityChannels.invoke.REVEAL)
}

export const vaultActivityEvents = {
  onVaultActivityChanged: (callback: () => void): (() => void) =>
    subscribe<void>(VaultActivityChannels.events.CHANGED, () => callback())
}
