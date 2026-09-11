/**
 * Vault switcher open requests
 *
 * The vault switcher lives in the sidebar footer and owns its own popover
 * state. The ⌘⇧O shortcut is registered app-wide in `App.tsx`, far from that
 * component, so this module carries the request between them instead of
 * duplicating vault-selection logic in a second surface.
 *
 * Module-level (not React context) for the same reason `lib/shortcut-bindings.ts`
 * is: both ends mount in different trees, and tests can drive it directly.
 */

import { useEffect, useRef } from 'react'

type Listener = () => void

const listeners = new Set<Listener>()

/** Ask the mounted vault switcher to open and take focus. */
export function requestVaultSwitcherOpen(): void {
  for (const listener of [...listeners]) listener()
}

/** Subscribe the vault switcher to open requests. */
export function useVaultSwitcherOpenRequest(onRequest: () => void): void {
  const handlerRef = useRef(onRequest)

  useEffect(() => {
    handlerRef.current = onRequest
  }, [onRequest])

  useEffect(() => {
    const listener = (): void => handlerRef.current()
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [])
}
