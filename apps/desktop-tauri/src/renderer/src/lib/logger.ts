// Every record prints to the webview console and, inside the app, goes to Rust (`log_write`),
// which redacts it into main.log and the report buffer. Electron's renderer transport did both.
/* oxlint-disable no-console */

import { commands } from '../../../generated/bindings'

export interface Logger {
  error: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  verbose: (...args: unknown[]) => void
  debug: (...args: unknown[]) => void
  log: (...args: unknown[]) => void
}

type Level = 'error' | 'warn' | 'info' | 'verbose' | 'debug'

/** Only a window with the Tauri bridge can forward; a unit test or a bare page cannot. */
function forward(level: Level, scope: string, args: unknown[]): void {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return
  const text = args
    .map((arg) =>
      arg instanceof Error ? arg.message : typeof arg === 'string' ? arg : safeJson(arg)
    )
    .join(' ')
  void commands.logWrite(level, scope, text, null).catch(() => undefined)
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

// The console is read at call time, so a test that spies on it sees every call.
function createConsoleLogger(scope?: string): Logger {
  const prefix = scope ? [`[${scope}]`] : []
  return {
    error: (...args) => {
      console.error(...prefix, ...args)
      forward('error', scope ?? 'renderer', args)
    },
    warn: (...args) => {
      console.warn(...prefix, ...args)
      forward('warn', scope ?? 'renderer', args)
    },
    info: (...args) => {
      console.info(...prefix, ...args)
      forward('info', scope ?? 'renderer', args)
    },
    verbose: (...args) => {
      console.debug(...prefix, ...args)
      forward('verbose', scope ?? 'renderer', args)
    },
    debug: (...args) => {
      console.debug(...prefix, ...args)
      forward('debug', scope ?? 'renderer', args)
    },
    log: (...args) => console.log(...prefix, ...args)
  }
}

const log = createConsoleLogger()

function createLogger(scope: string): Logger {
  return createConsoleLogger(scope)
}

export { log, createLogger }
