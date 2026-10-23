import { DEFAULT_PROJECTION_QUEUE_LIMIT, ProjectionBus } from './bus'
import type { ProjectionEvent, ProjectionLogger, ProjectionProjector } from './types'

interface ProjectionRuntimeOptions {
  projectors: ProjectionProjector[]
  logger?: ProjectionLogger
  scheduleDrain?: (task: () => void) => void
  /** Per-lane pending-event cap. See DEFAULT_PROJECTION_QUEUE_LIMIT. */
  queueLimit?: number
}

export interface ProjectionStopOptions {
  drain?: boolean
  /** Cap on the stop drain. See DEFAULT_STOP_DRAIN_TIMEOUT_MS. */
  drainTimeoutMs?: number
}

export interface ProjectionRuntime {
  publish(event: ProjectionEvent): void
  flush(): Promise<void>
  rebuild(names?: string[]): Promise<Record<string, unknown>>
  reconcile(names?: string[]): Promise<Record<string, unknown>>
  stop(options?: ProjectionStopOptions): Promise<void>
  getPendingCount(): number
}

/**
 * How long `stop({ drain: true })` will wait for the backlog before cutting the
 * drain short (#1078).
 *
 * `closeVault()` awaits this, so an unbounded drain makes a vault switch hang
 * behind whatever the slowest lane is doing — the embedding lane's model load
 * and per-note inference can hold it for minutes. The deadline only stops
 * *dequeuing*: the event already inside project() is still awaited, so the
 * databases are never closed underneath a running projector. What the deadline
 * leaves queued is derived state, and the next open re-derives it (indexVault
 * plus the backgrounded reconcileProjections).
 */
export const DEFAULT_STOP_DRAIN_TIMEOUT_MS = 5_000

/**
 * What a reconcile pass records for a projector whose own pass threw.
 *
 * The loop used to have no guard, so the first projector to throw abandoned
 * every projector behind it. On an install whose search index was corrupt that
 * meant embeddings, inbox counts and note↔project links silently stopped
 * self-repairing too — on every launch, forever (#1585).
 *
 * The failure is recorded rather than swallowed: `openVault` reads it to tell a
 * corrupt FTS index apart from any other reconcile failure and repair it.
 */
export interface ProjectorReconcileFailure {
  readonly reconcileFailed: true
  readonly projector: string
  readonly error: unknown
}

export function isReconcileFailure(value: unknown): value is ProjectorReconcileFailure {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Partial<ProjectorReconcileFailure>).reconcileFailed === true
  )
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
  // Set at the top of stop(), before the stop drain. publish() used to keep
  // accepting events for the whole drain, so anything still emitting — a sync
  // write-back, a watcher event that beat stopWatcher() — refilled a lane as
  // fast as it emptied and drain()'s wait loop never settled (#1078). Those
  // events were doomed anyway: the bus is cleared moments later. Refusing them
  // up front makes the stop drain finite, and logs the refusal instead of
  // swallowing it.
  let isStopping = false

  // A reconcile pass runs backgrounded (vault open fires it and does not await
  // it), so stop() has to be able to cut it short: without this, switching
  // vaults left the previous runtime's pass reading the old vault path against
  // a database that closeVault had already closed (#993).
  //
  // There can be more than one outstanding pass: `openVault` fires a full
  // reconcile without awaiting it, and a reindex or a structural config change
  // fires the embedding drain on top of it (#1083). A single
  // controller/promise pair let the second call overwrite the first, so stop()
  // aborted and awaited only the newest pass while the older one kept reading
  // the closing vault with a signal nobody held — the same unabortable stall as
  // #803/#805. Every outstanding controller is tracked so stop() can abort all
  // of them.
  const reconcileControllers = new Set<AbortController>()
  // Passes run one at a time, chained onto this tail: two concurrent passes
  // would repeat the same repair work (the embedding drain is a subset of the
  // full pass) against the same index database. stop() awaits the tail, which
  // covers the running pass and everything queued behind it.
  let reconcileChain: Promise<unknown> = Promise.resolve()

  const runReconcilePass = async (
    controller: AbortController,
    names?: string[]
  ): Promise<Record<string, unknown>> => {
    const results: Record<string, unknown> = {}

    for (const projector of selectProjectors(options.projectors, names)) {
      if (controller.signal.aborted) {
        break
      }

      try {
        results[projector.name] = await projector.reconcile(controller.signal)
      } catch (error) {
        // Isolated on purpose: the projectors are independent repairs, and one
        // of them failing is no reason to skip the rest of the pass.
        results[projector.name] = {
          reconcileFailed: true,
          projector: projector.name,
          error
        } satisfies ProjectorReconcileFailure
        logger?.error?.('Projection reconcile failed', {
          projector: projector.name,
          error
        })
      }
    }

    return results
  }

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

  const drain = async (target: ProjectorLane[]): Promise<void> => {
    // Lanes advance independently, so a lane can still be busy (or have been
    // refilled) when a faster one settles. Loop until every lane is idle — or
    // until the runtime stops, since a stopped lane never drains its backlog.
    while (!isStopped && target.some((lane) => lane.bus.size > 0 || lane.activeDrain !== null)) {
      await Promise.all(target.map((lane) => drainLane(lane)))
    }
  }

  /** Lanes a flush() barrier is allowed to wait on. See `background` in types.ts. */
  const foregroundLanes = lanes.filter((lane) => !lane.projector.background)

  /**
   * Drain every lane, but stop dequeuing once `timeoutMs` elapses.
   *
   * The deadline flips `isStopped`, which each lane loop re-reads before its
   * next event; the event already in flight keeps its await. stop() then waits
   * on the outstanding lane handles, so nothing is abandoned mid-write.
   */
  const drainWithDeadline = async (timeoutMs: number): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(
        () => {
          logger?.warn?.('Projection stop drain timed out — cutting the backlog short', {
            timeoutMs,
            pending: lanes.reduce((total, lane) => total + lane.bus.size, 0)
          })
          isStopped = true
          resolve()
        },
        Math.max(0, timeoutMs)
      )
    })

    try {
      await Promise.race([drain(lanes), deadline])
    } finally {
      clearTimeout(timer)
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
      if (isStopped || isStopping) {
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
      await drain(foregroundLanes)
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

      // A pass that arrives once stop() has begun would run against databases
      // the caller is about to close, and stop() has already aborted the
      // controllers it knew about. Start it pre-aborted so it no-ops instead.
      if (isStopping || isStopped) {
        controller.abort()
      }

      reconcileControllers.add(controller)

      const run = reconcileChain.then(() => runReconcilePass(controller, names))
      // The tail swallows, so it never rejects: a failing pass must not stop
      // the next one from being queued, and stop() awaits this handle.
      reconcileChain = run.then(
        () => {},
        () => {}
      )

      try {
        return await run
      } finally {
        reconcileControllers.delete(controller)
      }
    },

    async stop(stopOptions) {
      for (const controller of reconcileControllers) {
        controller.abort()
      }

      isStopping = true

      const shouldDrain = stopOptions?.drain ?? true
      if (shouldDrain) {
        await drainWithDeadline(stopOptions?.drainTimeoutMs ?? DEFAULT_STOP_DRAIN_TIMEOUT_MS)
      }

      isStopped = true

      // The caller closes the databases as soon as this resolves, so a lane the
      // deadline (or `drain: false`) cut short must not still be inside
      // project(). Its handle only settles once that event's await returns.
      await Promise.all(lanes.map((lane) => lane.activeDrain ?? Promise.resolve()))

      for (const lane of lanes) {
        lane.isScheduled = false
        lane.bus.clear()
      }

      // Wait for the aborted passes to unwind before returning: the caller
      // closes the databases right after this resolves. Reading the tail here
      // (rather than at the top of stop()) also covers a pass queued during the
      // drain — which starts pre-aborted, so it adds no wait.
      await reconcileChain
    },

    getPendingCount() {
      return lanes.reduce((total, lane) => total + lane.bus.size, 0)
    }
  }
}
