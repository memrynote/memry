import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RecordChangesResponse } from '@memry/contracts/sync-api'

const { trackMainEventMock } = vi.hoisted(() => ({ trackMainEventMock: vi.fn() }))
vi.mock('../../telemetry/track', () => ({ trackMainEvent: trackMainEventMock }))

import {
  LATENCY_EVENTS_PER_RUN,
  LIVE_PROPAGATION_WINDOW_MS,
  PullLatencyTrace,
  PushLagTrace
} from './sync-latency-telemetry'

type ChangesRef = RecordChangesResponse['items'][number]

const ref = (id: string, overrides: Partial<ChangesRef> = {}): ChangesRef => ({
  id,
  type: 'task',
  version: 1,
  modifiedAt: 1,
  size: 1,
  ...overrides
})

const page = (
  items: ChangesRef[],
  serverTimeMs?: number
): RecordChangesResponse & { serverTimeMs?: number } => ({
  items,
  deleted: [],
  hasMore: false,
  nextCursor: 0,
  ...(serverTimeMs !== undefined ? { serverTimeMs } : {})
})

/** One GET /sync/changes: sent at `sentAt`, answered at `receivedAt`. */
const timedFetch = async (
  trace: PullLatencyTrace,
  response: RecordChangesResponse,
  sentAt: number,
  receivedAt: number
): Promise<RecordChangesResponse> => {
  vi.setSystemTime(sentAt)
  return trace.timeChanges(async () => {
    vi.setSystemTime(receivedAt)
    return response
  })
}

const e2eEvents = () =>
  trackMainEventMock.mock.calls
    .filter(([name, options]) => name === 'sync_run_completed' && options.action === 'e2e_latency')
    .map(([, options]) => options.metrics as { durationMs: number; value: number })

const pushLagEvents = () =>
  trackMainEventMock.mock.calls
    .filter(([name, options]) => name === 'sync_run_completed' && options.action === 'push_lag')
    .map(([, options]) => options.metrics as { durationMs: number; value: number })

beforeEach(() => {
  trackMainEventMock.mockReset()
  vi.useFakeTimers({ toFake: ['Date'] })
})

afterEach(() => {
  vi.useRealTimers()
})

// #2280: receiver side of the end-to-end sync trace.
describe('PullLatencyTrace', () => {
  it('corrects the apply time by the clock offset from the RTT midpoint', async () => {
    // Client clock is 40 s behind the server: sent at 10_000, answered at
    // 10_200, server said 50_100 -> offset = 50_100 - 10_100 = 40_000.
    const trace = new PullLatencyTrace('device-self')
    const changes = await timedFetch(
      trace,
      page([ref('t1', { serverCursor: 7, committedAtMs: 49_500 })], 50_100),
      10_000,
      10_200
    )

    trace.observePage(changes)
    trace.noteApplied({ id: 't1', type: 'task', signerDeviceId: 'device-peer' }, 'applied')
    vi.setSystemTime(10_300)
    trace.flush()

    // Applied at 10_300 client = 50_300 server; committed at 49_500.
    expect(e2eEvents()).toEqual([{ durationMs: 800, value: 7 }])
    expect(trackMainEventMock).toHaveBeenCalledWith('sync_run_completed', {
      surface: 'sync',
      action: 'e2e_latency',
      result: 'success',
      source: 'pull',
      metrics: { durationMs: 800, value: 7 },
      dimensions: { transport: 'record' }
    })
  })

  it('keeps the offset from the lowest-RTT sample', async () => {
    const trace = new PullLatencyTrace('device-self')
    // RTT 100: offset = 50_050 - 10_050 = 40_000.
    await timedFetch(trace, page([], 50_050), 10_000, 10_100)
    // RTT 2000 (an overlapped prefetch): a skewed sample, ignored.
    await timedFetch(trace, page([], 99_999), 11_000, 13_000)

    trace.observePage(page([ref('t1', { serverCursor: 3, committedAtMs: 53_000 })]))
    trace.noteApplied({ id: 't1', type: 'task', signerDeviceId: 'device-peer' }, 'conflict')
    vi.setSystemTime(13_500)
    trace.flush()

    expect(e2eEvents()).toEqual([{ durationMs: 500, value: 3 }])
  })

  it('emits only for items applied or merged as a conflict', async () => {
    const trace = new PullLatencyTrace('device-self')
    await timedFetch(trace, page([], 1_000), 1_000, 1_000)
    trace.observePage(
      page(
        ['applied', 'conflict', 'skipped', 'parse_error', 'schema_invalid'].map((id, index) =>
          ref(id, { serverCursor: index + 1, committedAtMs: 900 })
        )
      )
    )

    for (const result of ['applied', 'conflict', 'skipped', 'parse_error', 'schema_invalid']) {
      trace.noteApplied({ id: result, type: 'task', signerDeviceId: 'device-peer' }, result)
    }
    trace.flush()

    expect(e2eEvents().map((event) => event.value)).toEqual([1, 2])
  })

  it('emits nothing against a server that sends no serverTimeMs', async () => {
    const trace = new PullLatencyTrace('device-self')
    await timedFetch(trace, page([]), 1_000, 1_100)
    trace.observePage(page([ref('t1', { serverCursor: 1, committedAtMs: 1_000 })]))
    trace.noteApplied({ id: 't1', type: 'task', signerDeviceId: 'device-peer' }, 'applied')
    trace.flush()

    expect(e2eEvents()).toEqual([])
  })

  it('skips refs without a commit time and backlog older than the live window', async () => {
    const now = 100 * LIVE_PROPAGATION_WINDOW_MS
    const trace = new PullLatencyTrace('device-self')
    await timedFetch(trace, page([], now), now, now)
    trace.observePage(
      page([
        ref('legacy', { serverCursor: 1 }),
        ref('backlog', { serverCursor: 2, committedAtMs: now - LIVE_PROPAGATION_WINDOW_MS - 1 }),
        ref('live', { serverCursor: 3, committedAtMs: now - 250 })
      ])
    )
    for (const id of ['legacy', 'backlog', 'live']) {
      trace.noteApplied({ id, type: 'task', signerDeviceId: 'device-peer' }, 'applied')
    }
    trace.flush()

    expect(e2eEvents()).toEqual([{ durationMs: 250, value: 3 }])
  })

  it("skips this device's own rows served back by the feed", async () => {
    const trace = new PullLatencyTrace('device-self')
    await timedFetch(trace, page([], 1_000), 1_000, 1_000)
    trace.observePage(page([ref('mine', { serverCursor: 4, committedAtMs: 900 })]))

    trace.noteApplied({ id: 'mine', type: 'task', signerDeviceId: 'device-self' }, 'applied')
    trace.flush()

    expect(e2eEvents()).toEqual([])
  })

  it('matches refs on (type, id), not id alone', async () => {
    const trace = new PullLatencyTrace('device-self')
    await timedFetch(trace, page([], 1_000), 1_000, 1_000)
    trace.observePage(
      page([ref('inbox', { type: 'project', serverCursor: 5, committedAtMs: 900 })])
    )

    trace.noteApplied(
      { id: 'inbox', type: 'tag_definition', signerDeviceId: 'device-peer' },
      'applied'
    )
    trace.flush()

    expect(e2eEvents()).toEqual([])
  })

  it('reports a negative estimate as zero so the event stays valid', async () => {
    const trace = new PullLatencyTrace('device-self')
    await timedFetch(trace, page([], 1_000), 1_000, 1_000)
    trace.observePage(page([ref('t1', { serverCursor: 1, committedAtMs: 1_040 })]))
    trace.noteApplied({ id: 't1', type: 'task', signerDeviceId: 'device-peer' }, 'applied')
    trace.flush()

    expect(e2eEvents()).toEqual([{ durationMs: 0, value: 1 }])
  })

  it(`caps a run at ${LATENCY_EVENTS_PER_RUN} events across slices`, async () => {
    const trace = new PullLatencyTrace('device-self')
    await timedFetch(trace, page([], 1_000), 1_000, 1_000)
    for (let slice = 0; slice < 3; slice++) {
      const refs = Array.from({ length: 15 }, (_, i) =>
        ref(`s${slice}-${i}`, { serverCursor: slice * 100 + i, committedAtMs: 900 })
      )
      trace.observePage(page(refs))
      for (const item of refs)
        trace.noteApplied({ ...item, signerDeviceId: 'device-peer' }, 'applied')
      trace.flush()
    }

    expect(e2eEvents()).toHaveLength(LATENCY_EVENTS_PER_RUN)
  })
})

// #2280 (Review): origin side, the delay before the server commit.
describe('PushLagTrace', () => {
  const row = (id: string, itemId: string, createdAtMs: number) => ({
    id,
    itemId,
    createdAt: new Date(createdAtMs)
  })
  const queue = (times: Record<string, number>) => ({
    enqueuedAtMs: (queued: { id: string; createdAt: Date }) =>
      times[queued.id] ?? queued.createdAt.getTime()
  })

  it('reports accept time minus enqueue time per accepted row, keyed by maxCursor', () => {
    vi.setSystemTime(20_000)
    const trace = new PushLagTrace()

    trace.record(
      [row('q1', 'task-1', 17_000), row('q2', 'task-2', 18_000), row('q3', 'task-3', 18_000)],
      { accepted: ['task-1', 'task-3'], rejected: [], serverTime: 20, maxCursor: 42 },
      queue({ q1: 17_650 })
    )

    expect(pushLagEvents()).toEqual([
      { durationMs: 2_350, value: 42 },
      { durationMs: 2_000, value: 42 }
    ])
    expect(trackMainEventMock).toHaveBeenCalledWith('sync_run_completed', {
      surface: 'sync',
      action: 'push_lag',
      result: 'success',
      source: 'push',
      metrics: { durationMs: 2_350, value: 42 },
      dimensions: { transport: 'record' }
    })
  })

  it('skips an offline backlog older than the live window', () => {
    const now = 100 * LIVE_PROPAGATION_WINDOW_MS
    vi.setSystemTime(now)
    const trace = new PushLagTrace()

    trace.record(
      [row('q1', 'old', now - LIVE_PROPAGATION_WINDOW_MS - 1), row('q2', 'new', now - 300)],
      { accepted: ['old', 'new'], rejected: [], serverTime: 0, maxCursor: 9 },
      queue({})
    )

    expect(pushLagEvents()).toEqual([{ durationMs: 300, value: 9 }])
  })

  it(`caps a push run at ${LATENCY_EVENTS_PER_RUN} events across responses`, () => {
    vi.setSystemTime(5_000)
    const trace = new PushLagTrace()
    for (let batch = 0; batch < 3; batch++) {
      const rows = Array.from({ length: 15 }, (_, i) =>
        row(`q${batch}-${i}`, `i${batch}-${i}`, 4_000)
      )
      trace.record(
        rows,
        { accepted: rows.map((r) => r.itemId), rejected: [], serverTime: 0, maxCursor: batch },
        queue({})
      )
    }

    expect(pushLagEvents()).toHaveLength(LATENCY_EVENTS_PER_RUN)
  })
})
