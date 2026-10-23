import type { RuntimeAdapter, SyncLogger } from '@memry/sync-client/adapters'
import { createLogger } from '../../lib/logger'

/**
 * Desktop implementation of seam 10.
 *
 * Version and lifecycle hooks are electron-bound (app.getVersion, powerMonitor
 * resume/suspend) and injected via `wiring.ts`; the logger is desktop's real
 * electron-log scope, which is node-safe by design (it is bundled into worker
 * entries). `scheduleBackgroundSync` is deliberately absent — that member is
 * iOS's BGAppRefreshTask.
 */
export interface DesktopRuntimeDeps {
  appVersion(): string
  onForeground(cb: () => void): () => void
  onBackground(cb: () => void): () => void
}

export class DesktopRuntime implements RuntimeAdapter {
  readonly log: SyncLogger

  constructor(private readonly deps: DesktopRuntimeDeps) {
    const scoped = createLogger('SyncRuntimeAdapter')
    this.log = {
      debug: (message, context) => scoped.debug(message, context),
      info: (message, context) => scoped.info(message, context),
      warn: (message, context) => scoped.warn(message, context),
      error: (message, context) => scoped.error(message, context)
    }
  }

  appVersion(): string {
    return this.deps.appVersion()
  }

  platform(): 'desktop' {
    return 'desktop'
  }

  onForeground(cb: () => void): () => void {
    return this.deps.onForeground(cb)
  }

  onBackground(cb: () => void): () => void {
    return this.deps.onBackground(cb)
  }
}
