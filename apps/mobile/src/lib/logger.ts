import type { SyncLogger } from '@memry/sync-client/adapters'

/**
 * Mobile logger behind the sync-client logging seam. RN has no electron-log;
 * console is the platform sink (visible in Metro/Xcode, captured by release
 * crash tooling later). Scope-prefixed like desktop's createLogger('Scope').
 * Never pass key material or note content in `context` — callers are the gate.
 */
export function createLogger(scope: string): SyncLogger {
  const prefix = `[${scope}]`
  return {
    debug(message, context) {
      if (__DEV__) console.debug(prefix, message, context ?? '')
    },
    info(message, context) {
      console.info(prefix, message, context ?? '')
    },
    warn(message, context) {
      console.warn(prefix, message, context ?? '')
    },
    error(message, context) {
      console.error(prefix, message, context ?? '')
    }
  }
}
