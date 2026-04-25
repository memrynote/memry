/**
 * Renderer-side logger for the Tauri build.
 *
 * Replaces the Electron-era `electron-log/renderer` import. M2 keeps the API
 * surface identical (`createLogger(scope).info/.warn/.error/.debug`) so the
 * 80+ call sites do not need to change. The implementation is a thin wrapper
 * around `console.*` that prefixes each line with `[scope]` and gates
 * `info` / `debug` behind dev mode so production builds stay quiet.
 *
 * Full Rust log forwarding (the `logging_forward` command shape from the
 * design review) is deferred to M8.0 alongside the lifecycle/logging work;
 * doing it earlier would require shipping a logging IPC channel before the
 * crash-handler infrastructure that decides which lines to surface.
 */

const isDev = (() => {
  try {
    return import.meta.env?.DEV === true
  } catch {
    return false
  }
})()

export interface ScopedLogger {
  debug: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

function format(scope: string, level: string): string {
  return `[${scope}] [${level}]`
}

function createLogger(scope: string): ScopedLogger {
  return {
    debug: (...args) => {
      if (!isDev) return
      console.debug(format(scope, 'debug'), ...args)
    },
    info: (...args) => {
      if (!isDev) return
      console.info(format(scope, 'info'), ...args)
    },
    warn: (...args) => {
      console.warn(format(scope, 'warn'), ...args)
    },
    error: (...args) => {
      console.error(format(scope, 'error'), ...args)
    }
  }
}

const log: ScopedLogger = createLogger('app')

export { createLogger, log }
