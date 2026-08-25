import { describe, it, expect, vi } from 'vitest'
import { SyncEngine, type SyncEngineDeps } from '../engine'
import { createLogger } from '../../lib/logger'
import { SyncTimer } from '@memry/sync-client/sync-timer'
import { BOOTSTRAP_CRDT_INACTIVE_DOC_LIMIT } from './sync-context'
import { createMockDeps, setupTestDb } from '@tests/utils/engine-mocks'

vi.mock('../../lib/logger', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { createLogger: () => logger }
})

describe('PullCoordinator', () => {
  const { getDb } = setupTestDb()

  describe('#given a pull page whose server response fails schema validation #when the page is processed', () => {
    it('#then logs pull_page_dropped with the dropped item count instead of failing silently', async () => {
      const deps = createMockDeps(getDb())
      const engine = new SyncEngine(deps)
      const logger = createLogger('test') as unknown as { warn: ReturnType<typeof vi.fn> }

      vi.spyOn(await import('../http-client'), 'getFromServer').mockResolvedValue({
        items: [{ id: 'task-1', type: 'task', version: 1, modifiedAt: 1000, size: 10 }],
        deleted: ['task-2'],
        hasMore: false,
        nextCursor: 1
      })

      // Malformed: `type` isn't a recognized record sync item type, so
      // RecordPullResponseSchema.safeParse fails for the whole page.
      vi.spyOn(await import('../http-client'), 'postToServer').mockResolvedValue({
        items: [{ id: 'task-1', type: 'not_a_real_type' }]
      })

      await engine.pull()

      expect(logger.warn).toHaveBeenCalledWith('pull_page_dropped', {
        reason: 'invalid_pull_response',
        droppedCount: 2
      })

      vi.restoreAllMocks()
    })
  })
})

describe('#given a second changes page #when page one is still being applied', () => {
  const { getDb } = setupTestDb()

  it('#then the N+1 request fires before apply(N) completes', async () => {
    const deps = createMockDeps(getDb())
    const engine = new SyncEngine(deps)

    const http = await import('../http-client')
    let releasePageOnePull!: () => void
    const pageOnePullGate = new Promise<void>((resolve) => {
      releasePageOnePull = resolve
    })
    let releasePageTwoFetch!: () => void
    const pageTwoFetchGate = new Promise<void>((resolve) => {
      releasePageTwoFetch = resolve
    })

    const getSpy = vi.spyOn(http, 'getFromServer')
    getSpy.mockImplementationOnce(async () => ({
      items: [{ id: 'note-1', type: 'note', version: 1, modifiedAt: 1000, size: 10 }],
      deleted: [],
      hasMore: true,
      nextCursor: 2
    }))
    getSpy.mockImplementationOnce(async () => {
      // Held so the test can observe exactly when the request was ISSUED.
      await pageTwoFetchGate
      return { items: [], deleted: [], hasMore: false, nextCursor: 3 }
    })

    const postSpy = vi.spyOn(http, 'postToServer')
    postSpy.mockImplementationOnce(async () => {
      // Blocks the page-one apply phase mid-run.
      await pageOnePullGate
      return { items: [] }
    })

    const pullPromise = engine.pull()

    // The overlap proof: page two is already fetched WHILE page one's pull
    // POST — the apply input fetch — is still blocked. Under the old ordering
    // the second GET could not start until pullChangesPage(page one) returned,
    // which this gate prevents.
    await vi.waitFor(() => expect(getSpy).toHaveBeenCalledTimes(2))

    releasePageOnePull()
    releasePageTwoFetch()
    await expect(pullPromise).resolves.toBeUndefined()
    expect(postSpy).toHaveBeenCalledTimes(1)
    vi.restoreAllMocks()
  })
})

/**
 * The bootstrap LRU raise is gated on `ctx.fullSyncActive` so the paced vault
 * sweep — blocked while a full sync runs — can never size itself against the
 * raised capacity and then lose its docs when the page's batch reverts it.
 */
describe('#given a pull page ending in a CRDT batch #when the batch applies', () => {
  const { getDb } = setupTestDb()

  const makeProviderStub = (): Record<string, unknown> => {
    const restore = vi.fn().mockResolvedValue(undefined)
    return {
      restore,
      inactiveDocCapacity: 32,
      isNoteLocalOnly: vi.fn(() => false),
      getDoc: vi.fn().mockReturnValue(undefined),
      open: vi.fn().mockResolvedValue({}),
      closeIfInactive: vi.fn().mockResolvedValue(undefined),
      applyRemoteUpdate: vi.fn(),
      getStateVector: vi.fn().mockReturnValue(new Uint8Array([1, 2, 3, 4])),
      seedFromMarkdownPublic: vi.fn(),
      raiseInactiveDocCapacity: vi.fn(() => restore)
    }
  }

  const runBatch = async (
    fullSyncActive: boolean
  ): Promise<{ provider: Record<string, unknown>; cost: unknown }> => {
    const provider = makeProviderStub()
    const deps = createMockDeps(getDb(), {
      crdtProvider: provider as unknown as SyncEngineDeps['crdtProvider']
    })
    const engine = new SyncEngine(deps)

    // Cold vault: no watermarks, so no probe POST runs and the round below IS
    // the whole batch.
    vi.spyOn(await import('../http-client'), 'fetchCrdtSnapshot').mockResolvedValue(null)
    vi.spyOn(await import('../http-client'), 'postToServer').mockResolvedValue({ notes: {} })

    const eng = engine as unknown as {
      ctx: { fullSyncActive: boolean; abortController: AbortController | null }
      pullCoordinator: {
        applyCrdtBatch: (runState: unknown) => Promise<unknown>
      }
    }
    eng.ctx.fullSyncActive = fullSyncActive
    eng.ctx.abortController = new AbortController()

    const cost = await eng.pullCoordinator.applyCrdtBatch({
      timer: new SyncTimer(),
      startTime: Date.now(),
      pulledCount: 0,
      totalConflictsResolved: 0,
      processedIds: new Set<string>(),
      crdtNoteIds: ['note-1'],
      accessJwt: 'jwt',
      vaultKey: new Uint8Array(32)
    })
    return { provider, cost }
  }

  it('#then steady-state keeps the default 32-doc capacity', async () => {
    const { provider } = await runBatch(false)

    expect(provider.inactiveDocCapacity).toBe(32)
    expect(provider.raiseInactiveDocCapacity).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  it('#then the raise happens only while fullSyncActive, and the revert runs after', async () => {
    const { provider } = await runBatch(true)

    expect(provider.raiseInactiveDocCapacity).toHaveBeenCalledWith(
      BOOTSTRAP_CRDT_INACTIVE_DOC_LIMIT
    )
    expect(provider.restore as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1)
    vi.restoreAllMocks()
  })
})
