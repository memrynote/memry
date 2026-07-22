/**
 * Wire protocol between the CRDT preflight parent and its disposable child.
 *
 * The child reports progress by writing marker lines to stderr — the only
 * channel that exists in BOTH transports the parent uses (an Electron
 * utilityProcess fork and a plain `ELECTRON_RUN_AS_NODE` spawn), and one that
 * survives a hard native abort mid-probe because it is unbuffered.
 *
 * Keep this file import-free: it is bundled into the standalone preflight
 * child, which must not reach `electron` or any project module graph.
 */

/** Written before anything heavier than node builtins is touched. */
export const PREFLIGHT_MARK_STARTED = '@@memry-preflight:started@@'

/** Written once the classic-level native binding has loaded. */
export const PREFLIGHT_MARK_BINDING_LOADED = '@@memry-preflight:binding-loaded@@'

/**
 * How far the child got before it died — the parent reads this off the markers
 * and it decides whether the store is a suspect at all:
 *
 * - `bootstrap` — the child never reached JS. Its runtime failed to start
 *   (observed on Windows: exit `0xFFFF7003` during Chromium/crashpad init).
 *   Says nothing about the binding or the store.
 * - `binding` — the child ran, the native binding failed to load. The store
 *   was never opened, so it cannot be at fault.
 * - `store` — the binding loaded and the probe died using it. Either the
 *   on-disk state or the binding-in-use is bad; only this stage is worth
 *   quarantining for.
 */
export type CrdtPreflightStage = 'bootstrap' | 'binding' | 'store'
