import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SyncContext } from './sync-context'
import { CrdtSyncCoordinator } from './crdt-sync-coordinator'
import { crdtBodyDebtStore, listCrdtBodyDebts } from './crdt-body-debts'
import { asSyncDb, createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'

const fetchCrdtSnapshotMock = vi.fn()
const getFromServerMock = vi.fn()
const postToServerMock = vi.fn()
const decryptCrdtUpdateMock = vi.fn()
const secureCleanupMock = vi.fn()

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

vi.mock('../http-client', () => ({
  fetchCrdtSnapshot: (...args: unknown[]) => fetchCrdtSnapshotMock(...args),
  getFromServer: (...args: unknown[]) => getFromServerMock(...args),
  postToServer: (...args: unknown[]) => postToServerMock(...args)
}))

vi.mock('../../crypto/index', () => ({
  secureCleanup: (...args: unknown[]) => secureCleanupMock(...args)
}))

const withRetryMock = vi.fn(async (fn: () => Promise<unknown>) => ({ value: await fn() }))

vi.mock('@memry/sync-client/retry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@memry/sync-client/retry')>()),
  withRetry: (fn: () => Promise<unknown>, options?: unknown) => withRetryMock(fn, options)
}))

vi.mock('../crdt-encrypt', () => ({
  decryptCrdtUpdate: (...args: unknown[]) => decryptCrdtUpdateMock(...args)
}))

describe('CrdtSyncCoordinator', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fetchCrdtSnapshotMock.mockResolvedValue(null)
  })

  it('tracks and drains pending CRDT pulls', () => {
    const coordinator = new CrdtSyncCoordinator({ deps: {} } as unknown as SyncContext, vi.fn())

    coordinator.addPendingPull('note-1')
    coordinator.addPendingPull('note-2')
    coordinator.addPendingPull('note-1')

    expect(coordinator.pendingPullCount).toBe(2)
    expect(coordinator.drainPendingPulls()).toEqual(['note-1', 'note-2'])
    expect(coordinator.pendingPullCount).toBe(0)
  })

  it('applies single-note incrementals, skips unknown signers, and seeds empty local docs', async () => {
    const applyRemoteUpdate = vi.fn()
    const open = vi.fn().mockResolvedValue({})
    const closeIfInactive = vi.fn().mockResolvedValue(true)
    const getDoc = vi.fn().mockReturnValue(undefined)
    const getStateVector = vi.fn().mockReturnValue(new Uint8Array([1, 2]))
    const seedFromMarkdownPublic = vi.fn()

    getFromServerMock.mockResolvedValue({
      updates: [
        {
          sequenceNum: 4,
          data: 'eA==',
          createdAt: 1,
          signerDeviceId: 'missing-device'
        },
        {
          sequenceNum: 5,
          data: 'eQ==',
          createdAt: 2,
          signerDeviceId: 'device-a'
        }
      ],
      hasMore: false
    })
    decryptCrdtUpdateMock.mockReturnValue(new Uint8Array([7, 7, 7]))

    const ctx = {
      deps: {
        crdtProvider: {
          isNoteLocalOnly: vi.fn(() => false),
          getDoc,
          open,
          closeIfInactive,
          applyRemoteUpdate,
          getStateVector,
          seedFromMarkdownPublic,
          recordWholeBodyMerged: vi.fn()
        }
      },
      abortController: new AbortController()
    } as unknown as SyncContext

    const resolveDeviceKey = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(new Uint8Array([1, 2, 3]))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(new Uint8Array([1, 2, 3]))
    const coordinator = new CrdtSyncCoordinator(ctx, resolveDeviceKey)

    await coordinator.applyCrdtIncrementals('note-1', 'token-1', new Uint8Array([4, 5, 6]))

    expect(open).toHaveBeenCalledWith('note-1', undefined, { skipSeed: true })
    expect(closeIfInactive).toHaveBeenCalledWith('note-1')
    expect(getFromServerMock).toHaveBeenCalledWith(
      '/sync/crdt/updates?note_id=note-1&since=0&limit=100',
      'token-1'
    )
    expect(applyRemoteUpdate).toHaveBeenCalledWith('note-1', new Uint8Array([7, 7, 7]))
    expect(seedFromMarkdownPublic).toHaveBeenCalledWith('note-1')
  })

  it('does not close single-note incrementals that were already open', async () => {
    const openDoc = {}
    const open = vi.fn().mockResolvedValue(openDoc)
    const closeIfInactive = vi.fn()

    getFromServerMock.mockResolvedValue({
      updates: [],
      hasMore: false
    })

    const ctx = {
      deps: {
        crdtProvider: {
          isNoteLocalOnly: vi.fn(() => false),
          getDoc: vi.fn().mockReturnValue(openDoc),
          open,
          closeIfInactive,
          applyRemoteUpdate: vi.fn(),
          getStateVector: vi.fn().mockReturnValue(new Uint8Array([1, 2, 3])),
          seedFromMarkdownPublic: vi.fn(),
          recordWholeBodyMerged: vi.fn()
        }
      },
      abortController: new AbortController()
    } as unknown as SyncContext

    const coordinator = new CrdtSyncCoordinator(
      ctx,
      vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]))
    )

    await coordinator.applyCrdtIncrementals('note-1', 'token-1', new Uint8Array([4, 5, 6]))

    expect(open).toHaveBeenCalledWith('note-1', undefined, { skipSeed: true })
    expect(closeIfInactive).not.toHaveBeenCalled()
  })

  it('pullCrdtForNote exits without credentials and cleans up the vault key after pulls', async () => {
    const applyCrdtIncrementals = vi.spyOn(CrdtSyncCoordinator.prototype, 'applyCrdtIncrementals')
    applyCrdtIncrementals.mockResolvedValue(true)

    const ctx = {
      deps: {
        getAccessToken: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce('token-1')
          .mockResolvedValueOnce('token-1'),
        getVaultKey: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(new Uint8Array([9])),
        crdtProvider: { isNoteLocalOnly: vi.fn(() => false) }
      }
    } as unknown as SyncContext
    const coordinator = new CrdtSyncCoordinator(ctx, vi.fn())

    // Missing credentials must read as "not merged", not as a quiet success:
    // the pending-note replay pushes a snapshot on a `true`, and the server
    // prunes the peer's incrementals underneath it.
    await expect(coordinator.pullCrdtForNote('note-no-token')).resolves.toBe(false)
    await expect(coordinator.pullCrdtForNote('note-no-key')).resolves.toBe(false)
    await expect(coordinator.pullCrdtForNote('note-ok')).resolves.toBe(true)

    expect(applyCrdtIncrementals).toHaveBeenCalledTimes(1)
    expect(applyCrdtIncrementals).toHaveBeenCalledWith(
      'note-ok',
      'token-1',
      new Uint8Array([9]),
      expect.any(AbortSignal)
    )
    expect(secureCleanupMock).toHaveBeenCalledWith(new Uint8Array([9]))

    applyCrdtIncrementals.mockRestore()
  })

  it('uses the latest server snapshot as the batch baseline even when the local doc is non-empty', async () => {
    const applyRemoteUpdate = vi.fn()
    const open = vi.fn().mockResolvedValue({})
    const closeIfInactive = vi.fn().mockResolvedValue(true)
    const getStateVector = vi.fn().mockReturnValue(new Uint8Array([1, 2, 3, 4]))

    fetchCrdtSnapshotMock.mockResolvedValue({
      snapshot: new Uint8Array([9, 9, 9]),
      sequenceNum: 36,
      signerDeviceId: 'device-a'
    })
    postToServerMock.mockResolvedValue({
      notes: {
        'note-1': {
          updates: [],
          hasMore: false
        }
      }
    })
    decryptCrdtUpdateMock.mockReturnValue(new Uint8Array([7, 7, 7]))

    const ctx = {
      deps: {
        crdtProvider: {
          isNoteLocalOnly: vi.fn(() => false),
          inactiveDocCapacity: 32,
          getDoc: vi.fn().mockReturnValue(undefined),
          open,
          closeIfInactive,
          applyRemoteUpdate,
          getStateVector,
          seedFromMarkdownPublic: vi.fn(),
          recordWholeBodyMerged: vi.fn()
        }
      },
      abortController: new AbortController()
    } as unknown as SyncContext

    const resolveDeviceKey = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]))
    const coordinator = new CrdtSyncCoordinator(ctx, resolveDeviceKey)

    await coordinator.applyCrdtBatch(['note-1'], 'token-1', new Uint8Array([4, 5, 6]))

    expect(fetchCrdtSnapshotMock).toHaveBeenCalledWith('note-1', 'token-1')
    expect(resolveDeviceKey).toHaveBeenCalledWith('device-a')
    expect(applyRemoteUpdate).toHaveBeenCalledWith('note-1', new Uint8Array([7, 7, 7]))
    expect(postToServerMock).toHaveBeenCalledWith(
      '/sync/crdt/updates/batch',
      {
        notes: [{ noteId: 'note-1', since: 36 }],
        limit: 100
      },
      'token-1'
    )
    expect(closeIfInactive).toHaveBeenCalledWith('note-1')
  })

  it('closes only batch docs opened by sync and leaves already-open docs alone', async () => {
    const openDoc = {}
    const getDoc = vi.fn().mockReturnValueOnce(undefined).mockReturnValueOnce(openDoc)
    const closeIfInactive = vi.fn().mockResolvedValue(true)

    postToServerMock.mockResolvedValue({
      notes: {
        'sync-only-note': {
          updates: [],
          hasMore: false
        },
        'active-note': {
          updates: [],
          hasMore: false
        }
      }
    })

    const ctx = {
      deps: {
        crdtProvider: {
          isNoteLocalOnly: vi.fn(() => false),
          inactiveDocCapacity: 32,
          getDoc,
          open: vi.fn().mockResolvedValue({}),
          closeIfInactive,
          applyRemoteUpdate: vi.fn(),
          getStateVector: vi.fn().mockReturnValue(new Uint8Array([1, 2, 3])),
          seedFromMarkdownPublic: vi.fn(),
          recordWholeBodyMerged: vi.fn()
        }
      },
      abortController: new AbortController()
    } as unknown as SyncContext

    const coordinator = new CrdtSyncCoordinator(
      ctx,
      vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]))
    )

    await coordinator.applyCrdtBatch(
      ['sync-only-note', 'active-note'],
      'token-1',
      new Uint8Array([4, 5, 6])
    )

    expect(closeIfInactive).toHaveBeenCalledTimes(1)
    expect(closeIfInactive).toHaveBeenCalledWith('sync-only-note')
  })

  it('reuses the highest applied CRDT sequence as the next batch baseline', async () => {
    const applyRemoteUpdate = vi.fn()
    const open = vi.fn().mockResolvedValue({})
    const getStateVector = vi.fn().mockReturnValue(new Uint8Array([1, 2, 3, 4]))

    fetchCrdtSnapshotMock.mockResolvedValue({
      snapshot: new Uint8Array([9, 9, 9]),
      sequenceNum: 2,
      signerDeviceId: 'device-a'
    })
    postToServerMock
      .mockResolvedValueOnce({
        notes: {
          'note-1': {
            updates: [
              {
                sequenceNum: 5,
                data: 'eA==',
                createdAt: 1,
                signerDeviceId: 'device-a'
              },
              {
                sequenceNum: 6,
                data: 'eQ==',
                createdAt: 2,
                signerDeviceId: 'device-a'
              }
            ],
            hasMore: false
          }
        }
      })
      // No `snapshotMeta` on any response: this models a server that predates
      // the revision token, so every baseline below stays unconditional.
      .mockResolvedValue({
        notes: {
          'note-1': {
            updates: [],
            hasMore: false
          }
        }
      })
    decryptCrdtUpdateMock.mockReturnValue(new Uint8Array([7, 7, 7]))

    const ctx = {
      deps: {
        crdtProvider: {
          isNoteLocalOnly: vi.fn(() => false),
          inactiveDocCapacity: 32,
          getDoc: vi.fn().mockReturnValue(undefined),
          open,
          closeIfInactive: vi.fn().mockResolvedValue(true),
          applyRemoteUpdate,
          getStateVector,
          seedFromMarkdownPublic: vi.fn(),
          recordWholeBodyMerged: vi.fn()
        }
      },
      abortController: new AbortController()
    } as unknown as SyncContext

    const resolveDeviceKey = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]))
    const coordinator = new CrdtSyncCoordinator(ctx, resolveDeviceKey)

    await coordinator.applyCrdtBatch(['note-1'], 'token-1', new Uint8Array([4, 5, 6]))
    await coordinator.applyCrdtBatch(['note-1'], 'token-1', new Uint8Array([4, 5, 6]))

    expect(postToServerMock).toHaveBeenNthCalledWith(
      1,
      '/sync/crdt/updates/batch',
      {
        notes: [{ noteId: 'note-1', since: 2 }],
        limit: 100
      },
      'token-1'
    )
    // The second pass opens with a probe, and the sequence it carries is the
    // same highest-applied one — this is where the carry-over is now visible.
    expect(postToServerMock).toHaveBeenNthCalledWith(
      2,
      '/sync/crdt/updates/batch',
      {
        notes: [{ noteId: 'note-1', since: 6 }],
        limit: 1
      },
      'token-1'
    )
    // The probe came back without `snapshotMeta`, so the baseline is fetched
    // exactly as before and the apply pull resumes from the same sequence.
    expect(postToServerMock).toHaveBeenNthCalledWith(
      3,
      '/sync/crdt/updates/batch',
      {
        notes: [{ noteId: 'note-1', since: 6 }],
        limit: 100
      },
      'token-1'
    )
  })

  const createBatchContext = (): {
    ctx: SyncContext
    open: ReturnType<typeof vi.fn>
  } => {
    const open = vi.fn().mockResolvedValue({})
    const ctx = {
      deps: {
        getAccessToken: vi.fn(async () => 'token-1'),
        getVaultKey: vi.fn(async () => new Uint8Array([9])),
        crdtProvider: {
          isNoteLocalOnly: vi.fn(() => false),
          inactiveDocCapacity: 32,
          getDoc: vi.fn().mockReturnValue(undefined),
          open,
          closeIfInactive: vi.fn().mockResolvedValue(true),
          applyRemoteUpdate: vi.fn(),
          getStateVector: vi.fn().mockReturnValue(new Uint8Array([1, 2, 3, 4])),
          seedFromMarkdownPublic: vi.fn(),
          recordWholeBodyMerged: vi.fn()
        }
      },
      abortController: new AbortController()
    } as unknown as SyncContext

    return { ctx, open }
  }

  describe('#given a note the user marked local-only', () => {
    it('#then a single-note pull never reaches the server, and owes itself nothing', async () => {
      const { ctx } = createBatchContext()
      const provider = ctx.deps.crdtProvider as unknown as {
        isNoteLocalOnly: ReturnType<typeof vi.fn>
        open: ReturnType<typeof vi.fn>
      }
      provider.isNoteLocalOnly.mockImplementation((noteId: string) => noteId === 'note-local')
      const coordinator = new CrdtSyncCoordinator(ctx, vi.fn())

      // #when
      await expect(coordinator.pullCrdtForNote('note-local')).resolves.toBe(false)

      // #then #1511 closed the push half; the pull half is the same setting
      // pointing the other way. Nothing is fetched and no doc is even opened.
      expect(fetchCrdtSnapshotMock).not.toHaveBeenCalled()
      expect(getFromServerMock).not.toHaveBeenCalled()
      expect(provider.open).not.toHaveBeenCalled()

      // #and it is not owed a retry: a debt nothing can ever settle would put
      // the note back in every sweep for the life of the session.
      expect(coordinator.pendingPullCount).toBe(0)
    })

    it('#then a batch pull drops it and still pulls the notes that can sync', async () => {
      const { ctx } = createBatchContext()
      const provider = ctx.deps.crdtProvider as unknown as {
        isNoteLocalOnly: ReturnType<typeof vi.fn>
      }
      provider.isNoteLocalOnly.mockImplementation((noteId: string) => noteId === 'note-local')
      postToServerMock.mockResolvedValue({
        notes: { 'note-1': { updates: [], hasMore: false } }
      })
      const coordinator = new CrdtSyncCoordinator(ctx, vi.fn())

      // #when the paced vault sweep hands over a chunk holding both
      await coordinator.applyCrdtBatch(['note-local', 'note-1'], 'token-1', new Uint8Array([4]))

      // #then only the syncable note costs a snapshot baseline GET — the whole
      // point being that a local-only note stops spending `crdt_pull` budget.
      expect(fetchCrdtSnapshotMock).toHaveBeenCalledTimes(1)
      expect(fetchCrdtSnapshotMock).toHaveBeenCalledWith('note-1', 'token-1')
      expect(postToServerMock).toHaveBeenCalledWith(
        '/sync/crdt/updates/batch',
        { notes: [{ noteId: 'note-1', since: 0 }], limit: 100 },
        'token-1'
      )
    })

    it('#then a batch of nothing but local-only notes sends no request at all', async () => {
      const { ctx } = createBatchContext()
      const provider = ctx.deps.crdtProvider as unknown as {
        isNoteLocalOnly: ReturnType<typeof vi.fn>
      }
      provider.isNoteLocalOnly.mockReturnValue(true)
      const coordinator = new CrdtSyncCoordinator(ctx, vi.fn())

      // #when
      await coordinator.applyCrdtBatch(['note-a', 'note-b'], 'token-1', new Uint8Array([4]))

      // #then
      expect(fetchCrdtSnapshotMock).not.toHaveBeenCalled()
      expect(postToServerMock).not.toHaveBeenCalled()
    })
  })

  // A rate limit is what the desktop actually hits: the vault-wide sweep used to
  // fire two GETs per note, so 121 notes meant 242 requests in about four
  // seconds against what was then a limit of 300/60s shared with the account's
  // other devices, and 92 of those notes came back "Too many requests". The
  // bucket is now 600/60s and keyed per device, but a large enough vault still
  // reaches it, so the re-queue below is still what stops the data loss.
  const rateLimited = (): Error => {
    const err = new Error('Too many requests')
    err.name = 'RateLimitError'
    return err
  }

  it('re-queues every note in a chunk the server rate-limited', async () => {
    // #given the batch POST for the chunk is refused
    const { ctx } = createBatchContext()
    postToServerMock.mockRejectedValue(rateLimited())
    const coordinator = new CrdtSyncCoordinator(ctx, vi.fn())

    // #when
    await coordinator.applyCrdtBatch(['note-1', 'note-2'], 'token-1', new Uint8Array([4]))

    // #then the chunk failed as a unit, so every note in it is owed a retry.
    // Dropping them (a log.warn and nothing else) left those bodies stale until
    // the NEXT vault-wide sweep — a 60s reconnect floor or a 15-minute interval
    // away — and opening the note did not help, because that reads main's Y.Doc
    // rather than the server.
    expect(coordinator.drainPendingPulls()).toEqual(['note-1', 'note-2'])
  })

  it('re-queues only the note whose snapshot baseline was rate-limited', async () => {
    // #given note-2's baseline is refused; note-1 and note-3 are fine
    const { ctx } = createBatchContext()
    fetchCrdtSnapshotMock
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(rateLimited())
      .mockResolvedValueOnce(null)
    postToServerMock.mockResolvedValue({
      notes: {
        'note-1': { updates: [], hasMore: false },
        'note-3': { updates: [], hasMore: false }
      }
    })
    const coordinator = new CrdtSyncCoordinator(ctx, vi.fn())

    // #when
    await coordinator.applyCrdtBatch(['note-1', 'note-2', 'note-3'], 'token-1', new Uint8Array([4]))

    // #then the baselines are still one GET per note even on the batch path, so
    // they are the bulk of a sweep's requests and the first thing a rate limit
    // sheds. Only the note that actually failed is owed — re-queueing the whole
    // chunk would re-pull notes that already succeeded.
    expect(coordinator.drainPendingPulls()).toEqual(['note-2'])
  })

  it('re-queues a single-note pull the server rate-limited', async () => {
    // #given the `crdt_updated` / open-editor path, not the sweep
    const { ctx } = createBatchContext()
    getFromServerMock.mockRejectedValue(rateLimited())
    const coordinator = new CrdtSyncCoordinator(ctx, vi.fn())

    // #when
    await coordinator.applyCrdtIncrementals('note-1', 'token-1', new Uint8Array([4]))

    // #then the debt is not batch-specific: any pull that did not complete owes
    // the note to the next cycle. Retrying in place is what `retryOn429: false`
    // exists to prevent — three Retry-Afters of up to 60s inside a serial loop
    // stalls every remaining note behind one.
    expect(coordinator.drainPendingPulls()).toEqual(['note-1'])
  })

  it('owes the whole group when a batch pull cannot get credentials', async () => {
    // #given a sign-out / locked-vault window mid-sweep
    const { ctx } = createBatchContext()
    ;(ctx.deps.getAccessToken as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    const coordinator = new CrdtSyncCoordinator(ctx, vi.fn())

    // #when
    await coordinator.pullCrdtForNotes(['note-1', 'note-2'])

    // #then the sweep hands this method the whole vault; returning silently
    // would strand every stale body until the next sweep.
    expect(coordinator.drainPendingPulls()).toEqual(['note-1', 'note-2'])
  })

  it('batches a pull issued outside a sync cycle, when the engine holds no abort controller', async () => {
    // #given the paced sweep runs between cycles, and the engine only holds an
    // AbortController for the duration of a pull or a push
    const { ctx } = createBatchContext()
    ;(ctx as unknown as { abortController: AbortController | null }).abortController = null
    postToServerMock.mockResolvedValue({ notes: { 'note-1': { updates: [], hasMore: false } } })
    const coordinator = new CrdtSyncCoordinator(ctx, vi.fn())

    // #when
    await coordinator.pullCrdtForNotes(['note-1'])

    // #then reading ctx.abortController unconditionally made every out-of-cycle
    // batch return having done nothing, which would have made the whole paced
    // sweep a silent no-op.
    expect(postToServerMock).toHaveBeenCalledWith(
      '/sync/crdt/updates/batch',
      { notes: [{ noteId: 'note-1', since: 0 }], limit: 100 },
      'token-1'
    )
  })

  it('does not retry 429s inside the serial pull loop', async () => {
    // #given a normal batch pass
    const { ctx } = createBatchContext()
    postToServerMock.mockResolvedValue({ notes: { 'note-1': { updates: [], hasMore: false } } })
    const coordinator = new CrdtSyncCoordinator(ctx, vi.fn())

    // #when
    await coordinator.applyCrdtBatch(['note-1'], 'token-1', new Uint8Array([4, 5, 6]))

    // #then honouring Retry-After (up to 60s) x3 inside a serial loop stalls the
    // whole pass on one note; the pass cadence is the retry instead.
    expect(withRetryMock).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ retryOn429: false })
    )
  })

  it('does not retry 429s when pulling a single note incrementally', async () => {
    // #given
    const { ctx } = createBatchContext()
    getFromServerMock.mockResolvedValue({ updates: [], hasMore: false })
    const coordinator = new CrdtSyncCoordinator(ctx, vi.fn())

    // #when
    await coordinator.applyCrdtIncrementals('note-1', 'token-1', new Uint8Array([4, 5, 6]))

    // #then
    expect(withRetryMock).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ retryOn429: false })
    )
  })

  it('reports a single-note pull as unmerged when it fails, and as merged when it does not', async () => {
    // The pending-note replay gates its snapshot push on this boolean. A push
    // makes the server delete every crdt_updates row at or below it, so a pull
    // that failed must never come back as `true` — a note that skips its
    // replay is late, a note that pushes over an unfetched peer edit destroys
    // it for every device.
    const { ctx } = createBatchContext()
    const coordinator = new CrdtSyncCoordinator(ctx, vi.fn())

    getFromServerMock.mockRejectedValueOnce(rateLimited())
    await expect(
      coordinator.applyCrdtIncrementals('note-1', 'token-1', new Uint8Array([4]))
    ).resolves.toBe(false)

    getFromServerMock.mockResolvedValueOnce({ updates: [], hasMore: false })
    await expect(
      coordinator.applyCrdtIncrementals('note-1', 'token-1', new Uint8Array([4]))
    ).resolves.toBe(true)
  })

  it('keeps syncing the remaining notes when one note fails its snapshot baseline', async () => {
    // #given note-2 dead-letters while fetching its snapshot baseline
    const { ctx } = createBatchContext()
    const deadLetter = new Error('Dead letter after 4 attempts: Server error (500)')
    deadLetter.name = 'DeadLetterError'
    fetchCrdtSnapshotMock
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(deadLetter)
      .mockResolvedValueOnce(null)
    postToServerMock.mockResolvedValue({
      notes: {
        'note-1': { updates: [], hasMore: false },
        'note-3': { updates: [], hasMore: false }
      }
    })
    const coordinator = new CrdtSyncCoordinator(ctx, vi.fn())

    // #when
    await coordinator.applyCrdtBatch(['note-1', 'note-2', 'note-3'], 'token-1', new Uint8Array([4]))

    // #then one bad note must not abandon every note after it in the pass
    expect(postToServerMock).toHaveBeenCalledWith(
      '/sync/crdt/updates/batch',
      {
        notes: [
          { noteId: 'note-1', since: 0 },
          { noteId: 'note-3', since: 0 }
        ],
        limit: 100
      },
      'token-1'
    )
  })

  it('does not seed a note whose snapshot baseline failed', async () => {
    // #given note-2's baseline dead-letters; note-1 and note-3 succeed.
    // note-2 was opened with { skipSeed: true } so its state vector is empty.
    const seedFromMarkdownPublic = vi.fn()
    const getStateVector = vi.fn((noteId: string) =>
      noteId === 'note-2' ? new Uint8Array([]) : new Uint8Array([1, 2, 3, 4])
    )
    const ctx = {
      deps: {
        crdtProvider: {
          isNoteLocalOnly: vi.fn(() => false),
          inactiveDocCapacity: 32,
          getDoc: vi.fn().mockReturnValue(undefined),
          open: vi.fn().mockResolvedValue({}),
          closeIfInactive: vi.fn().mockResolvedValue(true),
          applyRemoteUpdate: vi.fn(),
          getStateVector,
          seedFromMarkdownPublic,
          recordWholeBodyMerged: vi.fn()
        }
      },
      abortController: new AbortController()
    } as unknown as SyncContext

    const deadLetter = new Error('Dead letter after 4 attempts: Server error (500)')
    deadLetter.name = 'DeadLetterError'
    fetchCrdtSnapshotMock
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(deadLetter)
      .mockResolvedValueOnce(null)
    postToServerMock.mockResolvedValue({
      notes: {
        'note-1': { updates: [], hasMore: false },
        'note-3': { updates: [], hasMore: false }
      }
    })
    const coordinator = new CrdtSyncCoordinator(ctx, vi.fn())

    // #when
    await coordinator.applyCrdtBatch(['note-1', 'note-2', 'note-3'], 'token-1', new Uint8Array([4]))

    // #then seeding note-2 would persist local markdown into its open, empty doc;
    // the next pass's real server snapshot would then merge as an independent
    // insertion → duplicated note body. Only baselined notes may be seeded.
    expect(seedFromMarkdownPublic).not.toHaveBeenCalledWith('note-2')
  })

  it('aborts the whole pass when a snapshot baseline is aborted mid-batch', async () => {
    // #given note-1's baseline is aborted (shutdown/signal), not a transient failure
    const { ctx } = createBatchContext()
    const abort = new DOMException('The operation was aborted', 'AbortError')
    fetchCrdtSnapshotMock.mockRejectedValueOnce(abort)
    const coordinator = new CrdtSyncCoordinator(ctx, vi.fn())

    // #when
    await coordinator.applyCrdtBatch(['note-1', 'note-2'], 'token-1', new Uint8Array([4]))

    // #then an abort must propagate, not be swallowed as a skipped note; the pass
    // stops before pulling any updates.
    expect(postToServerMock).not.toHaveBeenCalled()
  })

  it('splits a pass larger than the provider cache so its docs survive the pull', async () => {
    // #given five notes and room for two editor-less docs — a sign-in hands the
    // whole vault over, which is many times the real limit
    const ctx = {
      deps: {
        crdtProvider: {
          isNoteLocalOnly: vi.fn(() => false),
          inactiveDocCapacity: 2,
          getDoc: vi.fn().mockReturnValue(undefined),
          open: vi.fn().mockResolvedValue({}),
          closeIfInactive: vi.fn().mockResolvedValue(true),
          applyRemoteUpdate: vi.fn(),
          getStateVector: vi.fn().mockReturnValue(new Uint8Array([1, 2, 3, 4])),
          seedFromMarkdownPublic: vi.fn(),
          recordWholeBodyMerged: vi.fn()
        }
      },
      abortController: new AbortController()
    } as unknown as SyncContext

    postToServerMock.mockImplementation((_url: string, body: unknown) => ({
      notes: Object.fromEntries(
        (body as { notes: Array<{ noteId: string }> }).notes.map((note) => [
          note.noteId,
          { updates: [], hasMore: false }
        ])
      )
    }))
    const coordinator = new CrdtSyncCoordinator(ctx, vi.fn())

    // #when
    await coordinator.applyCrdtBatch(['n1', 'n2', 'n3', 'n4', 'n5'], 'token-1', new Uint8Array([4]))

    // #then a pass holds every one of its notes open until their updates land, so
    // one that outgrows the cache has its earliest notes closed underneath it and
    // their updates dropped as "unopened doc".
    const batched = postToServerMock.mock.calls.map(([, body]: [string, unknown]) =>
      (body as { notes: Array<{ noteId: string }> }).notes.map((note) => note.noteId)
    )
    expect(batched).toEqual([['n1', 'n2'], ['n3', 'n4'], ['n5']])
  })

  it('flags a note whose single-note pass skipped an update it could not verify', async () => {
    // #given one of two updates is signed by a device this client has no key
    // for — a revoked peer, or a device list it could not refresh
    const { ctx } = createBatchContext()
    getFromServerMock.mockResolvedValue({
      updates: [
        { sequenceNum: 4, data: 'eA==', createdAt: 1, signerDeviceId: 'gone-device' },
        { sequenceNum: 5, data: 'eQ==', createdAt: 2, signerDeviceId: 'device-a' }
      ],
      hasMore: false
    })
    decryptCrdtUpdateMock.mockReturnValue(new Uint8Array([7]))
    const resolveDeviceKey = vi.fn(async (id: string) =>
      id === 'gone-device' ? null : new Uint8Array([1, 2, 3])
    )
    const coordinator = new CrdtSyncCoordinator(ctx, resolveDeviceKey)

    // #when
    const merged = await coordinator.applyCrdtIncrementals('note-1', 'token-1', new Uint8Array([4]))

    // #then the pass still reports merged, so the pending-note replay is not
    // held back — an unresolvable signer can be permanent, and refusing to push
    // would strand this device's own offline backlog forever. The hazard is
    // carried as a flag instead, and the push path answers it by choosing the
    // endpoint that does not prune.
    expect(merged).toBe(true)
    expect(coordinator.hasUnmergedRemoteState('note-1')).toBe(true)
    // And it is owed a pull, so a signer that was only transiently unresolvable
    // (an expired token, say) is retried rather than flagged forever.
    expect(coordinator.drainPendingPulls()).toEqual(['note-1'])
  })

  it('flags a note whose server snapshot baseline could not be verified', async () => {
    // #given the note's stored snapshot is signed by an unresolvable device
    const { ctx } = createBatchContext()
    fetchCrdtSnapshotMock.mockResolvedValue({
      snapshot: new Uint8Array([9]),
      sequenceNum: 12,
      signerDeviceId: 'gone-device'
    })
    postToServerMock.mockResolvedValue({ notes: { 'note-1': { updates: [], hasMore: false } } })
    const coordinator = new CrdtSyncCoordinator(ctx, vi.fn().mockResolvedValue(null))

    // #when
    await coordinator.applyCrdtBatch(['note-1'], 'token-1', new Uint8Array([4]))

    // #then a snapshot push would overwrite the single R2 blob this pass just
    // declined to read — a larger loss than a pruned incremental, and equally
    // permanent.
    expect(coordinator.hasUnmergedRemoteState('note-1')).toBe(true)
  })

  it('flags only the batched note that skipped an unverifiable update', async () => {
    // #given note-2 carries an update from a signer this client cannot resolve
    const { ctx } = createBatchContext()
    postToServerMock.mockResolvedValue({
      notes: {
        'note-1': {
          updates: [{ sequenceNum: 3, data: 'eA==', createdAt: 1, signerDeviceId: 'device-a' }],
          hasMore: false
        },
        'note-2': {
          updates: [{ sequenceNum: 4, data: 'eQ==', createdAt: 1, signerDeviceId: 'gone-device' }],
          hasMore: false
        }
      }
    })
    decryptCrdtUpdateMock.mockReturnValue(new Uint8Array([7]))
    const resolveDeviceKey = vi.fn(async (id: string) =>
      id === 'gone-device' ? null : new Uint8Array([1, 2, 3])
    )
    const coordinator = new CrdtSyncCoordinator(ctx, resolveDeviceKey)

    // #when
    await coordinator.applyCrdtBatch(['note-1', 'note-2'], 'token-1', new Uint8Array([4]))

    // #then the flag is per note. Flagging the whole chunk would push every
    // note in a sweep onto the non-pruning path and leave the server with no
    // compaction point anywhere in the vault.
    expect(coordinator.hasUnmergedRemoteState('note-2')).toBe(true)
    expect(coordinator.hasUnmergedRemoteState('note-1')).toBe(false)
  })

  it('flags every batched note as unmerged for the whole window of its pull', async () => {
    // #given a record-page batch (#1830): the notes were just applied and are
    // already visible in the tree, but their server CRDT state has not been
    // walked yet. Unlike the sweep path, nothing else flags these.
    const { ctx } = createBatchContext()
    postToServerMock.mockResolvedValue({
      notes: {
        'note-1': { updates: [], hasMore: false },
        'note-2': { updates: [], hasMore: false }
      }
    })
    const coordinator = new CrdtSyncCoordinator(ctx, vi.fn())

    // #when the batch starts
    const batch = coordinator.applyCrdtBatch(['note-1', 'note-2'], 'token-1', new Uint8Array([4]))

    // #then both notes are flagged synchronously — before the server was ever
    // asked — so a user who opens a just-listed note mid-initial-sync and
    // types cannot route a snapshot push to the pruning endpoint in the gap.
    expect(coordinator.hasUnmergedRemoteState('note-1')).toBe(true)
    expect(coordinator.hasUnmergedRemoteState('note-2')).toBe(true)

    // #and a clean end-to-end walk clears each one, so the batch leaves no
    // permanently latched flag costing the vault its compaction points.
    await batch
    expect(coordinator.hasUnmergedRemoteState('note-1')).toBe(false)
    expect(coordinator.hasUnmergedRemoteState('note-2')).toBe(false)
  })

  it('never flags a local-only note at batch start', async () => {
    // #given a local-only note in the batch — it is filtered out of the walk,
    // so a flag raised for it would never be cleared and would blanket the
    // vault's persisted unmerged-debt key forever
    const { ctx } = createBatchContext()
    const provider = ctx.deps.crdtProvider as unknown as {
      isNoteLocalOnly: ReturnType<typeof vi.fn>
    }
    provider.isNoteLocalOnly.mockImplementation((noteId: string) => noteId === 'note-local')
    postToServerMock.mockResolvedValue({
      notes: { 'note-synced': { updates: [], hasMore: false } }
    })
    const coordinator = new CrdtSyncCoordinator(ctx, vi.fn())

    // #when
    await coordinator.applyCrdtBatch(['note-local', 'note-synced'], 'token-1', new Uint8Array([4]))

    // #then
    expect(coordinator.hasUnmergedRemoteState('note-local')).toBe(false)
    expect(coordinator.hasUnmergedRemoteState('note-synced')).toBe(false)
  })

  it('clears the flag once a later pass verifies every signer', async () => {
    // #given a pass that skipped an update because the signer was unresolvable
    const { ctx } = createBatchContext()
    getFromServerMock.mockResolvedValue({
      updates: [{ sequenceNum: 4, data: 'eA==', createdAt: 1, signerDeviceId: 'flaky-device' }],
      hasMore: false
    })
    decryptCrdtUpdateMock.mockReturnValue(new Uint8Array([7]))
    let signerResolves = false
    const resolveDeviceKey = vi.fn(async () => (signerResolves ? new Uint8Array([1, 2, 3]) : null))
    const coordinator = new CrdtSyncCoordinator(ctx, resolveDeviceKey)

    await coordinator.applyCrdtIncrementals('note-1', 'token-1', new Uint8Array([4]))
    expect(coordinator.hasUnmergedRemoteState('note-1')).toBe(true)

    // #when the signer resolves on a later pass — the transient case, which is
    // what a missing access token or an un-refreshed device list looks like.
    // Deliberately NOT via clearCaches(): that drops the flag wholesale, so a
    // test that used it would assert nothing about the clean pass.
    signerResolves = true
    await coordinator.applyCrdtIncrementals('note-1', 'token-1', new Uint8Array([4]))

    // #then the note goes back to the snapshot path. A flag that only ever
    // latched would permanently cost this note its compaction point.
    expect(coordinator.hasUnmergedRemoteState('note-1')).toBe(false)
  })

  it('keeps the flag when a pass throws after skipping an unverifiable update', async () => {
    // #given the first page skips an update, and the second page fails
    const { ctx } = createBatchContext()
    getFromServerMock
      .mockResolvedValueOnce({
        updates: [{ sequenceNum: 4, data: 'eA==', createdAt: 1, signerDeviceId: 'gone-device' }],
        hasMore: true
      })
      .mockRejectedValueOnce(rateLimited())
    const coordinator = new CrdtSyncCoordinator(ctx, vi.fn().mockResolvedValue(null))

    // #when
    await expect(
      coordinator.applyCrdtIncrementals('note-1', 'token-1', new Uint8Array([4]))
    ).resolves.toBe(false)

    // #then the flag has to survive the throw. Computing it only at the end of
    // a clean pass would leave a note that skipped an update looking safe to
    // snapshot the moment anything later in the same pass failed.
    expect(coordinator.hasUnmergedRemoteState('note-1')).toBe(true)
  })

  /**
   * #1503 — the general case of #1489. The flag is not "an unverifiable signer
   * was skipped", it is "this device has not merged the server's state for this
   * note", because that is the whole set of conditions under which a snapshot
   * push asserts a completeness it does not have.
   */
  it('flags a note whose incrementals pull was rate-limited', async () => {
    // #given the server sheds the pull — the routine way #1503 step 2 happens.
    // The per-note baselines are the bulk of a sweep's requests and the first
    // thing a rate limit takes, and `retryOn429: false` means the pass gives up
    // rather than waiting it out.
    const { ctx } = createBatchContext()
    getFromServerMock.mockRejectedValue(rateLimited())
    const coordinator = new CrdtSyncCoordinator(ctx, vi.fn())

    // #when
    await coordinator.applyCrdtIncrementals('note-1', 'token-1', new Uint8Array([4]))

    // #then a snapshot push now would run pruneUpdatesBeforeSnapshot over rows
    // this device never read. With no stored snapshot the watermark is
    // `currentSeq`, so that is every row the note has.
    expect(coordinator.hasUnmergedRemoteState('note-1')).toBe(true)
  })

  it('flags every note in a chunk whose batch pull failed', async () => {
    // #given the chunk POST is refused, which takes every note in it
    const { ctx } = createBatchContext()
    postToServerMock.mockRejectedValue(rateLimited())
    const coordinator = new CrdtSyncCoordinator(ctx, vi.fn())

    // #when
    await coordinator.applyCrdtBatch(['note-1', 'note-2'], 'token-1', new Uint8Array([4]))

    // #then both, unlike the unresolvable-signer case which is per note: here
    // the failure really is the whole chunk's, so scoping it narrower would
    // leave notes looking merged that were never fetched.
    expect(coordinator.hasUnmergedRemoteState('note-1')).toBe(true)
    expect(coordinator.hasUnmergedRemoteState('note-2')).toBe(true)
  })

  it('keeps a queued note flagged across the drain that hands it to the paced sweep', async () => {
    // #given a note the vault sweep queued, or a `crdt_updated` broadcast named
    const { ctx } = createBatchContext()
    const coordinator = new CrdtSyncCoordinator(ctx, vi.fn())
    coordinator.addPendingPull('note-1')

    // #when the cycle drains the queue — `flushPendingCrdtPulls` empties it up
    // front and then paces the actual pulls at 25 notes / 15s, so a large vault
    // spends minutes here
    expect(coordinator.drainPendingPulls()).toEqual(['note-1'])

    // #then the note is in NEITHER pendingPulls nor a completed merge, and that
    // gap is exactly where #1503 loses data: the user edits the note, the 30s
    // scheduler fires, and the snapshot prunes updates whose pull has not run.
    // Reading `pendingPulls` as the predicate would call this note safe.
    expect(coordinator.hasUnmergedRemoteState('note-1')).toBe(true)
  })

  it('clears the flag once a pass merges the note end to end', async () => {
    // #given a note flagged by a failed pull
    const { ctx } = createBatchContext()
    getFromServerMock.mockRejectedValueOnce(rateLimited())
    const coordinator = new CrdtSyncCoordinator(ctx, vi.fn())
    await coordinator.applyCrdtIncrementals('note-1', 'token-1', new Uint8Array([4]))
    expect(coordinator.hasUnmergedRemoteState('note-1')).toBe(true)

    // #when the next pass completes
    getFromServerMock.mockResolvedValue({ updates: [], hasMore: false })
    await coordinator.applyCrdtIncrementals('note-1', 'token-1', new Uint8Array([4]))

    // #then compaction resumes. A flag that only latched would be safe and
    // permanently expensive — the note would never be snapshotted again this
    // session, so the server would keep every full-state row it ever received.
    expect(coordinator.hasUnmergedRemoteState('note-1')).toBe(false)
  })

  // #2299 review round 2 (A-6, B-M2): a seeded or new doc claims again only
  // once a whole-body pull merged it.
  it('tells the provider a note merged end to end, and not one whose pass failed', async () => {
    const { ctx } = createBatchContext()
    const provider = ctx.deps.crdtProvider as unknown as {
      recordWholeBodyMerged: ReturnType<typeof vi.fn>
    }
    const coordinator = new CrdtSyncCoordinator(ctx, vi.fn())

    getFromServerMock.mockRejectedValueOnce(rateLimited())
    await coordinator.applyCrdtIncrementals('note-1', 'token-1', new Uint8Array([4]))
    expect(provider.recordWholeBodyMerged).not.toHaveBeenCalled()

    getFromServerMock.mockResolvedValue({ updates: [], hasMore: false })
    await coordinator.applyCrdtIncrementals('note-1', 'token-1', new Uint8Array([4]))
    expect(provider.recordWholeBodyMerged).toHaveBeenCalledExactlyOnceWith('note-1')

    postToServerMock.mockResolvedValue({ notes: { 'note-2': { updates: [], hasMore: false } } })
    await coordinator.applyCrdtBatch(['note-2'], 'token-1', new Uint8Array([4]))
    expect(provider.recordWholeBodyMerged).toHaveBeenLastCalledWith('note-2')
  })

  it('does not clear the flag when a new pull is owed while the pass runs', async () => {
    // #given a pass that walks the note cleanly, but a `crdt_updated` broadcast
    // for the same note lands while its incrementals are in flight
    const { ctx } = createBatchContext()
    const coordinator = new CrdtSyncCoordinator(ctx, vi.fn())
    getFromServerMock.mockImplementation(async () => {
      coordinator.addPendingPull('note-1')
      return { updates: [], hasMore: false }
    })

    // #when
    await coordinator.applyCrdtIncrementals('note-1', 'token-1', new Uint8Array([4]))

    // #then the payload that broadcast announced is by definition not in the
    // doc this pass just finished walking, so the pass may not call the note
    // merged. Clearing on its own clean result alone reopens #1503 through the
    // narrowest door in the file.
    expect(coordinator.hasUnmergedRemoteState('note-1')).toBe(true)
    getFromServerMock.mockReset()
  })

  it('does not seed from markdown when a doc was closed underneath the pass', async () => {
    // #given note-2's doc is gone by the time the pass checks it: getStateVector
    // reports null (no doc) rather than an empty vector (open but empty doc)
    const seedFromMarkdownPublic = vi.fn()
    const ctx = {
      deps: {
        crdtProvider: {
          isNoteLocalOnly: vi.fn(() => false),
          inactiveDocCapacity: 32,
          getDoc: vi.fn().mockReturnValue(undefined),
          open: vi.fn().mockResolvedValue({}),
          closeIfInactive: vi.fn().mockResolvedValue(true),
          applyRemoteUpdate: vi.fn(),
          getStateVector: vi.fn((noteId: string) =>
            noteId === 'note-2' ? null : new Uint8Array([1, 2, 3, 4])
          ),
          seedFromMarkdownPublic,
          recordWholeBodyMerged: vi.fn()
        }
      },
      abortController: new AbortController()
    } as unknown as SyncContext

    postToServerMock.mockResolvedValue({
      notes: {
        'note-1': { updates: [], hasMore: false },
        'note-2': { updates: [], hasMore: false }
      }
    })
    const coordinator = new CrdtSyncCoordinator(ctx, vi.fn())

    // #when
    await coordinator.applyCrdtBatch(['note-1', 'note-2'], 'token-1', new Uint8Array([4]))

    // #then treating a closed doc as an empty one writes this device's stale
    // markdown over a body the pass never applied — the remote edit is lost, not
    // merely stale, and the next pass has nothing left to reconcile against.
    expect(seedFromMarkdownPublic).not.toHaveBeenCalled()
  })

  // #2297: the flags are backed by `crdt_body_debts` on a real data DB.
  describe('#given durable body debts', () => {
    let testDb: TestDatabaseResult
    beforeEach(() => {
      testDb = createTestDataDb()
    })
    afterEach(() => testDb.close())

    const store = () => crdtBodyDebtStore(asSyncDb(testDb.db))
    const rows = () =>
      listCrdtBodyDebts(asSyncDb(testDb.db)).map((d) => [d.noteId, d.reason, d.failures])
    const clean = (noteId: string) =>
      postToServerMock.mockResolvedValue({ notes: { [noteId]: { updates: [], hasMore: false } } })

    it('#then a clean walk settles the debt, and teardown leaves it for the next engine', async () => {
      const { ctx } = createBatchContext()
      const coordinator = new CrdtSyncCoordinator(ctx, vi.fn(), () => true, store())
      coordinator.markRemoteStateUnmerged('note-1')
      coordinator.addPendingPull('note-2', 'feed_owed', 40)

      coordinator.clearCaches()
      expect(coordinator.hasUnmergedRemoteState('note-1')).toBe(false)
      expect(rows()).toEqual([
        ['note-1', 'broadcast', 0],
        ['note-2', 'feed_owed', 0]
      ])

      const next = new CrdtSyncCoordinator(ctx, vi.fn(), () => true, store())
      expect(next.hydrateBodyDebts()).toBe(2)
      expect(next.hasUnmergedRemoteState('note-1')).toBe(true)
      const owed = next.drainPendingPulls()
      expect(owed.sort()).toEqual(['note-1', 'note-2'])

      clean('note-1')
      await next.applyCrdtBatch(['note-1'], 'token-1', new Uint8Array([4]))
      expect(next.hasUnmergedRemoteState('note-1')).toBe(false)
      expect(rows()).toEqual([['note-2', 'feed_owed', 0]])
    })

    it('#then an unverifiable signer keeps the debt and counts the failure', async () => {
      const { ctx } = createBatchContext()
      fetchCrdtSnapshotMock.mockResolvedValue({
        snapshot: new Uint8Array([9]),
        sequenceNum: 12,
        signerDeviceId: 'gone-device'
      })
      clean('note-1')
      const coordinator = new CrdtSyncCoordinator(
        ctx,
        vi.fn().mockResolvedValue(null),
        () => true,
        store()
      )
      coordinator.oweRecordBody('note-1')

      await coordinator.applyCrdtBatch(['note-1'], 'token-1', new Uint8Array([4]))

      expect(coordinator.hasUnmergedRemoteState('note-1')).toBe(true)
      expect(rows()).toEqual([['note-1', 'record', 1]])
    })

    it('#then a debt raised while the walk ran survives the walk', async () => {
      const { ctx } = createBatchContext()
      const coordinator = new CrdtSyncCoordinator(ctx, vi.fn(), () => true, store())
      coordinator.oweRecordBody('note-1')
      postToServerMock.mockImplementation(async () => {
        // A record page for the same note commits mid-walk.
        await new Promise((resolve) => setTimeout(resolve, 5))
        coordinator.oweRecordBody('note-1')
        return { notes: { 'note-1': { updates: [], hasMore: false } } }
      })

      await coordinator.applyCrdtBatch(['note-1'], 'token-1', new Uint8Array([4]))

      expect(coordinator.hasUnmergedRemoteState('note-1')).toBe(true)
      expect(rows()).toEqual([['note-1', 'record', 0]])
    })

    it('#then a queued id with no row is settled without a pull', async () => {
      const { ctx } = createBatchContext()
      const coordinator = new CrdtSyncCoordinator(ctx, vi.fn(), () => false, store())
      coordinator.addPendingPull('gone', 'broadcast')

      await coordinator.pullCrdtForNotes(coordinator.drainPendingPulls())

      expect(postToServerMock).not.toHaveBeenCalled()
      expect(coordinator.hasUnmergedRemoteState('gone')).toBe(false)
      expect(rows()).toEqual([])
    })

    it('#then a local-only note is neither owed a record body nor drained out of its debt', async () => {
      const { ctx } = createBatchContext()
      const provider = ctx.deps.crdtProvider as unknown as {
        isNoteLocalOnly: ReturnType<typeof vi.fn>
      }
      provider.isNoteLocalOnly.mockReturnValue(true)
      const coordinator = new CrdtSyncCoordinator(ctx, vi.fn(), () => true, store())
      coordinator.oweRecordBody('note-1')
      expect(rows()).toEqual([])
      coordinator.addPendingPull('note-1', 'local_only')

      await coordinator.pullCrdtForNotes(coordinator.drainPendingPulls())

      expect(postToServerMock).not.toHaveBeenCalled()
      expect(rows()).toEqual([['note-1', 'local_only', 0]])
    })

    // #2297 restack: option (B) flags at runtime start are session-only, and a
    // dropped note's clear leaves its durable debt to the drain or the toggle.
    it('#then a full-state flag writes no debt, and a drop clears only the session flag', () => {
      const { ctx } = createBatchContext()
      const coordinator = new CrdtSyncCoordinator(ctx, vi.fn(), () => true, store())
      coordinator.flagRemoteStateUnmerged('note-full')
      coordinator.addPendingPull('note-local', 'local_only')
      coordinator.drainPendingPulls()

      expect(coordinator.hasUnmergedRemoteState('note-full')).toBe(true)
      expect(rows()).toEqual([['note-local', 'local_only', 0]])

      coordinator.clearUnmergedForDroppedNote('note-full')
      coordinator.clearUnmergedForDroppedNote('note-local')
      expect(coordinator.hasUnmergedRemoteState('note-full')).toBe(false)
      expect(coordinator.hasUnmergedRemoteState('note-local')).toBe(false)
      expect(rows()).toEqual([['note-local', 'local_only', 0]])
    })

    const failing = (noteId: string, lastFailedAt: number) =>
      store().owe([noteId], 'pull_failed', { failed: true, now: lastFailedAt })

    // #2297 review A-2, B-M1
    it('#then the drain defers a failing debt, and a sweep re-owe does not extend its backoff', () => {
      const { ctx } = createBatchContext()
      const coordinator = new CrdtSyncCoordinator(ctx, vi.fn(), () => true, store())
      const now = Date.now()
      failing('failing', now - 30_000)
      coordinator.queuePulls(['failing', 'fresh'], 'sweep')

      expect(coordinator.drainPendingPulls(now)).toEqual(['fresh'])
      expect(coordinator.pendingPullCount).toBe(0)
      expect(coordinator.hasUnmergedRemoteState('failing')).toBe(true)
      expect(coordinator.nextDeferredPullAt()).toBe(now + 30_000)
      coordinator.requeueDeferredPulls()
      expect(coordinator.pendingPullCount).toBe(1)
      expect(coordinator.drainPendingPulls(now + 30_000)).toEqual(['failing'])
    })

    // #2297 review A-2, B-M1
    it('#then a clean record-batch walk settles a backing-off note', async () => {
      const { ctx } = createBatchContext()
      const coordinator = new CrdtSyncCoordinator(ctx, vi.fn(), () => true, store())
      failing('note-1', Date.now())
      coordinator.hydrateBodyDebts()
      expect(coordinator.drainPendingPulls()).toEqual([])
      coordinator.oweRecordBody('note-1')
      clean('note-1')

      await coordinator.applyCrdtBatch(['note-1'], 'token-1', new Uint8Array([4]))

      expect(coordinator.hasUnmergedRemoteState('note-1')).toBe(false)
      expect(coordinator.nextDeferredPullAt()).toBeNull()
      expect(rows()).toEqual([])
    })

    // #2297 review A-2, B-M1
    it('#then only a failed body pull counts, and pacing noise writes no new row', async () => {
      const { ctx } = createBatchContext()
      decryptCrdtUpdateMock.mockReturnValue(new Uint8Array([7]))
      postToServerMock.mockResolvedValue({
        notes: {
          'note-1': {
            updates: [
              { sequenceNum: 4, data: 'eA==', createdAt: 1, signerDeviceId: 'gone' },
              { sequenceNum: 5, data: 'eQ==', createdAt: 1, signerDeviceId: 'gone' }
            ],
            hasMore: false
          }
        }
      })
      const coordinator = new CrdtSyncCoordinator(
        ctx,
        vi.fn(async (id: string) => (id === 'gone' ? null : new Uint8Array([1]))),
        () => true,
        store()
      )
      await coordinator.applyCrdtBatch(['note-1'], 'token-1', new Uint8Array([4]))
      expect(rows()).toEqual([['note-1', 'pull_failed', 1]])

      const { SyncServerError } = await import('@memry/sync-client/http-errors')
      const generationOf = (noteId: string) =>
        listCrdtBodyDebts(asSyncDb(testDb.db)).find((d) => d.noteId === noteId)?.generation
      coordinator.oweRecordBody('note-4')
      const recordGeneration = generationOf('note-4')!

      // A 429 on a speculative note writes no row; on a note with a record
      // debt it keeps `record`, bumps the generation and counts nothing.
      postToServerMock.mockRejectedValue(new SyncServerError('Too many requests', 429))
      await coordinator.applyCrdtBatch(['note-2', 'note-4'], 'token-1', new Uint8Array([4]))
      // A missing credential is not evidence either.
      ;(ctx.deps.getAccessToken as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null)
      await coordinator.pullCrdtForNotes(['note-3'])
      // #2297 round 2 b-M1: a failed batch POST says nothing about one note.
      postToServerMock.mockRejectedValue(new SyncServerError('Internal error', 500))
      await coordinator.applyCrdtBatch(['note-5'], 'token-1', new Uint8Array([4]))
      // Its own snapshot GET failing does: `pull_failed`, one failure.
      fetchCrdtSnapshotMock.mockRejectedValue(new SyncServerError('Internal error', 500))
      await coordinator.applyCrdtBatch(['note-6'], 'token-1', new Uint8Array([4]))

      expect(rows()).toEqual([
        ['note-1', 'pull_failed', 1],
        ['note-4', 'record', 0],
        ['note-6', 'pull_failed', 1]
      ])
      expect(generationOf('note-4')).toBeGreaterThan(recordGeneration)
      for (const noteId of ['note-2', 'note-3']) {
        expect(coordinator.hasUnmergedRemoteState(noteId)).toBe(true)
      }
      // The two counted failures wait out their backoff; the rest run now.
      expect(coordinator.drainPendingPulls().sort()).toEqual([
        'note-2',
        'note-3',
        'note-4',
        'note-5'
      ])
    })

    // #2297 round 2 a-M1: a counted failure is deferred when it is counted, so
    // it never sits in the pending count, and the runner arms its timer.
    it('#then a counted failure defers the note at once and reports it', async () => {
      const { ctx } = createBatchContext()
      const { SyncServerError } = await import('@memry/sync-client/http-errors')
      fetchCrdtSnapshotMock.mockRejectedValue(new SyncServerError('Internal error', 500))
      const coordinator = new CrdtSyncCoordinator(ctx, vi.fn(), () => true, store())
      const onDeferred = vi.fn()
      coordinator.onDeferred = onDeferred

      await coordinator.applyCrdtBatch(['note-1'], 'token-1', new Uint8Array([4]))

      expect(coordinator.pendingPullCount).toBe(0)
      expect(onDeferred).toHaveBeenCalledOnce()
      expect(coordinator.nextDeferredPullAt()).toBeGreaterThan(Date.now())
      expect(coordinator.hasUnmergedRemoteState('note-1')).toBe(true)
    })

    // #2297 round 2 b-M1: an outage behind the retry wrapper is not evidence.
    it('#then a dead letter wrapping a network error writes no row', async () => {
      const { ctx } = createBatchContext()
      const { NetworkError } = await import('@memry/sync-client/http-errors')
      const { DeadLetterError } = await import('@memry/sync-client/retry')
      fetchCrdtSnapshotMock.mockRejectedValue(
        new DeadLetterError(new NetworkError('Server unreachable'), 4)
      )
      const coordinator = new CrdtSyncCoordinator(ctx, vi.fn(), () => true, store())

      await coordinator.applyCrdtBatch(['note-1'], 'token-1', new Uint8Array([4]))

      expect(rows()).toEqual([])
      expect(coordinator.drainPendingPulls()).toEqual(['note-1'])
    })

    // #2297 round 2 b-M1: a dead letter wrapping a server error still counts.
    it('#then a dead letter wrapping a server error counts', async () => {
      const { ctx } = createBatchContext()
      const { SyncServerError } = await import('@memry/sync-client/http-errors')
      const { DeadLetterError } = await import('@memry/sync-client/retry')
      fetchCrdtSnapshotMock.mockRejectedValue(
        new DeadLetterError(new SyncServerError('Internal error', 503), 4)
      )
      const coordinator = new CrdtSyncCoordinator(ctx, vi.fn(), () => true, store())

      await coordinator.applyCrdtBatch(['note-1'], 'token-1', new Uint8Array([4]))

      expect(rows()).toEqual([['note-1', 'pull_failed', 1]])
    })

    // #2297 round 2 b-L3: a failure while the pass is being torn down is not evidence.
    it('#then a failure after the signal aborted counts nothing', async () => {
      const { ctx } = createBatchContext()
      const { SyncServerError } = await import('@memry/sync-client/http-errors')
      const controller = new AbortController()
      fetchCrdtSnapshotMock.mockImplementation(async () => {
        controller.abort()
        throw new SyncServerError('Internal error', 500)
      })
      const coordinator = new CrdtSyncCoordinator(ctx, vi.fn(), () => true, store())
      coordinator.oweRecordBody('note-1')

      await coordinator.applyCrdtBatch(
        ['note-1'],
        'token-1',
        new Uint8Array([4]),
        controller.signal
      )

      expect(rows()).toEqual([['note-1', 'record', 0]])
    })

    // #2297 round 2 b-M1: a decrypt that fails for the whole chunk names no note.
    it('#then a chunk decrypt throw counts nothing', async () => {
      const { ctx } = createBatchContext()
      decryptCrdtUpdateMock.mockImplementation(() => {
        throw new Error('decrypt failed')
      })
      postToServerMock.mockResolvedValue({
        notes: {
          'note-1': {
            updates: [{ sequenceNum: 4, data: 'eA==', createdAt: 1, signerDeviceId: 'device-a' }],
            hasMore: false
          },
          'note-2': { updates: [], hasMore: false }
        }
      })
      const coordinator = new CrdtSyncCoordinator(
        ctx,
        vi.fn(async () => new Uint8Array([1])),
        () => true,
        store()
      )
      coordinator.oweRecordBody('note-2')

      await coordinator.applyCrdtBatch(['note-1', 'note-2'], 'token-1', new Uint8Array([4]))

      expect(rows()).toEqual([['note-2', 'record', 0]])
      expect(coordinator.drainPendingPulls().sort()).toEqual(['note-1', 'note-2'])
    })

    // #2297 round 2 b-L3: one pass counts one failure, however it failed.
    it('#then a single-note pass with a signer skip and a later server error counts once', async () => {
      const { ctx } = createBatchContext()
      const { SyncServerError } = await import('@memry/sync-client/http-errors')
      fetchCrdtSnapshotMock.mockResolvedValue({
        snapshot: new Uint8Array([9]),
        sequenceNum: 12,
        signerDeviceId: 'gone-device'
      })
      getFromServerMock.mockRejectedValue(new SyncServerError('Internal error', 500))
      const coordinator = new CrdtSyncCoordinator(
        ctx,
        vi.fn().mockResolvedValue(null),
        () => true,
        store()
      )

      await coordinator.applyCrdtIncrementals('note-1', 'token-1', new Uint8Array([4]))

      expect(rows()).toEqual([['note-1', 'pull_failed', 1]])
    })

    // #2297 round 2 b-M3: an update a closing doc dropped is not in the doc.
    it('#then an update a closing doc dropped keeps the debt, the flag and no watermark', async () => {
      const { ctx } = createBatchContext()
      const watermarks = new Map<string, unknown>()
      Object.assign(ctx.deps.crdtProvider as object, {
        storeId: 'store-1',
        applyRemoteUpdate: vi.fn(() => false),
        getSnapshotWatermark: vi.fn(async () => null),
        putSnapshotWatermark: vi.fn(async (noteId: string, w: unknown) => {
          watermarks.set(noteId, w)
        }),
        forgetSnapshotWatermark: vi.fn(async (noteId: string) => {
          watermarks.delete(noteId)
        })
      })
      decryptCrdtUpdateMock.mockReturnValue(new Uint8Array([7]))
      postToServerMock.mockResolvedValue({
        notes: {
          'note-1': {
            updates: [{ sequenceNum: 4, data: 'eA==', createdAt: 1, signerDeviceId: 'device-a' }],
            hasMore: false
          }
        }
      })
      const coordinator = new CrdtSyncCoordinator(
        ctx,
        vi.fn(async () => new Uint8Array([1])),
        () => true,
        store()
      )
      coordinator.oweRecordBody('note-1')

      await coordinator.applyCrdtBatch(['note-1'], 'token-1', new Uint8Array([4]))

      expect(rows()).toEqual([['note-1', 'record', 0]])
      expect(coordinator.hasUnmergedRemoteState('note-1')).toBe(true)
      expect(watermarks.has('note-1')).toBe(false)
      expect(store().needsWalk(['note-1'])).toEqual(new Set(['note-1']))
    })

    // #2297 round 2 b-L4: a session-only flag raised while a walk ran survives it.
    it('#then a session-only flag raised mid-walk survives the walk', async () => {
      const { ctx } = createBatchContext()
      const coordinator = new CrdtSyncCoordinator(ctx, vi.fn(), () => true, store())
      postToServerMock.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        coordinator.flagRemoteStateUnmerged('note-1')
        coordinator.markRemoteStateUnmerged('note-2', false)
        return {
          notes: {
            'note-1': { updates: [], hasMore: false },
            'note-2': { updates: [], hasMore: false }
          }
        }
      })

      await coordinator.applyCrdtBatch(['note-1', 'note-2'], 'token-1', new Uint8Array([4]))

      expect(coordinator.hasUnmergedRemoteState('note-1')).toBe(true)
      expect(coordinator.hasUnmergedRemoteState('note-2')).toBe(true)

      postToServerMock.mockResolvedValue({
        notes: {
          'note-1': { updates: [], hasMore: false },
          'note-2': { updates: [], hasMore: false }
        }
      })
      await coordinator.applyCrdtBatch(['note-1', 'note-2'], 'token-1', new Uint8Array([4]))
      expect(coordinator.hasUnmergedRemoteState('note-1')).toBe(false)
      expect(coordinator.hasUnmergedRemoteState('note-2')).toBe(false)
    })
  })

  // #2297 review B-H2: a debt whose cause proves the watermark ahead of the doc
  // drops the watermark, so the probe cannot settle the note without a walk.
  describe('#given a watermark ahead of the doc', () => {
    let testDb: TestDatabaseResult
    beforeEach(() => {
      testDb = createTestDataDb()
    })
    afterEach(() => testDb.close())

    const withWatermarkStore = () => {
      const { ctx } = createBatchContext()
      const watermarks = new Map<string, { appliedSequence: number; snapshotRevision?: string }>()
      Object.assign(ctx.deps.crdtProvider as object, {
        storeId: 'store-1',
        getSnapshotWatermark: vi.fn(async (noteId: string) => watermarks.get(noteId) ?? null),
        putSnapshotWatermark: vi.fn(async (noteId: string, w: { appliedSequence: number }) => {
          watermarks.set(noteId, w)
        }),
        forgetSnapshotWatermark: vi.fn(async (noteId: string) => {
          watermarks.delete(noteId)
        })
      })
      return { ctx, watermarks }
    }
    const rows = () => listCrdtBodyDebts(asSyncDb(testDb.db)).map((d) => [d.noteId, d.reason])
    const probeWithNoUpdates = () =>
      postToServerMock.mockResolvedValue({
        notes: { 'note-1': { updates: [], hasMore: false } },
        snapshotMeta: { 'note-1': { revision: 'r1', sequenceNum: 10 } }
      })

    it('#then a compaction debt takes a walk instead of a probe settle', async () => {
      const { ctx, watermarks } = withWatermarkStore()
      watermarks.set('note-1', { appliedSequence: 50, snapshotRevision: 'r1' })
      const coordinator = new CrdtSyncCoordinator(
        ctx,
        vi.fn(),
        () => true,
        crdtBodyDebtStore(asSyncDb(testDb.db))
      )
      // Warm: the probe settles the note from its watermark, with no GET.
      probeWithNoUpdates()
      await coordinator.applyCrdtBatch(['note-1'], 'token-1', new Uint8Array([4]))
      expect(fetchCrdtSnapshotMock).not.toHaveBeenCalled()

      coordinator.oweWholeBody('note-1', 'compaction')
      fetchCrdtSnapshotMock.mockRejectedValue(new Error('server error'))
      await coordinator.applyCrdtBatch(['note-1'], 'token-1', new Uint8Array([4]))

      expect(fetchCrdtSnapshotMock).toHaveBeenCalledWith('note-1', 'token-1')
      expect(coordinator.hasUnmergedRemoteState('note-1')).toBe(true)
      expect(rows()).toEqual([['note-1', 'compaction']])
    })

    // #2297 round 2 a-L4: after a restart the persisted watermark may still be
    // the stale one; the row alone must send the note down the walk.
    it('#then a compaction row takes a walk against a stale persisted watermark', async () => {
      const { ctx, watermarks } = withWatermarkStore()
      watermarks.set('note-1', { appliedSequence: 50, snapshotRevision: 'r1' })
      const debts = crdtBodyDebtStore(asSyncDb(testDb.db))
      debts.owe(['note-1'], 'compaction', { needsWalk: true })
      const coordinator = new CrdtSyncCoordinator(ctx, vi.fn(), () => true, debts)
      coordinator.hydrateBodyDebts()
      probeWithNoUpdates()
      fetchCrdtSnapshotMock.mockRejectedValue(new Error('server error'))

      await coordinator.applyCrdtBatch(
        coordinator.drainPendingPulls(),
        'token-1',
        new Uint8Array([4])
      )

      expect(fetchCrdtSnapshotMock).toHaveBeenCalledWith('note-1', 'token-1')
      expect(coordinator.hasUnmergedRemoteState('note-1')).toBe(true)
      expect(rows()).toEqual([['note-1', 'compaction']])
    })

    // #2297 round 2 b-M3 + a-L4: a dropped update on a `record` row, then a
    // restart with the watermark the crash left behind.
    it('#then a record row with a dropped update takes a walk after a restart', async () => {
      const { ctx, watermarks } = withWatermarkStore()
      const debts = crdtBodyDebtStore(asSyncDb(testDb.db))
      decryptCrdtUpdateMock.mockReturnValue(new Uint8Array([7]))
      Object.assign(ctx.deps.crdtProvider as object, { applyRemoteUpdate: vi.fn(() => false) })
      postToServerMock.mockResolvedValue({
        notes: {
          'note-1': {
            updates: [{ sequenceNum: 4, data: 'eA==', createdAt: 1, signerDeviceId: 'device-a' }],
            hasMore: false
          }
        }
      })
      const first = new CrdtSyncCoordinator(
        ctx,
        vi.fn(async () => new Uint8Array([1])),
        () => true,
        debts
      )
      first.oweRecordBody('note-1')
      await first.applyCrdtBatch(['note-1'], 'token-1', new Uint8Array([4]))
      first.clearCaches()
      // The crash left a watermark that claims the dropped update.
      watermarks.set('note-1', { appliedSequence: 50, snapshotRevision: 'r1' })

      const second = new CrdtSyncCoordinator(ctx, vi.fn(), () => true, debts)
      second.hydrateBodyDebts()
      probeWithNoUpdates()
      fetchCrdtSnapshotMock.mockRejectedValue(new Error('server error'))
      await second.applyCrdtBatch(second.drainPendingPulls(), 'token-1', new Uint8Array([4]))

      expect(fetchCrdtSnapshotMock).toHaveBeenCalledWith('note-1', 'token-1')
      expect(second.hasUnmergedRemoteState('note-1')).toBe(true)
      expect(rows()).toEqual([['note-1', 'record']])
    })

    it('#then a skipped signer drops the watermark the rest of the pass raised', async () => {
      const { ctx, watermarks } = withWatermarkStore()
      decryptCrdtUpdateMock.mockReturnValue(new Uint8Array([7]))
      getFromServerMock.mockResolvedValue({
        updates: [
          { sequenceNum: 40, data: 'eA==', createdAt: 1, signerDeviceId: 'gone' },
          { sequenceNum: 41, data: 'eQ==', createdAt: 1, signerDeviceId: 'device-a' }
        ],
        hasMore: false
      })
      const coordinator = new CrdtSyncCoordinator(
        ctx,
        vi.fn(async (id: string) => (id === 'gone' ? null : new Uint8Array([1]))),
        () => true,
        crdtBodyDebtStore(asSyncDb(testDb.db))
      )

      await coordinator.applyCrdtIncrementals('note-1', 'token-1', new Uint8Array([4]))

      expect(watermarks.has('note-1')).toBe(false)
      probeWithNoUpdates()
      fetchCrdtSnapshotMock.mockRejectedValue(new Error('server error'))
      await coordinator.applyCrdtBatch(['note-1'], 'token-1', new Uint8Array([4]))
      expect(fetchCrdtSnapshotMock).toHaveBeenCalled()
      expect(coordinator.hasUnmergedRemoteState('note-1')).toBe(true)
    })
  })
})

describe('CrdtSyncCoordinator.clearCaches', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('drops the per-note applied-sequence cursors so a new vault starts from the server baseline', async () => {
    const applyRemoteUpdate = vi.fn()
    const crdtProvider = {
      isNoteLocalOnly: vi.fn(() => false),
      applyRemoteUpdate,
      open: vi.fn().mockResolvedValue({}),
      closeIfInactive: vi.fn().mockResolvedValue(true),
      getDoc: vi.fn().mockReturnValue({}),
      getStateVector: vi.fn().mockReturnValue(new Uint8Array([1, 2, 3])),
      seedFromMarkdownPublic: vi.fn(),
      recordWholeBodyMerged: vi.fn()
    }
    const ctx = {
      deps: { crdtProvider },
      abortController: new AbortController()
    } as unknown as SyncContext
    const coordinator = new CrdtSyncCoordinator(ctx, vi.fn().mockResolvedValue(new Uint8Array([9])))

    fetchCrdtSnapshotMock.mockResolvedValue({
      snapshot: new Uint8Array([1]),
      sequenceNum: 2,
      signerDeviceId: 'dev-1'
    })
    decryptCrdtUpdateMock.mockReturnValue(new Uint8Array([1]))
    getFromServerMock
      .mockResolvedValueOnce({
        updates: [{ sequenceNum: 7, data: 'eA==', createdAt: 0, signerDeviceId: 'dev-1' }],
        hasMore: false
      })
      .mockResolvedValue({ updates: [], hasMore: false })

    // #given — a pass that advanced this note's cursor past the snapshot baseline
    await coordinator.applyCrdtIncrementals('note-1', 'token', new Uint8Array([2]))
    coordinator.addPendingPull('note-1')
    getFromServerMock.mockClear()

    // #when — a second pass runs against the same remembered cursor
    await coordinator.applyCrdtIncrementals('note-1', 'token', new Uint8Array([2]))
    expect(getFromServerMock.mock.calls[0][0]).toContain('since=7')

    // #then — after teardown (engine.stop on vault close) the cursor is gone and
    // the next pass restarts from the server snapshot baseline
    coordinator.clearCaches()
    expect(coordinator.pendingPullCount).toBe(0)

    getFromServerMock.mockClear()
    await coordinator.applyCrdtIncrementals('note-1', 'token', new Uint8Array([2]))
    expect(getFromServerMock.mock.calls[0][0]).toContain('since=2')
  })
})
