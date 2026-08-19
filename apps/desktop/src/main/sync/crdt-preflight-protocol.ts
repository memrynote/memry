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
 * Written immediately BEFORE each store operation — so the LAST one on stderr
 * names the operation that was in flight when the child died, not one that
 * completed. (The two markers above report a step that finished; these cannot,
 * because the thing they exist to attribute is an abort with no unwinding.)
 *
 * Windows installs access-violate here with both markers above already out and
 * nothing to narrow it further: `store` covers opening the store, writing,
 * reading back, clearing and closing, and the fix for each is different. These
 * are the diagnostic that tells them apart.
 */
export const PREFLIGHT_MARK_STORE_OPS = {
  open: '@@memry-preflight:store-open@@',
  write: '@@memry-preflight:store-write@@',
  read: '@@memry-preflight:store-read@@',
  clear: '@@memry-preflight:store-clear@@',
  close: '@@memry-preflight:store-close@@'
} as const

/** The store operations the child performs, in the order it performs them. */
export const PREFLIGHT_STORE_OP_ORDER = ['open', 'write', 'read', 'clear', 'close'] as const

export type CrdtPreflightStoreOp = (typeof PREFLIGHT_STORE_OP_ORDER)[number]

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
 * - `binding-in-use` — a `store` failure that reproduced against a fresh, EMPTY
 *   directory, so the data cannot be the cause. Never derived from the markers
 *   (the child cannot know what a second child found); the provider reclassifies
 *   `store` into it after the control probe. See crdt-persistence.ts.
 */
export type CrdtPreflightStage = 'bootstrap' | 'binding' | 'store' | 'binding-in-use'
