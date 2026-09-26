import { afterEach, describe, expect, it, vi } from 'vitest'
import { EVENT_CHANNELS } from '@memry/contracts/ipc-events'
import { SyncEngine } from '../engine'
import { ItemApplier } from '../apply-item'
import { SYNC_STATE_KEYS } from './sync-context'
import { createMockDeps, setupTestDb } from '@tests/utils/engine-mocks'

vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.0', getPath: () => '/tmp/memry-pull-throughput-test' }
}))

vi.mock('../../lib/logger', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { createLogger: () => logger }
})

const CLOCK = { 'device-2': 1 }
const PAGE = 500
const ids = (from: number, to: number): string[] =>
  Array.from({ length: to - from }, (_, i) => `filter-${from + i}`)
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const pullItem = (id: string) => ({
  id,
  type: 'filter',
  operation: 'update',
  cryptoVersion: 1,
  blob: { encryptedKey: 'ek', keyNonce: 'kn', encryptedData: 'ed', dataNonce: 'dn' },
  signature: 'sig',
  signerDeviceId: 'device-2',
  clock: CLOCK
})

/**
 * A scripted server: `pages` changes pages of `pageSize` (500) filter refs, each GET and
 * POST answered after `latencyMs`. Records the slice POSTs in issue order and
 * the most POSTs it ever had in flight.
 */
async function fakeServer(
  opts: {
    pages?: number
    pageSize?: number
    latencyMs?: number
    bad?: (itemIds: string[]) => boolean
  } = {}
): Promise<{ posts: string[]; maxInFlight: () => number }> {
  const { pages = 1, pageSize = PAGE, latencyMs = 0 } = opts
  const http = await import('../http-client')
  vi.spyOn(http, 'getFromServer').mockImplementation(async (path) => {
    await sleep(latencyMs)
    const cursor = Number(/cursor=(\d+)/.exec(path)?.[1] ?? 0)
    const next = cursor + pageSize
    return {
      items: ids(cursor, next).map((id) => ({ id, type: 'filter', version: 1, modifiedAt: 1 })),
      deleted: [],
      hasMore: next < pages * pageSize,
      nextCursor: next
    }
  })
  const posts: string[] = []
  let inFlight = 0
  let maxInFlight = 0
  vi.spyOn(http, 'postToServer').mockImplementation(async (_path, body) => {
    const itemIds = (body as { itemIds: string[] }).itemIds
    posts.push(itemIds[0])
    maxInFlight = Math.max(maxInFlight, ++inFlight)
    await sleep(latencyMs)
    inFlight--
    if (opts.bad?.(itemIds)) return { error: 'not a pull envelope' }
    return { items: itemIds.map(pullItem) }
  })
  vi.spyOn(await import('../decrypt'), 'decryptItemFromPull').mockImplementation((input) => ({
    content: new TextEncoder().encode(
      JSON.stringify({
        name: input.id,
        config: {},
        position: 0,
        clock: CLOCK,
        createdAt: '2026-09-01T00:00:00.000Z'
      })
    ),
    verified: true
  }))
  return { posts, maxInFlight: () => maxInFlight }
}

const itemSyncedIds = (emit: unknown): string[] =>
  (emit as ReturnType<typeof vi.fn>).mock.calls
    .filter(([channel]) => channel === EVENT_CHANNELS.ITEM_SYNCED)
    .map(([, data]) => (data as { itemId: string }).itemId)

describe('PullCoordinator slice prefetch', () => {
  const { getDb } = setupTestDb()

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps the next slice POST in flight and still applies in page order', async () => {
    const deps = createMockDeps(getDb())
    const engine = new SyncEngine(deps)
    engine.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, '0')
    const server = await fakeServer({ latencyMs: 20 })

    await expect(engine.pull()).resolves.toBe(true)

    expect(server.maxInFlight()).toBe(2)
    expect(server.posts).toEqual([
      'filter-0',
      'filter-100',
      'filter-200',
      'filter-300',
      'filter-400'
    ])
    expect(itemSyncedIds(deps.emitToRenderer)).toEqual(ids(0, 500))
    expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('500')
  })

  it('a stop on slice 2 fetches at most one slice past it', async () => {
    const deps = createMockDeps(getDb())
    const engine = new SyncEngine(deps)
    engine.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, '0')
    const server = await fakeServer({ bad: (itemIds) => itemIds.includes('filter-100') })

    await expect(engine.pull()).resolves.toBe(false)

    expect(server.posts).toEqual(['filter-0', 'filter-100', 'filter-200'])
    expect(itemSyncedIds(deps.emitToRenderer)).toEqual(ids(0, 100))
    expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('0')
  })

  // The harness behind the PR's numbers: MEMRY_PULL_PERF=1 prints the wall
  // time of a 3-page, 15-slice pull against a server with fixed latency
  // (MEMRY_PULL_PERF_LATENCY_MS, default 140).
  it.runIf(process.env.MEMRY_PULL_PERF === '1')(
    'perf: 3 pages x 5 slices against a fixed-latency server',
    { timeout: 120_000 },
    async () => {
      const latencyMs = Number(process.env.MEMRY_PULL_PERF_LATENCY_MS ?? 140)
      const engine = new SyncEngine(createMockDeps(getDb()))
      engine.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, '0')
      await fakeServer({ pages: 3, latencyMs })

      const started = performance.now()
      await expect(engine.pull()).resolves.toBe(true)
      const ms = Math.round(performance.now() - started)

      process.stdout.write(`PULL_PERF slices=15 latencyMs=${latencyMs} wallMs=${ms}\n`)
      expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('1500')
    }
  )
})

/** `ItemApplier.apply` throws once for the first `count` filters, as a missing FK parent does. */
function deferFirstApply(count: number): { applies: () => number } {
  const deferred = new Set(ids(0, count))
  let applies = 0
  const apply = ItemApplier.prototype.apply
  vi.spyOn(ItemApplier.prototype, 'apply').mockImplementation(function (
    this: ItemApplier,
    ...args
  ) {
    applies++
    if (deferred.delete(args[0].itemId)) throw new Error('parent not pulled yet')
    return apply.apply(this, args)
  })
  return { applies: () => applies }
}

describe('PullCoordinator deferred retries', () => {
  const { getDb } = setupTestDb()

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('tells the renderer about retried items only after every retry applied', async () => {
    const deps = createMockDeps(getDb())
    const engine = new SyncEngine(deps)
    engine.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, '0')
    await fakeServer()
    const { applies } = deferFirstApply(60)
    const appliesAtEmit: number[] = []
    vi.mocked(deps.emitToRenderer).mockImplementation((channel, data) => {
      const id = (data as { itemId?: string }).itemId
      if (channel === EVENT_CHANNELS.ITEM_SYNCED && ids(0, 60).includes(id ?? '')) {
        appliesAtEmit.push(applies())
      }
    })

    await expect(engine.pull()).resolves.toBe(true)

    // 500 first applies, then 60 retries, then the 60 events.
    expect(appliesAtEmit).toEqual(Array.from({ length: 60 }, () => 560))
    expect(itemSyncedIds(deps.emitToRenderer).slice(-60)).toEqual(ids(0, 60))
  })

  // MEMRY_PULL_PERF=1: 126 deferred retries while every ITEM_SYNCED costs the
  // main thread 20 ms, the renderer's refetch it triggers.
  it.runIf(process.env.MEMRY_PULL_PERF === '1')(
    'perf: 126 deferred retries with a 20ms refetch per ITEM_SYNCED',
    { timeout: 120_000 },
    async () => {
      const deps = createMockDeps(getDb())
      const engine = new SyncEngine(deps)
      engine.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, '0')
      await fakeServer({ pageSize: 126 })
      deferFirstApply(126)
      vi.mocked(deps.emitToRenderer).mockImplementation((channel) => {
        if (channel !== EVENT_CHANNELS.ITEM_SYNCED) return
        setImmediate(() => {
          const until = performance.now() + 20
          while (performance.now() < until);
        })
      })

      const started = performance.now()
      await expect(engine.pull()).resolves.toBe(true)
      const ms = Math.round(performance.now() - started)

      process.stdout.write(`DEFERRED_PERF retries=126 refetchMs=20 pullWallMs=${ms}\n`)
    }
  )
})
