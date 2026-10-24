import { useSyncExternalStore } from 'react'

/**
 * Whether the install-failure dialog has been dismissed for this session. Shared
 * rather than local because two places drive it: the dialog itself dismisses, and
 * the sidebar's "Details" brings it back. `UpdateInstallFailedDialog` is mounted
 * twice (the no-vault and vault-open branches of `App`), so a module-level store
 * also keeps those two mounts from disagreeing.
 */
let dismissed = false
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function dismissInstallFailed(): void {
  if (dismissed) return
  dismissed = true
  emit()
}

export function reopenInstallFailed(): void {
  if (!dismissed) return
  dismissed = false
  emit()
}

export function useInstallFailedDismissed(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => dismissed
  )
}

/** Test-only: the store outlives a single render tree. */
export function resetInstallFailedDismissal(): void {
  dismissed = false
  emit()
}
