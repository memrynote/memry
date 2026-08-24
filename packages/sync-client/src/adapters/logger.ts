/**
 * The logging seam. Every shell has its own logger (`electron-log` on desktop,
 * something else on mobile) and the project bans raw `console.*`, so the engine
 * takes a logger rather than reaching for one.
 */
export interface SyncLogger {
  debug(message: string, context?: Record<string, unknown>): void
  info(message: string, context?: Record<string, unknown>): void
  warn(message: string, context?: Record<string, unknown>): void
  error(message: string, context?: Record<string, unknown>): void
}
