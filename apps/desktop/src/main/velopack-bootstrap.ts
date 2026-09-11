import { app } from 'electron'
import { createLogger } from './lib/logger'
import { loadVelopack } from './velopack-native'

const logger = createLogger('VelopackBootstrap')
const libraryLogger = createLogger('Velopack')

/**
 * First thing the main process runs on Windows: Velopack's `--veloapp-*` hook
 * arguments are handled here, and the process may exit inside run(). No-op in dev, on
 * other platforms, and on an NSIS install (run() returns without doing anything there).
 * Never throws — a broken bootstrap must not cost the user their app.
 */
export function runVelopackBootstrap(): void {
  if (process.platform !== 'win32' || !app.isPackaged) {
    return
  }
  try {
    loadVelopack()
      .VelopackApp.build()
      .setLogger((level, message) => {
        libraryLogger[level === 'trace' ? 'debug' : level](message)
      })
      .run()
  } catch (error) {
    logger.warn('velopack bootstrap failed; continuing without it', error)
  }
}

runVelopackBootstrap()
