import log from 'electron-log'
import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'

const isDev = process.env.NODE_ENV !== 'production'

log.transports.file.level = isDev ? 'debug' : 'info'
log.transports.file.maxSize = 5 * 1024 * 1024
log.transports.file.format = '{y}-{m}-{d} {h}:{i}:{s}.{ms} [{level}] [{scope}] {text}'

// electron-log names the log directory after the app name, which resolves to
// the package.json name `@memry/desktop` both in the packaged main process
// (productName lives only in electron-builder.yml, never in the asar
// package.json) and in workers (no electron module, so electron-log's node
// fallback reads package.json). That leaks `~/Library/Logs/@memry/desktop`
// onto user machines while the docs promise `memrynote`. Resolve the
// documented directory ourselves — electron-free, because this module is
// bundled into worker entries (see scripts/check-worker-bundles.mjs).
const LOG_DIR_NAME = 'memrynote'

function appLogDir(dirName: string): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Logs', dirName)
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), dirName, 'logs')
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), dirName, 'logs')
}

// Env is read per write, not at import: the main process sets MEMRY_DEVICE
// after this module loads, and dev profiles (A/B/C) must keep per-device
// dirs like the per-device app.name gave them. MEMRY_TEST_LOG_DIR wins —
// E2E launches otherwise share one on-disk log (it lives outside the
// per-test `--user-data-dir`), so a prior run's lines linger and can
// false-green log-scraping assertions.
log.transports.file.resolvePathFn = (variables) => {
  const fileName = variables.fileName ?? 'main.log'
  const testLogDir = process.env.MEMRY_TEST_LOG_DIR
  if (testLogDir) return join(testLogDir, fileName)
  const device = process.env.MEMRY_DEVICE
  return join(appLogDir(device ? `${LOG_DIR_NAME}-${device}` : LOG_DIR_NAME), fileName)
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

// One-time, best-effort move of the pre-rename `@memry/desktop` log dir into
// the `memrynote` one so support diagnostics keep their history. The main
// process calls this once at startup, before workers spawn; a file that can't
// move (e.g. locked on Windows) simply stays behind in the old dir.
function migrateLegacyLogDir(overrides?: { legacyDir?: string; targetDir?: string }): void {
  if (process.env.MEMRY_TEST_LOG_DIR || process.env.MEMRY_DEVICE) return
  try {
    const legacyDir = overrides?.legacyDir ?? appLogDir(join('@memry', 'desktop'))
    const targetDir = overrides?.targetDir ?? appLogDir(LOG_DIR_NAME)
    if (!existsSync(legacyDir)) return
    mkdirSync(targetDir, { recursive: true })
    for (const entry of readdirSync(legacyDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      const from = join(legacyDir, entry.name)
      const to = join(targetDir, entry.name)
      const aside = join(targetDir, `legacy-${entry.name}`)
      try {
        if (!existsSync(to)) renameSync(from, to)
        else if (!existsSync(aside)) renameSync(from, aside)
      } catch {
        // Locked or unmovable; leave it in the legacy dir.
      }
    }
    rmdirSync(legacyDir)
    // macOS nests the scoped name (`Logs/@memry/desktop`); drop the emptied
    // `@memry` parent too. On win/linux the parent is the userData dir — the
    // basename guard keeps rmdir away from it.
    const parent = dirname(legacyDir)
    if (basename(parent) === '@memry') rmdirSync(parent)
  } catch {
    // Best-effort: on any failure the old dir stays where it was.
  }
}

function createLogger(scope: string) {
  return log.scope(scope)
}

export { log, createLogger, disableConsoleTransport, applyPackagedLogLevels, migrateLegacyLogDir }
