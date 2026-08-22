import type { DevicePlatform } from './device-registration.ts'
import type { SyncLogger } from './logger.ts'

/**
 * Seam 10 — app lifecycle and identity. Replaces the electron surface of
 * desktop's `runtime.ts` (`app.getVersion()`, paths, lifecycle events).
 */
export interface RuntimeAdapter {
  appVersion(): string
  platform(): DevicePlatform
  /** Triggers a foreground sync. Returns its own unsubscribe. */
  onForeground(cb: () => void): () => void
  /** Flush the outbox and persist state. Returns its own unsubscribe. */
  onBackground(cb: () => void): () => void
  /** BGAppRefreshTask on iOS; deliberately absent on desktop. */
  scheduleBackgroundSync?(minIntervalSec: number): void
  log: SyncLogger
}
