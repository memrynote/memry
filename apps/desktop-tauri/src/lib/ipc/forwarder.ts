import { invoke } from './invoke'
import { listen } from './events'
import type { UnlistenFn } from '@tauri-apps/api/event'

/**
 * Convert camelCase to snake_case. `listByFolder` → `list_by_folder`.
 */
export function camelToSnake(input: string): string {
  return input.replace(/[A-Z]/g, (ch, idx) => (idx === 0 ? '' : '_') + ch.toLowerCase())
}

/**
 * Convert snake_case to camelCase. `list_by_folder` → `listByFolder`.
 */
export function snakeToCamel(input: string): string {
  return input.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
}

/**
 * Build the Tauri command name for a domain + method call.
 * `buildCommandName('notes', 'listByFolder')` → `notes_list_by_folder`.
 */
export function buildCommandName(domain: string, method: string): string {
  return `${domain}_${camelToSnake(method)}`
}

/**
 * Pack positional arguments for invoke(). Tauri expects a `Record<string,
 * unknown>` (or nothing) as the second param. We wrap positional args in an
 * object so mocks / real handlers can recover them — `{ args: [...] }` for
 * multi-arg calls, passed through verbatim for single-arg calls that already
 * look like an object, and `{ args: [value] }` for a bare scalar.
 */
export function packArgs(args: unknown[]): Record<string, unknown> | undefined {
  if (args.length === 0) return undefined
  if (args.length === 1) {
    const only = args[0]
    if (only && typeof only === 'object' && !Array.isArray(only)) {
      return only as Record<string, unknown>
    }
    return { args: [only] }
  }
  return { args }
}

/**
 * Builds a typed forwarder for a domain that dispatches every method call
 * through `invoke('<domain>_<method>', packedArgs)`. Replaces the old
 * Electron-era `createWindowApiForwarder(() => window.api.X)` pattern.
 */
export function createInvokeForwarder<T extends object>(domain: string): T {
  return new Proxy({} as T, {
    get(_target, property) {
      if (typeof property !== 'string') return undefined
      return (...args: unknown[]) => invoke(buildCommandName(domain, property), packArgs(args))
    }
  })
}

/**
 * Subscribe to a Tauri event and return a synchronous `() => void` unsubscribe
 * function. Wraps `listen`'s Promise so call sites that expect the old
 * Electron-era `window.api.onFoo(cb): () => void` signature keep working.
 *
 * If the caller unsubscribes before `listen` resolves, the returned function
 * flips a cancel flag so we detach as soon as the listener is actually
 * registered.
 */
export function subscribeEvent<T>(eventName: string, callback: (payload: T) => void): () => void {
  let unlisten: UnlistenFn | null = null
  let cancelled = false

  void listen<T>(eventName, callback).then((detach) => {
    if (cancelled) {
      detach()
      return
    }
    unlisten = detach
  })

  return () => {
    cancelled = true
    if (unlisten) {
      unlisten()
      unlisten = null
    }
  }
}
