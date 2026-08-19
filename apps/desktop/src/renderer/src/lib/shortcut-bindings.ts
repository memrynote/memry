/**
 * Runtime shortcut bindings
 *
 * Settings → Shortcuts writes rebinds into `keyboard.overrides`. This store is
 * the other half of that contract: every runtime shortcut owner resolves its
 * chord through `useShortcutBinding(id)`, so a rebind takes effect immediately
 * and the settings screen can never advertise a shortcut it cannot deliver.
 *
 * Module-level (not React context) so `components/ui/sidebar.tsx` and the tab
 * hooks can read it wherever they are mounted, and so tests without a settings
 * IPC bridge simply fall back to registry defaults.
 */

import { useSyncExternalStore } from 'react'
import type { ShortcutBinding } from '@memry/contracts/settings-schemas'
import { SHORTCUT_REGISTRY, type ShortcutId } from './shortcut-registry'

const DEFAULT_BINDINGS = new Map<string, ShortcutBinding>(
  SHORTCUT_REGISTRY.map((entry) => [entry.id, entry.defaultBinding])
)

/** A chord no keystroke can match — used if an id ever leaves the registry. */
const NEVER_MATCHES: ShortcutBinding = { key: '', modifiers: {} }

let overrides: Record<string, ShortcutBinding> = {}
/** Cached per id so `useSyncExternalStore` sees a stable snapshot. */
let resolved = new Map<string, ShortcutBinding>()
const listeners = new Set<() => void>()
let started = false

function setOverrides(next: Record<string, ShortcutBinding>): void {
  overrides = next
  resolved = new Map()
  for (const listener of listeners) listener()
}

function start(): void {
  if (started) return
  started = true

  const api = typeof window !== 'undefined' ? window.api : undefined
  if (!api) return

  const getKeyboardSettings = api.settings?.getKeyboardSettings
  if (typeof getKeyboardSettings === 'function') {
    void Promise.resolve(getKeyboardSettings.call(api.settings))
      .then((settings) => setOverrides(settings.overrides ?? {}))
      .catch(() => {
        // Settings unavailable — registry defaults stay in effect.
      })
  }

  api.onSettingsChanged?.((event) => {
    if (event.key !== 'keyboard') return
    const value = event.value as { overrides?: Record<string, ShortcutBinding> } | undefined
    if (value && 'overrides' in value) setOverrides(value.overrides ?? {})
  })
}

function subscribe(listener: () => void): () => void {
  start()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Effective binding for a shortcut: the user's override, else the default.
 */
export function getShortcutBinding(id: ShortcutId): ShortcutBinding {
  const cached = resolved.get(id)
  if (cached) return cached
  const binding = overrides[id] ?? DEFAULT_BINDINGS.get(id) ?? NEVER_MATCHES
  resolved.set(id, binding)
  return binding
}

/**
 * Subscribe to the effective binding for a shortcut. Re-renders the caller when
 * the user rebinds it in settings.
 */
export function useShortcutBinding(id: ShortcutId): ShortcutBinding {
  return useSyncExternalStore(
    subscribe,
    () => getShortcutBinding(id),
    () => getShortcutBinding(id)
  )
}

/** Test seam: apply overrides without an IPC round trip. */
export function __setShortcutOverridesForTests(next: Record<string, ShortcutBinding> = {}): void {
  started = true
  setOverrides(next)
}
