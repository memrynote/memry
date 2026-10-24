// Step 09 (#3526) owns forwarding renderer logs to Rust; until then they stay in the webview
// console, which is also where Electron's renderer transport printed them.
/* oxlint-disable no-console */

export interface Logger {
  error: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  verbose: (...args: unknown[]) => void
  debug: (...args: unknown[]) => void
  log: (...args: unknown[]) => void
}

// The console is read at call time, so a test that spies on it sees every call.
function createConsoleLogger(scope?: string): Logger {
  const prefix = scope ? [`[${scope}]`] : []
  return {
    error: (...args) => console.error(...prefix, ...args),
    warn: (...args) => console.warn(...prefix, ...args),
    info: (...args) => console.info(...prefix, ...args),
    verbose: (...args) => console.debug(...prefix, ...args),
    debug: (...args) => console.debug(...prefix, ...args),
    log: (...args) => console.log(...prefix, ...args)
  }
}

const log = createConsoleLogger()

function createLogger(scope: string): Logger {
  return createConsoleLogger(scope)
}

export { log, createLogger }
