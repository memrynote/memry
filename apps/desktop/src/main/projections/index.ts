import { createLogger } from '../lib/logger'
import { createProjectionRuntime, type ProjectionRuntime } from './runtime'
import type { ProjectionEvent, ProjectionProjector } from './types'

const logger = createLogger('Projections')

let runtime: ProjectionRuntime | null = null

export function startProjectionRuntime(projectors: ProjectionProjector[]): ProjectionRuntime {
  if (runtime) {
    // A live runtime here means the previous vault never closed cleanly: a
    // failed open leaves `isOpen` false, so the next `selectVault` skips
    // `closeVault()` — and its drained `stopProjectionRuntime` — while the old
    // runtime is still running. Returning it dropped the caller's projectors,
    // leaving the new vault indexed and embedded through projectors closed over
    // the PREVIOUS vault path (#1024).
    //
    // Stopped without draining on purpose: the queued events belong to the
    // previous vault, and by now the new vault's databases are installed, so
    // replaying them would write the old vault's derived state into the new
    // vault's index. Dropping them costs nothing permanent — derived state is
    // rebuilt from the vault files, so reopening that vault re-indexes and
    // reconciles it back.
    const supersededRuntime = runtime
    runtime = null
    logger.warn('Projection runtime already running; restarting it for the new projectors')
    void supersededRuntime.stop({ drain: false }).catch((error) => {
      logger.error('Failed to stop superseded projection runtime', error)
    })
  }

  runtime = createProjectionRuntime({
    projectors,
    logger
  })

  return runtime
}

export function getProjectionRuntime(): ProjectionRuntime | null {
  return runtime
}

export function publishProjectionEvent(event: ProjectionEvent): void {
  runtime?.publish(event)
}

export async function flushProjectionEvents(): Promise<void> {
  await runtime?.flush()
}

export async function rebuildProjections(names?: string[]): Promise<Record<string, unknown>> {
  return (await runtime?.rebuild(names)) ?? {}
}

export async function reconcileProjections(names?: string[]): Promise<Record<string, unknown>> {
  return (await runtime?.reconcile(names)) ?? {}
}

export async function stopProjectionRuntime(options?: { drain?: boolean }): Promise<void> {
  if (!runtime) {
    return
  }

  const currentRuntime = runtime
  runtime = null
  await currentRuntime.stop(options)
}

export type { ProjectionEvent, ProjectionLogger, ProjectionProjector } from './types'
export type { ProjectionRuntime } from './runtime'
