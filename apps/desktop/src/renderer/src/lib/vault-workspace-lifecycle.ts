/**
 * Lifecycle of a kept vault workspace
 *
 * VaultStack keeps recently visited vaults mounted inside a hidden <Activity>.
 * Hiding runs every effect cleanup in the workspace, exactly like an unmount,
 * but the components live on and their effects run again when the workspace is
 * shown. Cleanups that dispose something for good (an editor instance) cannot
 * tell the two apart on their own, so they ask here: while the workspace is
 * hidden, disposal is parked until the workspace is really dropped.
 */

import { createContext, useContext } from 'react'

export interface VaultWorkspaceLifecycle {
  /** True while the workspace is kept mounted but not shown. */
  hidden: boolean
  /** Parked disposals, run when the workspace is evicted or the stack unmounts. */
  disposers: Set<() => void>
}

export function createVaultWorkspaceLifecycle(): VaultWorkspaceLifecycle {
  return { hidden: false, disposers: new Set() }
}

export function disposeVaultWorkspace(lifecycle: VaultWorkspaceLifecycle): void {
  const disposers = [...lifecycle.disposers]
  lifecycle.disposers.clear()
  for (const dispose of disposers) dispose()
}

export const VaultWorkspaceLifecycleContext = createContext<VaultWorkspaceLifecycle | null>(null)

/** Null outside a kept workspace: cleanups then dispose immediately, as before. */
export function useVaultWorkspaceLifecycle(): VaultWorkspaceLifecycle | null {
  return useContext(VaultWorkspaceLifecycleContext)
}

// =============================================================================
// Leaving a vault
// =============================================================================

/**
 * Work that must reach the vault before it closes, e.g. an editor's debounced
 * markdown save. A hidden workspace's cleanups run after the next vault is
 * already open, so anything they wrote would land in the wrong vault; the
 * switch runs these first instead.
 */
const leaveFlushes = new Set<() => void | Promise<void>>()

export function registerVaultLeaveFlush(flush: () => void | Promise<void>): () => void {
  leaveFlushes.add(flush)
  return () => {
    leaveFlushes.delete(flush)
  }
}

export async function runVaultLeaveFlushes(): Promise<void> {
  await Promise.allSettled([...leaveFlushes].map((flush) => Promise.resolve().then(flush)))
}
