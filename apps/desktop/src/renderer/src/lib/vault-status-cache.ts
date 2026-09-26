/**
 * Last vault status and vault list the renderer has seen
 *
 * Every `useVault` / `useVaultList` instance used to start empty and wait for
 * its own IPC round trip. A vault workspace mounts in the same commit that
 * reveals it, so its first frame drew the sidebar with no open vault: no pager,
 * no title, the plain switcher in the footer, then everything popped in a frame
 * later. That flash sat on every switch into a vault not yet kept mounted.
 *
 * App's own `useVault` is never hidden, so it keeps this current; instances
 * that mount later seed from it and still refetch. Module-level and free of
 * imports so the test setup can reset it without loading the hooks.
 */

import type { VaultInfo, VaultStatus } from '../../../preload/index.d'

let status: VaultStatus | null = null
let vaultList: { vaults: VaultInfo[]; currentVault: string | null } | null = null

export function getCachedVaultStatus(): VaultStatus | null {
  return status
}

export function setCachedVaultStatus(next: VaultStatus): void {
  status = next
}

export function getCachedVaultList(): { vaults: VaultInfo[]; currentVault: string | null } | null {
  return vaultList
}

export function setCachedVaultList(next: {
  vaults: VaultInfo[]
  currentVault: string | null
}): void {
  vaultList = next
}

/** Test-only reset. */
export function resetVaultStatusCache(): void {
  status = null
  vaultList = null
}
