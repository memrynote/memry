import { createLogger } from '../lib/logger'
import {
  createProjectionRuntime,
  type ProjectionRuntime,
  type ProjectionStopOptions
} from './runtime'
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
    // draining would replay the old vault's backlog into the new vault's index.
    //
    // This narrows the cross-vault window, it does not close it. `stop()` sets
    // `isStopped` and clears each lane's bus, which ends the drain loop at its
    // next iteration — it does not await an event already inside
    // `projector.project()`. That one in-flight event still resolves its handle
    // through the global `getIndexDatabase()`, which now points at the new
    // vault, so it can land one row in the wrong index. Awaiting `stop()` would
    // not help: it does not await in-flight work either. Both the dropped
    // backlog and that stray row are derived state only — the vault files are
    // the source of truth, and `indexVault()` plus the background
    // `reconcileProjections()` rebuild them on the next open of either vault.
    const supersededRuntime = runtime
    runtime = null
    logger.warn('Projection runtime already running; restarting it for the new projectors')
    // `stop({ drain: false })` refuses further publishes synchronously and only
    // then awaits whatever a lane already has in flight; it never rejects, so
    // `void` just marks it intentionally unawaited.
    void supersededRuntime.stop({ drain: false })
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

export async function stopProjectionRuntime(options?: ProjectionStopOptions): Promise<void> {
  if (!runtime) {
    return
  }

  const currentRuntime = runtime
  runtime = null
  await currentRuntime.stop(options)
}

export type { ProjectionEvent, ProjectionLogger, ProjectionProjector } from './types'
export type {
  ProjectionRuntime,
  ProjectionStopOptions,
  ProjectorReconcileFailure
} from './runtime'
export { isReconcileFailure } from './runtime'
