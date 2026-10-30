import type {
  AccountVaultInfo,
  VaultClientAPI,
  VaultStatus,
  VaultConfig,
  SelectVaultResponse,
  GetVaultsResponse,
  IndexRecoveredEvent
} from '../../../preload/index.d'
import {
  commands,
  events,
  type GetVaultsResponse as WireVaultsResponse,
  type SelectVaultResponse as WireSelectResponse,
  type VaultInfo as WireVaultInfo
} from '../../../generated/bindings'
import { createLogger } from '../lib/logger'

const log = createLogger('VaultService')

/** `skip_serializing_if` fields are absent on the wire; the generated type also allows null. */
function toVaultInfo(wire: WireVaultInfo): GetVaultsResponse['vaults'][number] {
  const { vaultUuid, isMissing, accentColor, icon, ...rest } = wire
  return {
    ...rest,
    ...(vaultUuid != null && { vaultUuid }),
    ...(isMissing != null && { isMissing }),
    ...(accentColor != null && { accentColor }),
    ...(icon != null && { icon })
  }
}

function toVaults(wire: WireVaultsResponse): GetVaultsResponse {
  return { ...wire, vaults: wire.vaults.map(toVaultInfo) }
}

function toSelectResponse(wire: WireSelectResponse): SelectVaultResponse {
  const { vault, error, errorCode, ...rest } = wire
  return {
    ...rest,
    vault: vault ? toVaultInfo(vault) : vault,
    ...(error != null && { error }),
    // The Rust side only ever sends the two codes the contract names.
    ...(errorCode === 'already-exists' || errorCode === 'invalid-name' ? { errorCode } : {})
  }
}

/** A Tauri event as the renderer subscribes to it: a synchronous unsubscribe. */
function subscribe<T>(
  event: { listen: (handler: (event: { payload: T }) => void) => Promise<() => void> },
  callback: (payload: T) => void,
  onRegistered?: () => void
): () => void {
  let active = true
  const registered = event.listen((received) => {
    if (active) callback(received.payload)
  })
  registered
    .then(() => {
      if (active) onRegistered?.()
    })
    .catch((error: unknown) => log.warn('vault event subscription failed', error))
  return () => {
    active = false
    void registered.then((unlisten) => unlisten()).catch(() => undefined)
  }
}

/** The open vault's path, which `vault_reveal` takes. */
async function openVaultPath(): Promise<string | null> {
  return (await commands.vaultGetStatus()).path
}

async function readStatus(callback: (status: VaultStatus) => void): Promise<void> {
  try {
    callback(toStatus(await commands.vaultGetStatus()))
  } catch (error) {
    log.warn('initial vault status failed', error)
  }
}

function toStatus(wire: Awaited<ReturnType<typeof commands.vaultGetStatus>>): VaultStatus {
  const { indexBuilt, indexTotal, ...rest } = wire
  return {
    ...rest,
    ...(indexBuilt != null && { indexBuilt }),
    ...(indexTotal != null && { indexTotal })
  }
}

/**
 * Vault service for the renderer. The picker, the registry and the lifecycle go to the Rust
 * `vault_*` commands; config, reindex, embeds, the sandbox and the account calls stay on
 * `window.api.vault` until Steps 09, 12, 13, 19 and 32 port them.
 */
export const vaultService: VaultClientAPI = {
  /**
   * Select a vault folder. If no path provided, shows folder picker dialog.
   */
  select: (path?: string): Promise<SelectVaultResponse> => {
    return commands.vaultSelect(path ?? null).then(toSelectResponse)
  },

  /**
   * Create `<parentPath>/<name>` as a new folder and open it as the vault.
   */
  create: (parentPath: string, name: string): Promise<SelectVaultResponse> => {
    return commands.vaultCreate(parentPath, name).then(toSelectResponse)
  },

  getDefaultParent: (): Promise<string> => {
    return commands.vaultGetDefaultParent()
  },

  /**
   * Get all known vaults and current vault path.
   */
  getAll: (): Promise<GetVaultsResponse> => {
    return commands.vaultList().then(toVaults)
  },

  /**
   * Get current vault status.
   */
  getStatus: (): Promise<VaultStatus> => {
    return commands.vaultGetStatus().then(toStatus)
  },

  /**
   * The vault this window was created for, read synchronously. Null on the picker.
   */
  getStartupPath: (): string | null => {
    return window.__MEMRY_STARTUP__?.startupVault ?? null
  },

  /**
   * Get current vault configuration.
   */
  getConfig: (): Promise<VaultConfig> => {
    return window.api.vault.getConfig()
  },

  /**
   * Update vault configuration.
   */
  updateConfig: (config: Partial<VaultConfig>): Promise<VaultConfig> => {
    return window.api.vault.updateConfig(config)
  },

  /**
   * Close the current vault.
   */
  close: (): Promise<void> => {
    return commands.vaultClose().then(() => undefined)
  },

  /**
   * Switch to a different vault.
   */
  switch: (vaultPath: string): Promise<SelectVaultResponse> => {
    return commands.vaultSwitch(vaultPath).then(toSelectResponse)
  },

  /**
   * Remove a vault from the known list (doesn't delete files).
   */
  remove: (vaultPath: string): Promise<void> => {
    return commands.vaultRemove(vaultPath).then(() => undefined)
  },

  /**
   * Trigger manual reindex of current vault.
   */
  reindex: (): Promise<void> => {
    return window.api.vault.reindex()
  },

  reveal: async (): Promise<void> => {
    const path = await openVaultPath()
    if (path) await commands.vaultReveal(path)
  },

  /**
   * List all vaults in the signed-in account (local + cloud-only).
   */
  listAccount: (): Promise<AccountVaultInfo[]> => {
    return window.api.vault.listAccount()
  },

  /**
   * Provision + open a cloud-only vault locally.
   */
  downloadRemote: (vaultUuid: string, parentPath?: string): Promise<SelectVaultResponse> => {
    return window.api.vault.downloadRemote(vaultUuid, parentPath)
  },

  /**
   * Purge a vault from the signed-in account. Never touches local files.
   */
  deleteFromAccount: (vaultUuid: string): Promise<void> => {
    return window.api.vault.deleteFromAccount(vaultUuid)
  },

  /**
   * Set a listed vault's icon, or reset it to the default with null. Synced
   * account-wide once the vault syncs.
   */
  setIcon: (path: string, icon: string | null): Promise<void> => {
    return commands.vaultSetIcon(path, icon).then(() => undefined)
  },

  /**
   * Generate the sandbox vault when missing, stale or `reset`; resolves to its path.
   */
  prepareSandbox: (reset?: boolean): Promise<{ path: string }> => {
    return window.api.vault.prepareSandbox(reset)
  }
}

/**
 * Subscribe to vault list display changes (an icon set here or synced in).
 * Returns unsubscribe function.
 */
export function onVaultListChanged(callback: () => void): () => void {
  return subscribe(events.vaultListChangedEvent, () => callback())
}

/**
 * Subscribe to vault status changes. Events before the subscription are not replayed, so the
 * status is read once after it is registered and delivered as the first update.
 * Returns unsubscribe function.
 */
export function onVaultStatusChanged(callback: (status: VaultStatus) => void): () => void {
  return subscribe(
    events.vaultStatusChangedEvent,
    (status) => callback(toStatus(status)),
    () => {
      void readStatus(callback)
    }
  )
}

/**
 * Subscribe to vault index progress updates. Step 13 (#3530) ports the index build that emits
 * them.
 * Returns unsubscribe function.
 */
export function onVaultIndexProgress(callback: (progress: number) => void): () => void {
  return window.api.onVaultIndexProgress(callback)
}

/**
 * Subscribe to vault errors.
 * Returns unsubscribe function.
 */
export function onVaultError(callback: (error: string) => void): () => void {
  return subscribe(events.vaultErrorEvent, (event) => callback(event.message))
}

/**
 * Subscribe to config changes of the open vault. Step 09 (#3526) ports the vault config.
 * Returns unsubscribe function.
 */
export function onVaultConfigChanged(callback: (config: VaultConfig) => void): () => void {
  return window.api.onVaultConfigChanged(callback)
}

/**
 * Subscribe to vault index recovery events.
 * Fired when index database is automatically rebuilt. The Tauri build reports `missing` for a
 * first open and `corrupt` for a repair; the content rebuild (and its counts) is Step 12's.
 * Returns unsubscribe function.
 */
export function onVaultIndexRecovered(callback: (event: IndexRecoveredEvent) => void): () => void {
  return subscribe(events.vaultIndexRecoveredEvent, (event) =>
    callback({
      reason: event.reason === 'missing' ? 'missing' : 'corrupt',
      filesIndexed: 0,
      duration: 0
    })
  )
}
