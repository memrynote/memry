import { VaultChannels } from '@memry/contracts/ipc-channels'
import { invoke, subscribe } from '../lib/ipc'

export const vaultApi = {
  select: (path?: string) => invoke(VaultChannels.invoke.SELECT, { path }),
  create: (path: string, _name: string) => invoke(VaultChannels.invoke.SELECT, { path }),
  getAll: () => invoke(VaultChannels.invoke.GET_ALL),
  getStatus: () => invoke(VaultChannels.invoke.GET_STATUS),
  getConfig: () => invoke(VaultChannels.invoke.GET_CONFIG),
  updateConfig: (config: Record<string, unknown>) =>
    invoke(VaultChannels.invoke.UPDATE_CONFIG, config),
  close: () => invoke(VaultChannels.invoke.CLOSE),
  switch: (vaultPath: string) => invoke(VaultChannels.invoke.SWITCH, vaultPath),
  remove: (vaultPath: string) => invoke(VaultChannels.invoke.REMOVE, vaultPath),
  reindex: () => invoke(VaultChannels.invoke.REINDEX),
  reveal: () => invoke(VaultChannels.invoke.REVEAL)
}

export const vaultEvents = {
  onVaultStatusChanged: (callback: (status: unknown) => void): (() => void) =>
    subscribe<unknown>(VaultChannels.events.STATUS_CHANGED, callback),

  onVaultIndexProgress: (callback: (progress: number) => void): (() => void) =>
    subscribe<number>(VaultChannels.events.INDEX_PROGRESS, callback),

  onVaultError: (callback: (error: string) => void): (() => void) =>
    subscribe<string>(VaultChannels.events.ERROR, callback),

  onVaultIndexRecovered: (
    callback: (event: { reason: string; filesIndexed: number; duration: number }) => void
  ): (() => void) =>
    subscribe<{ reason: string; filesIndexed: number; duration: number }>(
      VaultChannels.events.INDEX_RECOVERED,
      callback
    )
}
