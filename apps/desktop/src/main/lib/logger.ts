import log from 'electron-log'
import { join } from 'node:path'

const isDev = process.env.NODE_ENV !== 'production'

log.transports.file.level = isDev ? 'debug' : 'info'
log.transports.file.maxSize = 5 * 1024 * 1024
log.transports.file.format = '{y}-{m}-{d} {h}:{i}:{s}.{ms} [{level}] [{scope}] {text}'

// E2E launches otherwise share one on-disk log on macOS (`~/Library/Logs/{appName}/
// main.log` lives outside the per-test `--user-data-dir`), so a prior run's lines
// linger and can false-green log-scraping assertions. When the E2E launcher points
// MEMRY_TEST_LOG_DIR at the run's fresh dir, write there instead to isolate each run.
const testLogDir = process.env.MEMRY_TEST_LOG_DIR
if (testLogDir) {
  log.transports.file.resolvePathFn = (variables) =>
    join(testLogDir, variables.fileName ?? 'main.log')
}

log.transports.console.level = isDev ? 'debug' : 'warn'
log.transports.console.format = '{h}:{i}:{s}.{ms} [{level}] [{scope}] {text}'

log.errorHandler.startCatching({
  showDialog: false,
  onError({ error }) {
    // Benign, contained: electron's net.fetch throws this RangeError from inside
    // its own response event when a server returns an HTTP status outside 200-599
    // (e.g. LinkedIn's 999, or 0 on an opaque redirect). It can't be caught at the
    // call site; the fetch fails and callers degrade gracefully. Returning false
    // tells electron-log to skip it. See chromiumFetch in main/inbox/metadata.ts.
    if (error?.message?.includes('must be in the range of 200 to 599')) {
      return false
    }
    if (error?.message?.includes('EIO')) {
      log.transports.console.level = false
    }
    return undefined
  }
})

function disableConsoleTransport(): void {
  log.transports.console.level = false
}

// NODE_ENV is undefined at runtime in packaged Electron, so the isDev default
// above wrongly stays verbose there. This module cannot import electron itself
// (it is bundled into worker_threads entries — see scripts/check-worker-bundles.mjs),
// so the main process calls this once at startup when app.isPackaged.
function applyPackagedLogLevels(): void {
  log.transports.file.level = 'info'
  log.transports.console.level = 'warn'
}

function createLogger(scope: string) {
  return log.scope(scope)
}

export { log, createLogger, disableConsoleTransport, applyPackagedLogLevels }
