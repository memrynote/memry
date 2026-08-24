/**
 * Engine-internal logging facade. The project bans raw `console.*` and every
 * shell has its own logger (electron-log on desktop), so extracted modules
 * keep their module-level `const log = createLogger('Scope')` habit and the
 * shell injects the real sink once at startup via
 * `setSyncClientLoggerFactory`. Loggers created before wiring resolve lazily
 * on first call, so import order never matters; calls made while unwired are
 * dropped.
 *
 * The call surface is deliberately looser than the `SyncLogger` seam
 * (`adapters/logger.ts`): desktop call sites pass bare errors and extra
 * positional args the way electron-log accepts them, and this facade must
 * keep those call sites compiling unchanged. Adapters narrow to the seam
 * shape at the injection point.
 */
export interface SyncLog {
  debug(message: string, ...rest: unknown[]): void
  info(message: string, ...rest: unknown[]): void
  warn(message: string, ...rest: unknown[]): void
  error(message: string, ...rest: unknown[]): void
}

export type SyncLoggerFactory = (scope: string) => SyncLog

let factory: SyncLoggerFactory | null = null

export function setSyncClientLoggerFactory(f: SyncLoggerFactory | null): void {
  factory = f
}

export function createLogger(scope: string): SyncLog {
  let real: SyncLog | null = null
  const get = (): SyncLog | null => {
    if (real) return real
    if (factory) real = factory(scope)
    return real
  }
  return {
    debug: (message, ...rest) => {
      get()?.debug(message, ...rest)
    },
    info: (message, ...rest) => {
      get()?.info(message, ...rest)
    },
    warn: (message, ...rest) => {
      get()?.warn(message, ...rest)
    },
    error: (message, ...rest) => {
      get()?.error(message, ...rest)
    }
  }
}
