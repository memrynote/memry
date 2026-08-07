import { DEFAULT_PROJECTION_QUEUE_LIMIT, ProjectionBus } from './bus'
import type { ProjectionEvent, ProjectionLogger, ProjectionProjector } from './types'

interface ProjectionRuntimeOptions {
  projectors: ProjectionProjector[]
  logger?: ProjectionLogger
  scheduleDrain?: (task: () => void) => void
  /** Per-lane pending-event cap. See DEFAULT_PROJECTION_QUEUE_LIMIT. */
  queueLimit?: number
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

/**
 * One independent queue per projector.
 *
 * Projectors used to share a single queue that awaited each of them in turn, so
 * one slow projector blocked every other projector's writes head-of-line. The
 * embedding projector awaits a multi-second model load inside project(), which
 * left note_cache holding a renamed note's old path for seconds — long enough
 * for every read of that note to resolve a file that no longer exists and come
 * back null, i.e. a live note looking deleted to the renderer (#877).
 *
 * Each lane still drains its own events in publish order; only the ordering
 * *between* projectors is relaxed, and no projector reads another's output
 * during project() (they all work from the event payload).
 */
interface ProjectorLane {
  projector: ProjectionProjector
  bus: ProjectionBus
  isScheduled: boolean
  activeDrain: Promise<void> | null
}

export function createProjectionRuntime(options: ProjectionRuntimeOptions): ProjectionRuntime {
  const logger = options.logger
  const scheduleDrain = options.scheduleDrain ?? ((task: () => void) => queueMicrotask(task))
  const queueLimit = options.queueLimit ?? DEFAULT_PROJECTION_QUEUE_LIMIT

  let isStopped = false

  const lanes: ProjectorLane[] = options.projectors.map((projector) => ({
    projector,
    bus: new ProjectionBus(queueLimit),
    isScheduled: false,
    activeDrain: null
  }))

  const runEvent = async (lane: ProjectorLane, event: ProjectionEvent): Promise<void> => {
    if (!lane.projector.handles(event)) {
      return
    }

    try {
      await lane.projector.project(event)
    } catch (error) {
      logger?.error?.('Projection projector failed', {
        projector: lane.projector.name,
        event,
        error
      })
    }
  }

  const drainLane = (lane: ProjectorLane): Promise<void> => {
    if (lane.activeDrain) {
      return lane.activeDrain
    }

    // The handle is created and stored before the loop starts: an already-empty
    // lane finishes its body synchronously, and assigning the promise afterwards
    // would overwrite the null the `finally` already wrote, leaving the lane
    // permanently "draining" (and drain()'s wait loop spinning).
    let settle: () => void = () => {}
    const handle = new Promise<void>((resolve) => {
      settle = resolve
    })
    lane.activeDrain = handle

    void (async () => {
      try {
        while (!isStopped && lane.bus.size > 0) {
          const event = lane.bus.dequeue()
          if (!event) {
            break
          }

          await runEvent(lane, event)
        }
      } finally {
        lane.isScheduled = false
        lane.activeDrain = null

        const dropped = lane.bus.takeDroppedCount()
        if (dropped > 0) {
          logger?.warn?.('Projection queue overflow — dropped pending events', {
            projector: lane.projector.name,
            dropped,
            limit: queueLimit
          })
        }

        settle()

        if (!isStopped && lane.bus.size > 0) {
          schedule(lane)
        }
      }
    })()

    return handle
  }

  const drain = async (): Promise<void> => {
    // Lanes advance independently, so a lane can still be busy (or have been
    // refilled) when a faster one settles. Loop until every lane is idle — or
    // until the runtime stops, since a stopped lane never drains its backlog.
    while (!isStopped && lanes.some((lane) => lane.bus.size > 0 || lane.activeDrain !== null)) {
      await Promise.all(lanes.map((lane) => drainLane(lane)))
    }
  }

  const schedule = (lane: ProjectorLane): void => {
    if (isStopped || lane.isScheduled) {
      return
    }

    lane.isScheduled = true
    scheduleDrain(() => {
      void drainLane(lane)
    })
  }

  return {
    publish(event) {
      if (isStopped) {
        logger?.warn?.('Projection event published after runtime stop', { event })
        return
      }

      // Route at enqueue time. Fanning every event into every lane meant a note
      // body sat in the inbox lane (and an inbox event in the note lanes) until
      // the slowest lane finally dequeued and discarded it (#992).
      for (const lane of lanes) {
        if (!lane.projector.handles(event)) {
          continue
        }

        lane.bus.enqueue(event)
        schedule(lane)
      }
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
      for (const lane of lanes) {
        lane.isScheduled = false
        lane.bus.clear()
      }
    },

    getPendingCount() {
      return lanes.reduce((total, lane) => total + lane.bus.size, 0)
    }
  }
}
