import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { RecordPullItemResponse } from '@memry/contracts/sync-api'
import type { DecryptedPullItem } from '@memry/sync-client/worker-protocol'
import { MissingSyncParentError } from '@memry/sync-client/item-handlers/types'
import { PendingSyncIntentError } from '../pending-sync-intent-error'

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'socket-apply-'))
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

import {
  createSocketApplier,
  SOCKET_APPLY_QUIESCENCE_TIMEOUT_MS,
  type SocketApplyDeps
} from './socket-apply'
import { decryptPullBatch } from '../sync-crypto-batch'
import { secureCleanup } from '../../crypto/index'
import { trackMainEvent } from '../../telemetry/track'
import {
  _resetBulkApplyForTests,
  beginPageApply,
  deleteSyncedVaultFile,
  isPageApplyQuiescent,
  replayBulkApplyJournal,
  writeSyncedVaultFile
} from '../bulk-apply'
import { PullLatencyTrace, _resetLatestServerClockOffsetForTests } from './sync-latency-telemetry'
import type { DrizzleDb } from '@memry/sync-client/item-handlers/types'
import Database from 'better-sqlite3'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'

/**
 * #2300: the socket fast path applies a frame's items through the pull's
 * applier at a quiescent point, and leaves every failure and the cursor to the
 * wake pull that follows every frame.
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

function makeDeps(overrides: Partial<SocketApplyDeps> = {}): SocketApplyDeps & {
  suppressed: boolean[]
} {
  const suppressed: boolean[] = []
  let current = false
  return {
    suppressed,
    db: {} as DrizzleDb,
    applier: { apply: vi.fn().mockReturnValue('applied') },
    appliedCursor: () => 4,
    eligible: () => true,
    pushInFlight: () => false,
    whenPushSettled: vi.fn().mockResolvedValue(true),
    isQuarantined: () => false,
    getVaultKey: vi.fn().mockResolvedValue(new Uint8Array(32)),
    getDevicePublicKey: vi.fn().mockResolvedValue(new Uint8Array(32)),
    setPushSuppressed: (value) => {
      current = value
      suppressed.push(value)
    },
    isPushSuppressed: () => current,
    onApplied: vi.fn(),
    onConflict: vi.fn(),
    requestPush: vi.fn(),
    oweRecordBody: vi.fn(),
    ...overrides
  }
}

describe('createSocketApplier', () => {
  beforeEach(() => {
    vi.mocked(decryptPullBatch).mockReset()
    vi.mocked(trackMainEvent).mockReset()
    _resetBulkApplyForTests()
    _resetLatestServerClockOffsetForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    _resetBulkApplyForTests()
  })

  // #2300
  it('applies decrypted items through the applier inside a frame page session', async () => {
    vi.mocked(decryptPullBatch).mockResolvedValue({
      decrypted: [decrypted('t1')],
      failures: []
    })
    const deps = makeDeps()

    const outcome = await createSocketApplier(deps).apply(frame([pullItem('t1')]))

    expect(outcome).toEqual({ kind: 'applied', applied: 1, leftToFeed: 0 })
    expect(deps.applier.apply).toHaveBeenCalledTimes(1)
    const [input, page] = vi.mocked(deps.applier.apply).mock.calls[0]
    expect(page).toMatchObject({ db: deps.db })
    expect(input).toMatchObject({ itemId: 't1', type: 'task', operation: 'update' })
    expect(deps.onApplied).toHaveBeenCalledWith(decrypted('t1'), 'update')
    expect(deps.suppressed).toEqual([true, false])
    expect(secureCleanup).toHaveBeenCalled()
  })

  // #2300: the watermark invariant lives in the type, not in review.
  it('has no way to write sync state', () => {
    expectTypeOf<SocketApplyDeps>().not.toHaveProperty('setStateValue')
    expectTypeOf<SocketApplyDeps>().not.toHaveProperty('stateManager')
    expectTypeOf<SocketApplyDeps>().not.toHaveProperty('quarantineItem')
    // #2302 / #2301: no schema-invalid ledger of any kind (blob_missing,
    // pending_intent included), and no body landing (#2297).
    expectTypeOf<SocketApplyDeps>().not.toHaveProperty('schemaInvalid')
    expectTypeOf<SocketApplyDeps>().not.toHaveProperty('noteBodyFeed')
    expectTypeOf<SocketApplyDeps['appliedCursor']>().returns.toEqualTypeOf<number>()
  })

  // #2300: signature verification is mandatory and a failure is the pull's call.
  it('a frame item with a bad signature is not applied and is not quarantined here', async () => {
    vi.mocked(decryptPullBatch).mockResolvedValue({
      decrypted: [],
      failures: [
        {
          id: 't1',
          type: 'task',
          signerDeviceId: 'device-b',
          error: 'Signature verification failed',
          isCryptoError: true,
          isSignatureError: true
        }
      ]
    })
    const deps = makeDeps()

    const outcome = await createSocketApplier(deps).apply(frame([pullItem('t1')]))

    expect(outcome).toEqual({ kind: 'skipped', reason: 'nothing_valid' })
    expect(deps.applier.apply).not.toHaveBeenCalled()
  })

  // #2300: one bad item never costs its neighbours.
  it('applies the valid items of a frame with one failing item', async () => {
    vi.mocked(decryptPullBatch).mockResolvedValue({
      decrypted: [decrypted('t2')],
      failures: [
        {
          id: 't1',
          type: 'task',
          signerDeviceId: 'device-b',
          error: 'Signature verification failed',
          isCryptoError: true,
          isSignatureError: true
        }
      ]
    })
    const deps = makeDeps()

    const outcome = await createSocketApplier(deps).apply(frame([pullItem('t1'), pullItem('t2')]))

    expect(outcome).toEqual({ kind: 'applied', applied: 1, leftToFeed: 1 })
  })

  // #2300
  it('is ineligible while paused, offline or in a full sync', async () => {
    const deps = makeDeps({ eligible: () => false })

    const outcome = await createSocketApplier(deps).apply(frame([pullItem('t1')]))

    expect(outcome).toEqual({ kind: 'skipped', reason: 'ineligible' })
    expect(decryptPullBatch).not.toHaveBeenCalled()
  })

  // #2300
  it('is covered when the frame cursor is at or below LAST_CURSOR', async () => {
    const deps = makeDeps({ appliedCursor: () => 9 })

    const outcome = await createSocketApplier(deps).apply(frame([pullItem('t1')], 9))

    expect(outcome).toEqual({ kind: 'skipped', reason: 'covered' })
    expect(deps.getVaultKey).not.toHaveBeenCalled()
  })

  // #2300: the pull can move the cursor past the frame during the decrypt.
  it('re-checks coverage after the decrypt, right before applying', async () => {
    let cursor = 4
    vi.mocked(decryptPullBatch).mockImplementation(async () => {
      cursor = 9
      return { decrypted: [decrypted('t1')], failures: [] }
    })
    const deps = makeDeps({ appliedCursor: () => cursor })

    const outcome = await createSocketApplier(deps).apply(frame([pullItem('t1')], 9))

    expect(outcome).toEqual({ kind: 'skipped', reason: 'covered' })
    expect(deps.applier.apply).not.toHaveBeenCalled()
  })

  // #2300
  it('skips quarantined items without decrypting them', async () => {
    vi.mocked(decryptPullBatch).mockResolvedValue({ decrypted: [], failures: [] })
    const deps = makeDeps({ isQuarantined: (id) => id === 't1' })

    await createSocketApplier(deps).apply(frame([pullItem('t1')]))

    expect(vi.mocked(decryptPullBatch).mock.calls[0][0]).toEqual([])
  })

  // #2300
  it('a missing FK parent leaves the item to the pull and records nothing', async () => {
    vi.mocked(decryptPullBatch).mockResolvedValue({
      decrypted: [decrypted('t1')],
      failures: []
    })
    const deps = makeDeps({
      applier: {
        apply: vi.fn(() => {
          throw new MissingSyncParentError('task', 't1', 'project', 'p1')
        })
      }
    })

    const outcome = await createSocketApplier(deps).apply(frame([pullItem('t1')]))

    expect(outcome).toEqual({ kind: 'applied', applied: 0, leftToFeed: 1 })
    expect(deps.onApplied).not.toHaveBeenCalled()
    expect(deps.suppressed).toEqual([true, false])
  })

  // #2300
  it('schema_invalid and parse_error results are left to the pull', async () => {
    vi.mocked(decryptPullBatch).mockResolvedValue({
      decrypted: [decrypted('t1'), decrypted('t2')],
      failures: []
    })
    const apply = vi.fn().mockReturnValueOnce('schema_invalid').mockReturnValueOnce('parse_error')
    const deps = makeDeps({ applier: { apply } })

    const outcome = await createSocketApplier(deps).apply(frame([pullItem('t1'), pullItem('t2')]))

    expect(outcome).toEqual({ kind: 'applied', applied: 0, leftToFeed: 2 })
    expect(deps.onApplied).not.toHaveBeenCalled()
  })

  // #2301: a local edit whose intent has not drained keeps its item for the
  // pull, which defers it and owns the `pending_intent` ledger entry. The fast
  // path has no ledger to write.
  it('a pending sync intent leaves the item to the pull and records nothing', async () => {
    vi.mocked(decryptPullBatch).mockResolvedValue({
      decrypted: [decrypted('t1'), decrypted('t2')],
      failures: []
    })
    const apply = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new PendingSyncIntentError('task', 't1')
      })
      .mockReturnValueOnce('applied')
    const deps = makeDeps({ applier: { apply } })

    const outcome = await createSocketApplier(deps).apply(frame([pullItem('t1'), pullItem('t2')]))

    expect(outcome).toEqual({ kind: 'applied', applied: 1, leftToFeed: 1 })
    expect(vi.mocked(deps.onApplied).mock.calls.map(([dec]) => dec.id)).toEqual(['t2'])
    expect(deps.onConflict).not.toHaveBeenCalled()
  })

  // #2297 / #2299: a note or journal record applied from a frame owes its whole
  // body exactly as the pull's queueBodyPull does (a durable `record` debt and
  // the unmerged flag that withholds a snapshot claim). The frame lands no body.
  it('owes the whole body of every note or journal record it changes, and nothing else', async () => {
    const note = (id: string, content: object, operation = 'update'): DecryptedPullItem => ({
      ...decrypted(id, 'note'),
      operation,
      content: JSON.stringify(content)
    })
    vi.mocked(decryptPullBatch).mockResolvedValue({
      decrypted: [
        note('n-applied', { title: 'a' }),
        note('n-skipped', { title: 'b' }),
        { ...decrypted('j-conflict', 'journal'), content: '{}' },
        note('n-binary', { fileType: 'pdf' }),
        { ...note('n-deleted', {}), deletedAt: 1_700_000_000 },
        note('n-invalid', { title: 'c' }),
        note('n-throws', { title: 'd' }),
        decrypted('t1')
      ],
      failures: []
    })
    const results: Record<string, string> = {
      'n-applied': 'applied',
      'n-skipped': 'skipped',
      'j-conflict': 'conflict',
      'n-binary': 'applied',
      'n-deleted': 'applied',
      'n-invalid': 'schema_invalid',
      t1: 'applied'
    }
    const apply = vi.fn((input: { itemId: string }) => {
      if (input.itemId === 'n-throws') throw new MissingSyncParentError('note', 'n', 'x', 'y')
      return results[input.itemId]
    })
    const deps = makeDeps({ applier: { apply } as unknown as SocketApplyDeps['applier'] })

    await createSocketApplier(deps).apply(frame([pullItem('n-applied', 'note')]))

    // #2300 review A-L3: a skipped version was owed by whatever applied it.
    expect(
      vi
        .mocked(deps.oweRecordBody)
        .mock.calls.map(([id]) => id)
        .sort()
    ).toEqual(['j-conflict', 'n-applied'])
  })

  // #2300: a merged row must still push back.
  it('a conflict reports and requests a push', async () => {
    vi.mocked(decryptPullBatch).mockResolvedValue({
      decrypted: [decrypted('t1')],
      failures: []
    })
    const deps = makeDeps({ applier: { apply: vi.fn().mockReturnValue('conflict') } })

    await createSocketApplier(deps).apply(frame([pullItem('t1')]))

    expect(deps.onConflict).toHaveBeenCalledWith(decrypted('t1'), expect.anything())
    expect(deps.requestPush).toHaveBeenCalledTimes(1)
  })

  // #2300
  it('never throws when the vault key read rejects', async () => {
    const deps = makeDeps({ getVaultKey: vi.fn().mockRejectedValue(new Error('keychain')) })

    await expect(createSocketApplier(deps).apply(frame([pullItem('t1')]))).resolves.toEqual({
      kind: 'skipped',
      reason: 'error'
    })
  })

  // #2300: the socket path joins the #2280 latency trace, one event per frame.
  it('traces e2e_latency with source socket once a pull sampled the clock offset', async () => {
    vi.mocked(decryptPullBatch).mockResolvedValue({
      decrypted: [decrypted('t1'), decrypted('t2')],
      failures: []
    })
    const deps = makeDeps()
    const applier = createSocketApplier(deps)

    await applier.apply(frame([pullItem('t1'), pullItem('t2')]))
    expect(trackMainEvent).not.toHaveBeenCalled()

    await new PullLatencyTrace(null).timeChanges(async () => ({ serverTimeMs: Date.now() }))
    await applier.apply(frame([pullItem('t1'), pullItem('t2')], 12))

    // #2300 review A-L4 / B-L4: one sample per changed item, as the pull.
    expect(trackMainEvent).toHaveBeenCalledTimes(2)
    const [name, options] = vi.mocked(trackMainEvent).mock.calls[0]
    expect(name).toBe('sync_run_completed')
    expect(options).toMatchObject({
      action: 'e2e_latency',
      source: 'socket',
      metrics: { value: 12 }
    })
    expect(Object.values(options.metrics ?? {}).every((v) => typeof v === 'number')).toBe(true)
  })

  // #2300: a frame must never interleave with a pull page's pending file flush.
  it('a frame for note X during a pull page pending flush of X writes after that flush', async () => {
    const target = path.join(userDataDir, 'notes', 'x.md')
    let releaseFlush!: () => void
    const flushHeld = new Promise<void>((resolve) => {
      releaseFlush = resolve
    })
    const realWriteFile = fs.promises.writeFile
    vi.spyOn(fs.promises, 'writeFile').mockImplementation(
      async (...args: Parameters<typeof fs.promises.writeFile>) => {
        await flushHeld
        return realWriteFile(...args)
      }
    )
    vi.mocked(decryptPullBatch).mockResolvedValue({
      decrypted: [decrypted('x', 'note')],
      failures: []
    })
    const apply = vi.fn(() => {
      writeSyncedVaultFile(target, 'v2 from the frame')
      return 'applied' as const
    })
    const deps = makeDeps({ applier: { apply } })

    const page = beginPageApply({} as DrizzleDb)
    writeSyncedVaultFile(target, 'v1 from the page')
    page.commit()
    const flushed = page.flushFiles()

    const outcome = createSocketApplier(deps).apply(frame([pullItem('x', 'note')]))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(apply).not.toHaveBeenCalled()

    releaseFlush()
    await flushed
    await expect(outcome).resolves.toEqual({ kind: 'applied', applied: 1, leftToFeed: 0 })
    expect(fs.readFileSync(target, 'utf-8')).toBe('v2 from the frame')
    expect(fs.existsSync(path.join(userDataDir, 'sync-bulk-apply-journal.json'))).toBe(false)
  })

  // #2300
  it('drops the frame when page apply does not settle in time', async () => {
    vi.useFakeTimers()
    vi.mocked(decryptPullBatch).mockResolvedValue({
      decrypted: [decrypted('t1')],
      failures: []
    })
    const deps = makeDeps()
    beginPageApply({} as DrizzleDb)

    const outcome = createSocketApplier(deps).apply(frame([pullItem('t1')]))
    await vi.advanceTimersByTimeAsync(SOCKET_APPLY_QUIESCENCE_TIMEOUT_MS + 1)

    await expect(outcome).resolves.toEqual({ kind: 'skipped', reason: 'busy' })
    expect(deps.applier.apply).not.toHaveBeenCalled()
  })

  // #2300 review A-H1 / #2385: a frame's note or journal unlink is journaled
  // with its session like a pull page's. A failed unlink stays owed and the
  // next pull's journal replay removes the file; otherwise the indexer would
  // re-adopt the orphan file and push the deleted note back.
  it.each(['note', 'journal'] as const)(
    'a frame delete of a %s whose unlink fails once stays journaled and the replay removes the file',
    async (type) => {
      const target = path.join(userDataDir, `busy-${type}`, 'n.md')
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, 'old body', 'utf-8')
      const realUnlink = fs.unlinkSync
      let failed = false
      vi.spyOn(fs, 'unlinkSync').mockImplementation((file: fs.PathLike) => {
        if (file === target && !failed) {
          failed = true
          throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
        }
        return realUnlink(file)
      })
      vi.mocked(decryptPullBatch).mockResolvedValue({
        decrypted: [{ ...decrypted('n', type), deletedAt: 1_700_000_000 }],
        failures: []
      })
      const apply = vi.fn(() => {
        deleteSyncedVaultFile(target)
        return 'applied' as const
      })

      const outcome = await createSocketApplier(makeDeps({ applier: { apply } })).apply(
        frame([pullItem('n', type)])
      )

      expect(outcome).toEqual({ kind: 'applied', applied: 1, leftToFeed: 0 })
      expect(failed).toBe(true)
      expect(fs.existsSync(target)).toBe(true)
      const journal = JSON.parse(
        fs.readFileSync(path.join(userDataDir, 'sync-bulk-apply-journal.json'), 'utf-8')
      ) as { entries: Array<{ kind?: string; absolutePath: string }> }
      expect(journal.entries).toMatchObject([{ kind: 'delete', absolutePath: target }])
      expect(isPageApplyQuiescent()).toBe(false)

      replayBulkApplyJournal()

      expect(fs.existsSync(target)).toBe(false)
      expect(isPageApplyQuiescent()).toBe(true)
    }
  )

  // #2300 review B-L1: the merged row, its conflict requeue and its body owe
  // commit together or not at all, in the pull's order. A throw costs its item
  // only: the next item applies and its conflict still requests a push.
  it('a throw from the body owe rolls its item back with its requeue, and the frame goes on', async () => {
    const raw = new Database(':memory:')
    raw.exec('CREATE TABLE merged (id TEXT); CREATE TABLE requeued (id TEXT)')
    const db = drizzle(raw) as unknown as DrizzleDb
    vi.mocked(decryptPullBatch).mockResolvedValue({
      decrypted: [
        { ...decrypted('n1', 'note'), content: '{}' },
        { ...decrypted('n2', 'note'), content: '{}' }
      ],
      failures: []
    })
    const apply = vi.fn((input: { itemId: string }, page?: { db: DrizzleDb }) => {
      page!.db.run(sql`INSERT INTO merged (id) VALUES (${input.itemId})`)
      return 'conflict' as const
    })
    const onConflict = vi.fn((dec: DecryptedPullItem) => {
      raw.prepare('INSERT INTO requeued (id) VALUES (?)').run(dec.id)
    })
    const oweRecordBody = vi.fn((noteId: string) => {
      if (noteId === 'n1') throw new Error('SQLITE_FULL')
    })
    const deps = makeDeps({
      db,
      applier: { apply } as unknown as SocketApplyDeps['applier'],
      onConflict,
      oweRecordBody
    })

    const outcome = await createSocketApplier(deps).apply(
      frame([pullItem('n1', 'note'), pullItem('n2', 'note')])
    )

    expect(outcome).toEqual({ kind: 'applied', applied: 1, leftToFeed: 1 })
    expect(raw.prepare('SELECT id FROM merged').pluck().all()).toEqual(['n2'])
    expect(raw.prepare('SELECT id FROM requeued').pluck().all()).toEqual(['n2'])
    expect(onConflict.mock.invocationCallOrder[0]).toBeLessThan(
      oweRecordBody.mock.invocationCallOrder[0]
    )
    expect(vi.mocked(deps.onApplied).mock.calls.map(([dec]) => dec.id)).toEqual(['n2'])
    expect(deps.requestPush).toHaveBeenCalledTimes(1)
    raw.close()
  })
})
