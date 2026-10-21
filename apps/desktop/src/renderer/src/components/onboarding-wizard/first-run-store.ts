import { useSyncExternalStore } from 'react'

/**
 * Whether the first-run wizard owns the window. It outlives the vault opening
 * so the wizard can write the user's choices into the new vault before the app
 * mounts, instead of being torn down the moment `isVaultOpen` flips.
 */
let active = false
const listeners = new Set<() => void>()

function set(next: boolean): void {
  if (active === next) return
  active = next
  for (const listener of listeners) listener()
}

export const startFirstRunWizard = (): void => set(true)
export const finishFirstRunWizard = (): void => set(false)

export function useFirstRunWizardActive(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => active
  )
}
