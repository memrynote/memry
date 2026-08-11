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
  /** Set when the cap dropped events; owed repair, paid once the lane empties. */
  needsReconcile: boolean
}

export function createProjectionRuntime(options: ProjectionRuntimeOptions): ProjectionRuntime {
  const logger = options.logger
  const scheduleDrain = options.scheduleDrain ?? ((task: () => void) => queueMicrotask(task))
  const queueLimit = options.queueLimit ?? DEFAULT_PROJECTION_QUEUE_LIMIT

  let isStopped = false

  // A reconcile pass runs backgrounded (vault open fires it and does not await
  // it), so stop() has to be able to cut it short: without this, switching
  // vaults left the previous runtime's pass reading the old vault path against
  // a database that closeVault had already closed (#993).
  let reconcileAbort: AbortController | null = null
  let activeReconcile: Promise<unknown> | null = null

  const lanes: ProjectorLane[] = options.projectors.map((projector) => ({
    projector,
    bus: new ProjectionBus(queueLimit),
    isScheduled: false,
    activeDrain: null,
    needsReconcile: false
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

  /**
   * Pay off the repair the queue cap owes. Dropping the oldest events keeps the
   * lane bounded, but it also means this projector's output is now missing
   * whatever they carried, and nothing else calls reconcile() on this path — so
   * overflow costs a deferred full repair instead of a silently wrong
   * projection (#992).
   *
   * The flag is cleared before reconcile() runs so any event reconcile itself
   * publishes cannot re-trigger the repair in a loop; only a *new* overflow
   * sets it again. On failure the flag is restored, so the next drain pass
   * retries rather than leaving the loss unrepaired forever.
   */
  const repairLane = async (lane: ProjectorLane): Promise<void> => {
    lane.needsReconcile = false

    try {
      await lane.projector.reconcile()
    } catch (error) {
      lane.needsReconcile = true
      logger?.warn?.('Projection overflow repair failed', {
        projector: lane.projector.name,
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

        const dropped = lane.bus.takeDroppedCount()
        if (dropped > 0) {
          lane.needsReconcile = true
          logger?.warn?.('Projection queue overflow — dropped pending events', {
            projector: lane.projector.name,
            dropped,
            limit: queueLimit
          })
        }

        if (!isStopped && lane.needsReconcile) {
          await repairLane(lane)
        }
      } finally {
        lane.isScheduled = false
        lane.activeDrain = null

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
      //
      // This skip assumes handles() is a pure function of event.type — every
      // projector's is. runEvent() re-checks at drain time, so a stateful
      // handles() would still never project an event it rejects; it would only
      // lose the ones it would have accepted later.
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
      const controller = new AbortController()
      const run = (async () => {
        const results: Record<string, unknown> = {}

        for (const projector of selectProjectors(options.projectors, names)) {
          if (controller.signal.aborted) {
            break
          }

          results[projector.name] = await projector.reconcile(controller.signal)
        }

        return results
      })()

      reconcileAbort = controller
      activeReconcile = run

      try {
        return await run
      } finally {
        if (reconcileAbort === controller) {
          reconcileAbort = null
        }
        if (activeReconcile === run) {
          activeReconcile = null
        }
      }
    },

    async stop(stopOptions) {
      reconcileAbort?.abort()
      const pendingReconcile = activeReconcile

      const shouldDrain = stopOptions?.drain ?? true
      if (shouldDrain) {
        await drain()
      }

      isStopped = true
      for (const lane of lanes) {
        lane.isScheduled = false
        lane.bus.clear()
      }

      // Wait for the aborted pass to unwind before returning: the caller closes
      // the databases right after this resolves.
      if (pendingReconcile) {
        await pendingReconcile.catch(() => {})
      }
    },

    getPendingCount() {
      return lanes.reduce((total, lane) => total + lane.bus.size, 0)
    }
  }
}
