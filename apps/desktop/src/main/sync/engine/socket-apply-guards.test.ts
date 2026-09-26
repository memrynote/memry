import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { RecordPullItemResponse } from '@memry/contracts/sync-api'
import type { DecryptedPullItem } from '@memry/sync-client/worker-protocol'

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'socket-apply-guards-'))
vi.mock('electron', () => ({ app: { getPath: vi.fn(() => userDataDir) } }))
vi.mock('../../lib/logger', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { createLogger: () => logger }
})
vi.mock('../crdt-writeback', () => ({ markWritebackIgnored: vi.fn() }))
vi.mock('../../database/client', () => ({
  isIndexDatabaseInitialized: vi.fn(() => false),
  getRawIndexDatabase: vi.fn(() => null)
}))
vi.mock('../../crypto/index', () => ({ secureCleanup: vi.fn() }))
vi.mock('../sync-crypto-batch', () => ({ decryptPullBatch: vi.fn() }))
vi.mock('../../telemetry/track', () => ({ trackMainEvent: vi.fn() }))
vi.mock('../../telemetry/diagnostics', () => ({ trackMainLog: vi.fn() }))

import {
  createSocketApplier,
  SOCKET_APPLY_MAX_ITEMS,
  SOCKET_APPLY_QUIESCENCE_TIMEOUT_MS,
  type SocketApplyDeps
} from './socket-apply'
import { decryptPullBatch } from '../sync-crypto-batch'
import { trackMainEvent } from '../../telemetry/track'
import { trackMainLog } from '../../telemetry/diagnostics'
import {
  _pendingQuiescenceWaitersForTests,
  _resetBulkApplyForTests,
  _unlandedOpCountForTests,
  beginPageApply,
  whenPageApplyQuiescent,
  writeSyncedVaultFile
} from '../bulk-apply'
import {
  LATENCY_EVENTS_PER_RUN,
  PullLatencyTrace,
  _resetLatestServerClockOffsetForTests
} from './sync-latency-telemetry'
import type { DrizzleDb } from '@memry/sync-client/item-handlers/types'

/**
 * #2300 review fixes: the guards around the socket fast path (ordering,
 * quiescence by construction, bounded waits and output).
 */

const pullItem = (id: string, type: RecordPullItemResponse['type'] = 'task') =>
  ({
    id,
    type,
    operation: 'update',
    cryptoVersion: 1,
    signature: 'sig',
    signerDeviceId: 'device-b',
    clock: { 'device-b': 2 },
    blob: { encryptedKey: 'k', keyNonce: 'kn', encryptedData: 'd', dataNonce: 'dn' }
  }) satisfies RecordPullItemResponse

const decrypted = (id: string, type = 'task'): DecryptedPullItem => ({
  id,
  type,
  operation: 'update',
  content: JSON.stringify({ title: id }),
  clock: { 'device-b': 2 },
  signerDeviceId: 'device-b'
})

const frame = (items: RecordPullItemResponse[], cursor = 9) => ({
  kind: 'changes_available' as const,
  cursor,
  committedAtMs: Date.now() - 50,
  items
})

const decryptAll = (): void => {
  vi.mocked(decryptPullBatch).mockImplementation(async (items) => ({
    decrypted: items.map((item) => decrypted(item.id, item.type)),
    failures: []
  }))
}

function makeDeps(overrides: Partial<SocketApplyDeps> = {}): SocketApplyDeps {
  let suppressed = false
  return {
    db: {} as DrizzleDb,
    applier: { apply: vi.fn().mockReturnValue('applied') },
    appliedCursor: () => 4,
    eligible: () => true,
    pushInFlight: () => false,
    whenPushSettled: vi.fn().mockResolvedValue(true),
    isQuarantined: () => false,
    getVaultKey: vi.fn(async () => new Uint8Array(32)),
    getDevicePublicKey: vi.fn().mockResolvedValue(new Uint8Array(32)),
    setPushSuppressed: (value) => {
      suppressed = value
    },
    isPushSuppressed: () => suppressed,
    onApplied: vi.fn(),
    onConflict: vi.fn(),
    requestPush: vi.fn(),
    oweRecordBody: vi.fn(),
    ...overrides
  }
}

const hops = async (count: number): Promise<void> => {
  for (let i = 0; i < count; i++) await Promise.resolve()
}

describe('socket apply guards (#2300 review)', () => {
  beforeEach(() => {
    vi.mocked(decryptPullBatch).mockReset()
    vi.mocked(trackMainEvent).mockReset()
    vi.mocked(trackMainLog).mockReset()
    _resetBulkApplyForTests()
    _resetLatestServerClockOffsetForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    _resetBulkApplyForTests()
  })

  // #2300 review A-2 / B-F3: a page commit that needs no macrotask can land
  // between the waiter resolving and the apply; the apply must see it.
  it.each([0, 1, 2, 3, 4, 5, 6, 8, 12])(
    'applies only at a quiescent point when a page commits %i microtasks after the waiter resolves',
    async (delay) => {
      const target = path.join(userDataDir, `hop-${delay}`, 'x.md')
      const gates: Array<() => void> = []
      const realWriteFile = fs.promises.writeFile
      vi.spyOn(fs.promises, 'writeFile').mockImplementation(
        async (...args: Parameters<typeof fs.promises.writeFile>) => {
          await new Promise<void>((resolve) => gates.push(resolve))
          return realWriteFile(...args)
        }
      )
      decryptAll()
      const quiescentAtApply: boolean[] = []
      // The frame applies inside its own page session (review A-H1), so the
      // quiescent point is: no pull page open and nothing a page journaled
      // still unlanded. A second session cannot be open: beginPageApply
      // refuses to nest.
      const apply = vi.fn(() => {
        quiescentAtApply.push(_unlandedOpCountForTests() === 0)
        writeSyncedVaultFile(target, 'frame')
        return 'applied' as const
      })

      const first = beginPageApply({} as DrizzleDb)
      writeSyncedVaultFile(target, 'page 1')
      first.commit()
      const firstFlush = first.flushFiles()
      let secondFlush: Promise<void> | null = null
      void whenPageApplyQuiescent(SOCKET_APPLY_QUIESCENCE_TIMEOUT_MS).then(async () => {
        await hops(delay)
        const second = beginPageApply({} as DrizzleDb)
        writeSyncedVaultFile(target, 'page 2')
        second.commit()
        secondFlush = second.flushFiles()
      })

      const outcome = createSocketApplier(makeDeps({ applier: { apply } })).apply(
        frame([pullItem('x', 'note')])
      )
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(apply).not.toHaveBeenCalled()
      // From here every file write is let through as soon as it starts.
      const drain = setInterval(() => {
        while (gates.length > 0) gates.shift()!()
      }, 1)
      await firstFlush
      await outcome
      await new Promise((resolve) => setTimeout(resolve, 10))
      await secondFlush
      clearInterval(drain)

      expect(quiescentAtApply).toEqual([true])
    }
  )

  // #2300 review A-3 / B-F2: a timed-out wait leaves nothing behind.
  it('a frame dropped as busy removes its waiter and reports once', async () => {
    vi.useFakeTimers()
    decryptAll()
    beginPageApply({} as DrizzleDb)
    const applier = createSocketApplier(makeDeps())

    for (let i = 0; i < 3; i++) {
      const outcome = applier.apply(frame([pullItem(`t${i}`)], 10 + i))
      await vi.advanceTimersByTimeAsync(SOCKET_APPLY_QUIESCENCE_TIMEOUT_MS + 1)
      await expect(outcome).resolves.toEqual({ kind: 'skipped', reason: 'busy' })
    }

    expect(_pendingQuiescenceWaitersForTests()).toBe(0)
    const busyLogs = vi
      .mocked(trackMainLog)
      .mock.calls.filter(([, options]) => options.action === 'socket_items_busy')
    expect(busyLogs).toHaveLength(1)
  })

  // #2300 review A-1: frames apply one at a time in arrival order.
  it('applies frames in arrival order even when a later frame decrypts first', async () => {
    let releaseFirst!: () => void
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    vi.mocked(decryptPullBatch).mockImplementation(async (items) => {
      if (items[0]?.id === 'first') await firstHeld
      return { decrypted: items.map((item) => decrypted(item.id)), failures: [] }
    })
    const order: string[] = []
    const apply = vi.fn((input: { itemId: string }) => {
      order.push(input.itemId)
      return 'applied' as const
    })
    const applier = createSocketApplier(makeDeps({ applier: { apply } }))

    const a = applier.apply(frame([pullItem('first')], 10))
    const b = applier.apply(frame([pullItem('second')], 11))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(order).toEqual([])
    releaseFirst()
    await Promise.all([a, b])

    expect(order).toEqual(['first', 'second'])
  })

  // #2300 review A-5 / B-F4: like the pull, a skipped row notifies nobody.
  it('notifies the renderer only for applied and conflict results', async () => {
    decryptAll()
    const apply = vi
      .fn()
      .mockReturnValueOnce('skipped')
      .mockReturnValueOnce('applied')
      .mockReturnValueOnce('conflict')
    const deps = makeDeps({ applier: { apply } })

    await createSocketApplier(deps).apply(frame([pullItem('a'), pullItem('b'), pullItem('c')]))

    expect(vi.mocked(deps.onApplied).mock.calls.map(([dec]) => dec.id)).toEqual(['b', 'c'])
  })

  // #2300 review A-7 / B-F7: one frame applies a bounded number of items.
  it('applies at most SOCKET_APPLY_MAX_ITEMS items and leaves the rest to the pull', async () => {
    decryptAll()
    const deps = makeDeps()
    const items = Array.from({ length: SOCKET_APPLY_MAX_ITEMS + 10 }, (_, i) => pullItem(`t${i}`))

    const outcome = await createSocketApplier(deps).apply(frame(items))

    expect(outcome).toEqual({ kind: 'applied', applied: SOCKET_APPLY_MAX_ITEMS, leftToFeed: 10 })
    expect(deps.applier.apply).toHaveBeenCalledTimes(SOCKET_APPLY_MAX_ITEMS)
    expect(vi.mocked(decryptPullBatch).mock.calls[0][0]).toHaveLength(SOCKET_APPLY_MAX_ITEMS)
  })

  // #2300 review B-F6: socket latency events are capped like the pull's.
  it('caps socket e2e_latency events per minute', async () => {
    decryptAll()
    await new PullLatencyTrace(null).timeChanges(async () => ({ serverTimeMs: Date.now() }))
    const applier = createSocketApplier(makeDeps())

    for (let i = 0; i < LATENCY_EVENTS_PER_RUN + 5; i++) {
      await applier.apply(frame([pullItem(`t${i}`)], 10 + i))
    }

    const socketEvents = vi
      .mocked(trackMainEvent)
      .mock.calls.filter(([, options]) => options.source === 'socket')
    expect(socketEvents).toHaveLength(LATENCY_EVENTS_PER_RUN)
  })

  // #2300 review B-L3: a frame that meets a local push waits for it, like a
  // page apply, instead of falling back to the pull during an editing burst.
  it('waits for an in-flight push to settle, then applies', async () => {
    decryptAll()
    let inFlight = true
    let settle!: (settled: boolean) => void
    const whenPushSettled = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          settle = resolve
        })
    )
    const deps = makeDeps({ pushInFlight: () => inFlight, whenPushSettled })

    const outcome = createSocketApplier(deps).apply(frame([pullItem('t1')]))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(deps.applier.apply).not.toHaveBeenCalled()
    expect(whenPushSettled).toHaveBeenCalledWith(expect.any(Number))

    inFlight = false
    settle(true)

    await expect(outcome).resolves.toEqual({ kind: 'applied', applied: 1, leftToFeed: 0 })
    expect(deps.applier.apply).toHaveBeenCalledTimes(1)
  })

  // #2300 review B-L2 / B-L3: a push that outlasts the deadline drops the
  // frame to the pull, and the one-shot diagnostic names the cause.
  it('drops a frame as busy when the push outlasts the deadline, reporting the cause', async () => {
    decryptAll()
    const deps = makeDeps({
      pushInFlight: () => true,
      whenPushSettled: vi.fn().mockResolvedValue(false)
    })

    const outcome = await createSocketApplier(deps).apply(frame([pullItem('t1')]))

    expect(outcome).toEqual({ kind: 'skipped', reason: 'busy' })
    expect(deps.applier.apply).not.toHaveBeenCalled()
    const busy = vi
      .mocked(trackMainLog)
      .mock.calls.filter(([, options]) => options.action === 'socket_items_busy')
    expect(busy).toHaveLength(1)
    expect(busy[0][1]).toMatchObject({ errorCode: 'push_in_flight' })
  })
})
