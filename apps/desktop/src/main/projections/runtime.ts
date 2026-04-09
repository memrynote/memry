import { ProjectionBus } from './bus'
import type { ProjectionEvent, ProjectionLogger, ProjectionProjector } from './types'

interface ProjectionRuntimeOptions {
  projectors: ProjectionProjector[]
  logger?: ProjectionLogger
  scheduleDrain?: (task: () => void) => void
}

export interface ProjectionRuntime {
  publish(event: ProjectionEvent): void
  flush(): Promise<void>
  rebuild(names?: string[]): Promise<Record<string, unknown>>
  reconcile(names?: string[]): Promise<Record<string, unknown>>
  stop(options?: { drain?: boolean }): Promise<void>
  getPendingCount(): number
}

function selectProjectors(
  projectors: ProjectionProjector[],
  names?: string[]
): ProjectionProjector[] {
  if (!names || names.length === 0) {
    return projectors
  }

  const wanted = new Set(names)
  return projectors.filter((projector) => wanted.has(projector.name))
}

export function createProjectionRuntime(options: ProjectionRuntimeOptions): ProjectionRuntime {
  const bus = new ProjectionBus()
  const logger = options.logger
  const scheduleDrain = options.scheduleDrain ?? ((task: () => void) => queueMicrotask(task))

  let isStopped = false
  let isScheduled = false
  let activeDrain: Promise<void> | null = null

  const runEvent = async (event: ProjectionEvent): Promise<void> => {
    for (const projector of options.projectors) {
      if (!projector.handles(event)) {
        continue
      }

      try {
        await projector.project(event)
      } catch (error) {
        logger?.error?.('Projection projector failed', {
          projector: projector.name,
          event,
          error
        })
      }
    }
  }

  const drain = async (): Promise<void> => {
    if (activeDrain) {
      return activeDrain
    }

    activeDrain = (async () => {
      try {
        while (!isStopped && bus.size > 0) {
          const event = bus.dequeue()
          if (!event) {
            break
          }

          await runEvent(event)
        }
      } finally {
        isScheduled = false
        activeDrain = null

        if (!isStopped && bus.size > 0) {
          schedule()
        }
      }
    })()

    return activeDrain
  }

  const schedule = (): void => {
    if (isStopped || isScheduled) {
      return
    }

    isScheduled = true
    scheduleDrain(() => {
      void drain()
    })
  }

  return {
    publish(event) {
      if (isStopped) {
        logger?.warn?.('Projection event published after runtime stop', { event })
        return
      }

      bus.enqueue(event)
      schedule()
    },

    async flush() {
      await drain()
    },

    async rebuild(names) {
      const results: Record<string, unknown> = {}

      for (const projector of selectProjectors(options.projectors, names)) {
        results[projector.name] = await projector.rebuild()
      }

      return results
    },

    async reconcile(names) {
      const results: Record<string, unknown> = {}

      for (const projector of selectProjectors(options.projectors, names)) {
        results[projector.name] = await projector.reconcile()
      }

      return results
    },

    async stop(stopOptions) {
      const shouldDrain = stopOptions?.drain ?? true
      if (shouldDrain) {
        await drain()
      }

      isStopped = true
      isScheduled = false
      bus.clear()
    },

    getPendingCount() {
      return bus.size
    }
  }
}
