import type { PushResponse, RecordChangesResponse } from '@memry/contracts/sync-api'
import { trackMainEvent } from '../../telemetry/track'
import { itemRefKey } from './sync-context'

/**
 * End-to-end sync latency telemetry (#2280). Two halves, both keyed by the
 * server cursor so they join with the server's push-accept and broadcast logs:
 *
 * - origin: `push_lag` = push accepted - row enqueued, both on this clock.
 * - receiver: `e2e_latency` = applied - server commit, the apply time moved
 *   onto the server clock by an offset estimated from `serverTimeMs` and the
 *   request's RTT midpoint.
 *
 * Both are `sync_run_completed` events told apart by `action`: a new event
 * name would fail the whole telemetry batch on a server that predates it.
 */

/** Per pull run and per push run, so a bootstrap or a backlog cannot flood. */
export const LATENCY_EVENTS_PER_RUN = 20

/** Older than this is backlog (offline device, first sync), not propagation. */
export const LIVE_PROPAGATION_WINDOW_MS = 10 * 60 * 1000

const trackLatency = (
  action: 'e2e_latency' | 'push_lag',
  source: 'pull' | 'push',
  durationMs: number,
  cursor: number
): void => {
  trackMainEvent('sync_run_completed', {
    surface: 'sync',
    action,
    result: 'success',
    source,
    // Clamped: a negative duration (offset estimate error) fails the metrics
    // schema, and the server rejects the whole batch it arrives in.
    metrics: { durationMs: Math.max(0, Math.round(durationMs)), value: cursor },
    dimensions: { transport: 'record' }
  })
}

export class PullLatencyTrace {
  private offsetMs: number | null = null
  private bestRttMs = Number.POSITIVE_INFINITY
  private pageRefs = new Map<string, { serverCursor: number; committedAtMs: number }>()
  private applied: Array<{ serverCursor: number; committedAtMs: number }> = []
  private emitted = 0

  /**
   * `ownDeviceId` excludes this device's own rows: the feed serves them back,
   * and an echo at an equal clock applies like any peer write.
   */
  constructor(private readonly ownDeviceId: string | null) {}

  /**
   * Runs one `GET /sync/changes` and samples the clock offset from it. The
   * lowest-RTT sample wins: a prefetch that overlaps a synchronous page apply
   * sees its response late, which skews the midpoint.
   */
  async timeChanges<T extends { serverTimeMs?: number }>(request: () => Promise<T>): Promise<T> {
    const sentAt = Date.now()
    const response = await request()
    const receivedAt = Date.now()
    const rttMs = receivedAt - sentAt
    if (typeof response.serverTimeMs === 'number' && rttMs <= this.bestRttMs) {
      this.bestRttMs = rttMs
      this.offsetMs = response.serverTimeMs - (sentAt + receivedAt) / 2
    }
    return response
  }

  /** The page about to be applied. Replaces the previous page's refs. */
  observePage(changes: RecordChangesResponse): void {
    this.pageRefs.clear()
    for (const ref of changes.items) {
      if (typeof ref.serverCursor !== 'number' || typeof ref.committedAtMs !== 'number') continue
      this.pageRefs.set(itemRefKey(ref.type, ref.id), {
        serverCursor: ref.serverCursor,
        committedAtMs: ref.committedAtMs
      })
    }
  }

  noteApplied(item: { id: string; type: string; signerDeviceId: string }, result: string): void {
    if (result !== 'applied' && result !== 'conflict') return
    if (item.signerDeviceId === this.ownDeviceId) return
    const ref = this.pageRefs.get(itemRefKey(item.type, item.id))
    if (ref) this.applied.push(ref)
  }

  /** Call after the slice's transaction commits: the apply time is now. */
  flush(): void {
    const applied = this.applied
    this.applied = []
    if (this.offsetMs === null) return
    const appliedAtServerMs = Date.now() + this.offsetMs
    for (const ref of applied) {
      if (this.emitted >= LATENCY_EVENTS_PER_RUN) return
      const latencyMs = appliedAtServerMs - ref.committedAtMs
      if (latencyMs > LIVE_PROPAGATION_WINDOW_MS) continue
      this.emitted++
      trackLatency('e2e_latency', 'pull', latencyMs, ref.serverCursor)
    }
  }
}

export class PushLagTrace {
  private emitted = 0

  /**
   * One push response. `value` is the response's `maxCursor`: the response
   * carries no per-item cursor, and every accepted row sits at or below it.
   */
  record(
    rows: ReadonlyArray<{ id: string; itemId: string; createdAt: Date }>,
    response: PushResponse,
    queue: { enqueuedAtMs(row: { id: string; createdAt: Date }): number }
  ): void {
    const acceptedAt = Date.now()
    const accepted = new Set(response.accepted)
    for (const row of rows) {
      if (this.emitted >= LATENCY_EVENTS_PER_RUN) return
      if (!accepted.has(row.itemId)) continue
      const lagMs = acceptedAt - queue.enqueuedAtMs(row)
      if (lagMs > LIVE_PROPAGATION_WINDOW_MS) continue
      this.emitted++
      trackLatency('push_lag', 'push', lagMs, response.maxCursor)
    }
  }
}
