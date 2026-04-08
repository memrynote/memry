import { createLogger } from '../lib/logger'
import { createProjectionRuntime, type ProjectionRuntime } from './runtime'
import type { ProjectionEvent, ProjectionProjector } from './types'

const logger = createLogger('Projections')

let runtime: ProjectionRuntime | null = null

export function startProjectionRuntime(projectors: ProjectionProjector[]): ProjectionRuntime {
  if (runtime) {
    return runtime
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
