import { describe, it, expect, vi } from 'vitest'
import type { SyncItemType } from '@memry/contracts/sync-api'
import type { SyncSocketEvent } from '@memry/contracts/sync-socket'
import { SyncEngine, type SyncEngineDeps } from './engine'
import { SYNC_STATE_KEYS } from './engine/sync-context'
import { createMockDeps, createMockNetwork, setupTestDb } from '@tests/utils/engine-mocks'
import { noteMetadata } from '@memry/db-schema/schema/note-metadata'
import { recordTombstoneClock } from '@memry/sync-client/tombstone-clocks'
import { asSyncDb } from '@tests/utils/test-db'

describe('SyncEngine', () => {
  const { getDb } = setupTestDb()
  const insertNoteRow = (id: string): void => {
    getDb()
      .db.insert(noteMetadata)
      .values({ id, path: `${id}.md`, title: id, createdAt: 'x', modifiedAt: 'x' })
      .run()
  }

  describe('#given engine with crdtProvider and CREATE note queued #when push called', () => {
    it('#then pushes CRDT snapshot BEFORE posting sync items to server', async () => {
      const callOrder: string[] = []

      const mockCrdtProvider = {
        pushSnapshotsForNotes: vi.fn().mockImplementation(async (noteIds: string[]) => {
          callOrder.push('pushSnapshot')
          return new Map(noteIds.map((id) => [id, true]))
        })
      }

      const deps = createMockDeps(getDb(), {
        crdtProvider: mockCrdtProvider as unknown as SyncEngineDeps['crdtProvider']
      })
      const engine = new SyncEngine(deps)

      insertNoteRow('note-1')
      deps.queue.enqueue({
        type: 'note',
        itemId: 'note-1',
        operation: 'create',
        payload: JSON.stringify({ title: 'Test Note' })
      })

      vi.spyOn(await import('./encrypt'), 'encryptItemForPush').mockReturnValue({
        pushItem: {
          id: 'note-1',
          type: 'note',
          operation: 'create',
          encryptedKey: 'ek',
          keyNonce: 'kn',
          encryptedData: 'ed',
          dataNonce: 'dn',
          signature: 'sig',
          signerDeviceId: 'device-1',
          clock: { 'device-1': 1 }
        },
        sizeBytes: 100
      })

      vi.spyOn(await import('./http-client'), 'postToServer').mockImplementation(async () => {
        callOrder.push('postToServer')
        return {
          accepted: ['note-1'],
          rejected: [],
          serverTime: Math.floor(Date.now() / 1000),
          maxCursor: 1
        }
      })

      await engine.push()

      expect(mockCrdtProvider.pushSnapshotsForNotes).toHaveBeenCalledWith(
        ['note-1'],
        expect.anything()
      )
      expect(callOrder).toEqual(['pushSnapshot', 'postToServer'])

      vi.restoreAllMocks()
    })

    it('#then pushes CRDT snapshot for journal CREATE items too', async () => {
      const mockCrdtProvider = {
        pushSnapshotsForNotes: vi
          .fn()
          .mockImplementation(async (noteIds: string[]) => new Map(noteIds.map((id) => [id, true])))
      }

      const deps = createMockDeps(getDb(), {
        crdtProvider: mockCrdtProvider as unknown as SyncEngineDeps['crdtProvider']
      })
      const engine = new SyncEngine(deps)

      insertNoteRow('journal-1')
      deps.queue.enqueue({
        type: 'journal',
        itemId: 'journal-1',
        operation: 'create',
        payload: JSON.stringify({ title: 'Daily Entry' })
      })

      vi.spyOn(await import('./encrypt'), 'encryptItemForPush').mockReturnValue({
        pushItem: {
          id: 'journal-1',
          type: 'journal',
          operation: 'create',
          encryptedKey: 'ek',
          keyNonce: 'kn',
          encryptedData: 'ed',
          dataNonce: 'dn',
          signature: 'sig',
          signerDeviceId: 'device-1',
          clock: { 'device-1': 1 }
        },
        sizeBytes: 100
      })

      vi.spyOn(await import('./http-client'), 'postToServer').mockResolvedValue({
        accepted: ['journal-1'],
        rejected: [],
        serverTime: Math.floor(Date.now() / 1000),
        maxCursor: 1
      })

      await engine.push()

      expect(mockCrdtProvider.pushSnapshotsForNotes).toHaveBeenCalledWith(
        ['journal-1'],
        expect.anything()
      )

      vi.restoreAllMocks()
    })
  })

  describe('#given queued note creates this device knows are deleted #when push called', () => {
    it('#then offers the server no CRDT body for them', async () => {
      const mockCrdtProvider = {
        pushSnapshotsForNotes: vi
          .fn()
          .mockImplementation(async (noteIds: string[]) => new Map(noteIds.map((id) => [id, true])))
      }
      const deps = createMockDeps(getDb(), {
        crdtProvider: mockCrdtProvider as unknown as SyncEngineDeps['crdtProvider']
      })
      const engine = new SyncEngine(deps)
      const db = getDb().db
      const tombstone = { 'device-deleter': 2 }
      const insertNote = (id: string, clock: Record<string, number> | null): void => {
        db.insert(noteMetadata)
          .values({ id, path: `${id}.md`, title: id, clock, createdAt: 'x', modifiedAt: 'x' })
          .run()
      }
      insertNote('note-concurrent', { 'device-1': 1 })
      recordTombstoneClock(asSyncDb(db), 'note', 'note-concurrent', tombstone)
      insertNote('note-recreated', { 'device-deleter': 2, 'device-1': 1 })
      recordTombstoneClock(asSyncDb(db), 'note', 'note-recreated', tombstone)
      insertNote('note-live', { 'device-1': 1 })
      for (const itemId of ['note-gone', 'note-concurrent', 'note-recreated', 'note-live']) {
        deps.queue.enqueue({ type: 'note', itemId, operation: 'create', payload: '{}' })
      }

      vi.spyOn(await import('./encrypt'), 'encryptItemForPush').mockImplementation(
        (args: { id: string; type: SyncItemType; operation: string }) => ({
          pushItem: {
            id: args.id,
            type: args.type,
            operation: 'create',
            encryptedKey: 'ek',
            keyNonce: 'kn',
            encryptedData: 'ed',
            dataNonce: 'dn',
            signature: 'sig',
            signerDeviceId: 'device-1',
            clock: { 'device-1': 1 }
          },
          sizeBytes: 100
        })
      )
      vi.spyOn(await import('./http-client'), 'postToServer').mockResolvedValue({
        accepted: ['note-gone', 'note-concurrent', 'note-recreated', 'note-live'],
        rejected: [],
        serverTime: Math.floor(Date.now() / 1000),
        maxCursor: 1
      })

      await engine.push()

      expect(mockCrdtProvider.pushSnapshotsForNotes).toHaveBeenCalledTimes(1)
      expect(mockCrdtProvider.pushSnapshotsForNotes).toHaveBeenCalledWith(
        ['note-recreated', 'note-live'],
        expect.anything()
      )

      vi.restoreAllMocks()
    })
  })

  describe('#given engine with crdtProvider and UPDATE note queued #when push called', () => {
    it('#then does NOT push CRDT snapshot (only CREATEs trigger snapshot)', async () => {
      const mockCrdtProvider = {
        pushSnapshotsForNotes: vi
          .fn()
          .mockImplementation(async (noteIds: string[]) => new Map(noteIds.map((id) => [id, true])))
      }

      const deps = createMockDeps(getDb(), {
        crdtProvider: mockCrdtProvider as unknown as SyncEngineDeps['crdtProvider']
      })
      const engine = new SyncEngine(deps)

      deps.queue.enqueue({
        type: 'note',
        itemId: 'note-1',
        operation: 'update',
        payload: JSON.stringify({ title: 'Updated' })
      })

      vi.spyOn(await import('./encrypt'), 'encryptItemForPush').mockReturnValue({
        pushItem: {
          id: 'note-1',
          type: 'note',
          operation: 'update',
          encryptedKey: 'ek',
          keyNonce: 'kn',
          encryptedData: 'ed',
          dataNonce: 'dn',
          signature: 'sig',
          signerDeviceId: 'device-1',
          clock: { 'device-1': 1 }
        },
        sizeBytes: 100
      })

      vi.spyOn(await import('./http-client'), 'postToServer').mockResolvedValue({
        accepted: ['note-1'],
        rejected: [],
        serverTime: Math.floor(Date.now() / 1000),
        maxCursor: 1
      })

      await engine.push()

      expect(mockCrdtProvider.pushSnapshotsForNotes).not.toHaveBeenCalled()

      vi.restoreAllMocks()
    })
  })

  describe('#given engine with crdtProvider and CREATE task queued #when push called', () => {
    it('#then does NOT push CRDT snapshot (only note/journal types trigger snapshot)', async () => {
      const mockCrdtProvider = {
        pushSnapshotsForNotes: vi
          .fn()
          .mockImplementation(async (noteIds: string[]) => new Map(noteIds.map((id) => [id, true])))
      }

      const deps = createMockDeps(getDb(), {
        crdtProvider: mockCrdtProvider as unknown as SyncEngineDeps['crdtProvider']
      })
      const engine = new SyncEngine(deps)

      deps.queue.enqueue({
        type: 'task',
        itemId: 'task-1',
        operation: 'create',
        payload: JSON.stringify({ title: 'New Task' })
      })

      vi.spyOn(await import('./encrypt'), 'encryptItemForPush').mockReturnValue({
        pushItem: {
          id: 'task-1',
          type: 'task',
          operation: 'create',
          encryptedKey: 'ek',
          keyNonce: 'kn',
          encryptedData: 'ed',
          dataNonce: 'dn',
          signature: 'sig',
          signerDeviceId: 'device-1',
          clock: { 'device-1': 1 }
        },
        sizeBytes: 100
      })

      vi.spyOn(await import('./http-client'), 'postToServer').mockResolvedValue({
        accepted: ['task-1'],
        rejected: [],
        serverTime: Math.floor(Date.now() / 1000),
        maxCursor: 1
      })

      await engine.push()

      expect(mockCrdtProvider.pushSnapshotsForNotes).not.toHaveBeenCalled()

      vi.restoreAllMocks()
    })
  })

  describe('#given engine with crdtProvider where snapshot push fails #when push called', () => {
    it('#then still posts sync items to server (snapshot failure is non-blocking)', async () => {
      const mockCrdtProvider = {
        pushSnapshotsForNotes: vi.fn().mockRejectedValue(new Error('network timeout'))
      }

      const deps = createMockDeps(getDb(), {
        crdtProvider: mockCrdtProvider as unknown as SyncEngineDeps['crdtProvider']
      })
      const engine = new SyncEngine(deps)

      insertNoteRow('note-1')
      deps.queue.enqueue({
        type: 'note',
        itemId: 'note-1',
        operation: 'create',
        payload: JSON.stringify({ title: 'Test' })
      })

      vi.spyOn(await import('./encrypt'), 'encryptItemForPush').mockReturnValue({
        pushItem: {
          id: 'note-1',
          type: 'note',
          operation: 'create',
          encryptedKey: 'ek',
          keyNonce: 'kn',
          encryptedData: 'ed',
          dataNonce: 'dn',
          signature: 'sig',
          signerDeviceId: 'device-1',
          clock: { 'device-1': 1 }
        },
        sizeBytes: 100
      })

      const mockPost = vi.spyOn(await import('./http-client'), 'postToServer').mockResolvedValue({
        accepted: ['note-1'],
        rejected: [],
        serverTime: Math.floor(Date.now() / 1000),
        maxCursor: 1
      })

      await engine.push()

      expect(mockCrdtProvider.pushSnapshotsForNotes).toHaveBeenCalledWith(
        ['note-1'],
        expect.anything()
      )
      expect(mockPost).toHaveBeenCalled()
      expect(deps.queue.getPendingCount()).toBe(0)

      vi.restoreAllMocks()
    })
  })

  describe('#given engine with crdtProvider and mixed batch #when push called', () => {
    it('#then only pushes CRDT snapshots for CREATE note/journal items in batch', async () => {
      const mockCrdtProvider = {
        pushSnapshotsForNotes: vi
          .fn()
          .mockImplementation(async (noteIds: string[]) => new Map(noteIds.map((id) => [id, true])))
      }

      const deps = createMockDeps(getDb(), {
        crdtProvider: mockCrdtProvider as unknown as SyncEngineDeps['crdtProvider']
      })
      const engine = new SyncEngine(deps)

      insertNoteRow('note-1')
      insertNoteRow('journal-1')
      deps.queue.enqueue({
        type: 'note',
        itemId: 'note-1',
        operation: 'create',
        payload: JSON.stringify({ title: 'New Note' })
      })
      deps.queue.enqueue({
        type: 'task',
        itemId: 'task-1',
        operation: 'create',
        payload: JSON.stringify({ title: 'New Task' })
      })
      deps.queue.enqueue({
        type: 'note',
        itemId: 'note-2',
        operation: 'update',
        payload: JSON.stringify({ title: 'Updated Note' })
      })
      deps.queue.enqueue({
        type: 'journal',
        itemId: 'journal-1',
        operation: 'create',
        payload: JSON.stringify({ title: 'Entry' })
      })

      let encryptCallCount = 0
      vi.spyOn(await import('./encrypt'), 'encryptItemForPush').mockImplementation(
        (args: { id: string; type: SyncItemType; operation: string }) => {
          encryptCallCount++
          return {
            pushItem: {
              id: args.id,
              type: args.type,
              operation: args.operation as 'create' | 'update' | 'delete',
              encryptedKey: 'ek',
              keyNonce: 'kn',
              encryptedData: 'ed',
              dataNonce: 'dn',
              signature: 'sig',
              signerDeviceId: 'device-1',
              clock: { 'device-1': 1 }
            },
            sizeBytes: 100
          }
        }
      )

      vi.spyOn(await import('./http-client'), 'postToServer').mockResolvedValue({
        accepted: ['note-1', 'task-1', 'note-2', 'journal-1'],
        rejected: [],
        serverTime: Math.floor(Date.now() / 1000),
        maxCursor: 1
      })

      await engine.push()

      // One call carrying both eligible ids, not one call per note: the whole
      // batch is what reaches the server as a single request.
      expect(mockCrdtProvider.pushSnapshotsForNotes).toHaveBeenCalledTimes(1)
      expect(mockCrdtProvider.pushSnapshotsForNotes).toHaveBeenCalledWith(
        ['note-1', 'journal-1'],
        expect.anything()
      )

      vi.restoreAllMocks()
    })
  })

  /**
   * The wire between the two halves of the #1489 fix.
   *
   * `CrdtSyncCoordinator` raises the flag and the CRDT snapshot push fn reads it
   * through `SyncEngine.hasUnmergedRemoteCrdtState` to pick an endpoint. Both
   * halves had tests, and both suites stubbed the other side — so replacing the
   * engine method with `return false` disabled the entire fix in production and
   * left all 151 sync test files green. These drive a real coordinator, a real
   * `PullCoordinator.resolveDeviceKey` and the real bridge, with no mock
   * standing between the flag being raised and the flag being read.
   */
  describe('#given a CRDT pull whose signer device key cannot be resolved', () => {
    const crdtProviderStub = (): Record<string, ReturnType<typeof vi.fn>> => ({
      isNoteLocalOnly: vi.fn(() => false),
      getDoc: vi.fn().mockReturnValue(undefined),
      open: vi.fn().mockResolvedValue({}),
      closeIfInactive: vi.fn().mockResolvedValue(true),
      applyRemoteUpdate: vi.fn(),
      getStateVector: vi.fn().mockReturnValue(new Uint8Array([1, 2, 3, 4])),
      seedFromMarkdownPublic: vi.fn(),
      recordWholeBodyMerged: vi.fn()
    })

    it('#then the engine reports the note as holding unverified server state', async () => {
      const deps = createMockDeps(getDb(), {
        crdtProvider: crdtProviderStub() as unknown as SyncEngineDeps['crdtProvider'],
        // The production trigger, unmocked from here down: a revoked peer is
        // absent from GET /auth/devices, so its key resolves to null forever.
        getDevicePublicKey: vi.fn().mockResolvedValue(null)
      })
      const engine = new SyncEngine(deps)

      vi.spyOn(await import('./http-client'), 'fetchCrdtSnapshot').mockResolvedValue(null)
      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        updates: [{ sequenceNum: 7, data: 'eA==', createdAt: 1, signerDeviceId: 'revoked-device' }],
        hasMore: false
      })

      // #when — the exact entry point the note-body outbox's full-state
      // reader uses before it pushes
      await engine.mergeRemoteCrdtForNote('note-1')

      // #then a `return false` here sends the note back to /sync/crdt/snapshot,
      // whose pruneUpdatesBeforeSnapshot deletes the row that was just skipped.
      expect(engine.hasUnmergedRemoteCrdtState('note-1')).toBe(true)

      vi.restoreAllMocks()
    })

    it('#then a `crdt_updated` broadcast marks the note before its pull runs', async () => {
      const deps = createMockDeps(getDb(), {
        crdtProvider: crdtProviderStub() as unknown as SyncEngineDeps['crdtProvider']
      })
      const engine = new SyncEngine(deps)

      // #when the server tells this device a peer wrote the note. The handler is
      // private and only bound inside `start()`, which brings up the socket, so
      // this drives the branch directly rather than standing the socket up.
      ;(
        engine as unknown as { handleWsMessage: (message: SyncSocketEvent) => void }
      ).handleWsMessage({ kind: 'crdt_updated', noteId: 'note-ws' })

      // #then the note is unmerged from this moment, not from whenever
      // `scheduleSync` gets around to the pull. In between, the 30s snapshot
      // scheduler would otherwise push a snapshot and prune the very update the
      // broadcast announced — #1503 with the server itself as the witness.
      expect(engine.hasUnmergedRemoteCrdtState('note-ws')).toBe(true)
      // #2297: and durably, so a crash before the pull keeps the note owed.
      expect(getDb().sqlite.prepare('SELECT note_id, reason FROM crdt_body_debts').all()).toEqual([
        { note_id: 'note-ws', reason: 'broadcast' }
      ])

      vi.restoreAllMocks()
    })

    // #2421: once the legacy sweep is done the feed delivers every body above
    // LAST_CURSOR, so a frame with a cursor only wakes the pull: no per-note
    // pull, no flag and no debt.
    it('#then a `crdt_updated` frame with a cursor after the legacy sweep wakes the pull, not a per-note pull', () => {
      const deps = createMockDeps(getDb(), {
        crdtProvider: crdtProviderStub() as unknown as SyncEngineDeps['crdtProvider']
      })
      const engine = new SyncEngine(deps)
      engine.setStateValue(SYNC_STATE_KEYS.NOTE_BODY_LEGACY_SWEEP, 'done')
      engine.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, '10')
      const pull = vi.spyOn(engine, 'pull').mockResolvedValue(true)
      const perNote = vi.spyOn(
        (engine as unknown as { crdtSync: { pullCrdtForNote: () => Promise<boolean> } }).crdtSync,
        'pullCrdtForNote'
      )

      ;(
        engine as unknown as { handleWsMessage: (message: SyncSocketEvent) => void }
      ).handleWsMessage({ kind: 'crdt_updated', noteId: 'note-ws', cursor: 12 })

      expect(pull).toHaveBeenCalledOnce()
      expect(perNote).not.toHaveBeenCalled()
      // Session-only, until LAST_CURSOR reaches 12 (#2421 ruling 1).
      expect(engine.hasUnmergedRemoteCrdtState('note-ws')).toBe(true)
      expect(getDb().sqlite.prepare('SELECT count(*) AS n FROM crdt_body_debts').get()).toEqual({
        n: 0
      })
      vi.restoreAllMocks()
    })

    // #2421: the wake's run pays what it owed (a feed entry past the page's GET
    // budget, a missing base) instead of leaving it to the next full sync.
    it('#then a `crdt_updated` wake pays the debts its pull owed', async () => {
      const deps = createMockDeps(getDb(), {
        crdtProvider: {
          ...crdtProviderStub(),
          getOpenNoteIds: vi.fn(() => [])
        } as unknown as SyncEngineDeps['crdtProvider']
      })
      const engine = new SyncEngine(deps)
      engine.setStateValue(SYNC_STATE_KEYS.NOTE_BODY_LEGACY_SWEEP, 'done')
      const crdtSync = (
        engine as unknown as {
          crdtSync: {
            addPendingPull: (noteId: string, reason: 'feed_owed') => void
            pullCrdtForNotes: (ids: string[]) => Promise<unknown>
          }
        }
      ).crdtSync
      const paid = vi
        .spyOn(crdtSync, 'pullCrdtForNotes')
        .mockResolvedValue({ snapshotGets: 0, batchPosts: 0 })
      vi.spyOn(engine, 'pull').mockImplementation(async () => {
        crdtSync.addPendingPull('note-owed', 'feed_owed')
        return true
      })

      ;(
        engine as unknown as { handleWsMessage: (message: SyncSocketEvent) => void }
      ).handleWsMessage({ kind: 'crdt_updated', noteId: 'note-ws', cursor: 12 })

      await vi.waitFor(() =>
        expect(paid).toHaveBeenCalledWith(['note-owed'], expect.any(AbortSignal))
      )
      await engine.stop({ skipFinalPush: true })
      vi.restoreAllMocks()
    })

    // #2421: the wake takes the #2290 filter: a cursor at or below LAST_CURSOR
    // names a write this device already pulled.
    it('#then a `crdt_updated` wake at or below LAST_CURSOR pulls nothing', () => {
      const deps = createMockDeps(getDb(), {
        crdtProvider: crdtProviderStub() as unknown as SyncEngineDeps['crdtProvider']
      })
      const engine = new SyncEngine(deps)
      engine.setStateValue(SYNC_STATE_KEYS.NOTE_BODY_LEGACY_SWEEP, 'done')
      engine.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, '12')
      const pull = vi.spyOn(engine, 'pull').mockResolvedValue(true)
      const perNote = vi.spyOn(
        (engine as unknown as { crdtSync: { pullCrdtForNote: () => Promise<boolean> } }).crdtSync,
        'pullCrdtForNote'
      )

      ;(
        engine as unknown as { handleWsMessage: (message: SyncSocketEvent) => void }
      ).handleWsMessage({ kind: 'crdt_updated', noteId: 'note-ws', cursor: 12 })

      expect(pull).not.toHaveBeenCalled()
      expect(perNote).not.toHaveBeenCalled()
      vi.restoreAllMocks()
    })

    // #2421: without the legacy key the server may not serve bodies in the
    // feed, so the frame keeps its durable per-note pull.
    it('#then a `crdt_updated` frame before the legacy sweep is done still pulls the note', () => {
      const deps = createMockDeps(getDb(), {
        crdtProvider: crdtProviderStub() as unknown as SyncEngineDeps['crdtProvider']
      })
      const engine = new SyncEngine(deps)
      const pull = vi.spyOn(engine, 'pull').mockResolvedValue(true)
      const perNote = vi
        .spyOn(
          (engine as unknown as { crdtSync: { pullCrdtForNote: () => Promise<boolean> } }).crdtSync,
          'pullCrdtForNote'
        )
        .mockResolvedValue(true)

      ;(
        engine as unknown as { handleWsMessage: (message: SyncSocketEvent) => void }
      ).handleWsMessage({ kind: 'crdt_updated', noteId: 'note-ws', cursor: 12 })

      expect(perNote).toHaveBeenCalledWith('note-ws')
      expect(pull).not.toHaveBeenCalled()
      expect(getDb().sqlite.prepare('SELECT note_id, reason FROM crdt_body_debts').all()).toEqual([
        { note_id: 'note-ws', reason: 'broadcast' }
      ])
      vi.restoreAllMocks()
    })

    // #2297 round 2, #2421: a frame without a cursor is an old server's, which
    // may not serve the body in the feed; it keeps the durable per-note pull
    // after the legacy sweep (#2421 gate 3: the per-note fallback until #2420).
    it('#then a `crdt_updated` broadcast without a cursor stays a durable per-note pull after the legacy sweep', () => {
      const deps = createMockDeps(getDb(), {
        crdtProvider: crdtProviderStub() as unknown as SyncEngineDeps['crdtProvider']
      })
      const engine = new SyncEngine(deps)
      engine.setStateValue(SYNC_STATE_KEYS.NOTE_BODY_LEGACY_SWEEP, 'done')
      const pull = vi.spyOn(engine, 'pull').mockResolvedValue(true)
      const perNote = vi
        .spyOn(
          (engine as unknown as { crdtSync: { pullCrdtForNote: () => Promise<boolean> } }).crdtSync,
          'pullCrdtForNote'
        )
        .mockResolvedValue(true)

      ;(
        engine as unknown as { handleWsMessage: (message: SyncSocketEvent) => void }
      ).handleWsMessage({ kind: 'crdt_updated', noteId: 'note-ws' })

      expect(perNote).toHaveBeenCalledWith('note-ws')
      expect(pull).not.toHaveBeenCalled()
      expect(engine.hasUnmergedRemoteCrdtState('note-ws')).toBe(true)
      expect(getDb().sqlite.prepare('SELECT note_id, reason FROM crdt_body_debts').all()).toEqual([
        { note_id: 'note-ws', reason: 'broadcast' }
      ])
      vi.restoreAllMocks()
    })

    // #2297: a debt a previous engine left routes the note around the prune
    // from the next start on, and a clean pull clears it.
    it('#then a debt left by the previous engine flags the note after a restart until a pull settles it', async () => {
      const provider = crdtProviderStub()
      const deps = createMockDeps(getDb(), {
        crdtProvider: provider as unknown as SyncEngineDeps['crdtProvider'],
        network: createMockNetwork(false)
      })
      const first = new SyncEngine(deps)
      ;(
        first as unknown as { handleWsMessage: (message: SyncSocketEvent) => void }
      ).handleWsMessage({ kind: 'crdt_updated', noteId: 'note-ws' })
      await first.stop({ skipFinalPush: true })

      const second = new SyncEngine(deps)
      expect(second.hasUnmergedRemoteCrdtState('note-ws')).toBe(false)
      await second.start()
      expect(second.hasUnmergedRemoteCrdtState('note-ws')).toBe(true)

      vi.spyOn(await import('./http-client'), 'fetchCrdtSnapshot').mockResolvedValue(null)
      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        updates: [],
        hasMore: false
      })
      await expect(second.mergeRemoteCrdtForNote('note-ws')).resolves.toBe(true)

      expect(second.hasUnmergedRemoteCrdtState('note-ws')).toBe(false)
      expect(getDb().sqlite.prepare('SELECT count(*) AS n FROM crdt_body_debts').get()).toEqual({
        n: 0
      })
      vi.restoreAllMocks()
    })

    it('#then a note whose signers all resolve is not flagged', async () => {
      const deps = createMockDeps(getDb(), {
        crdtProvider: crdtProviderStub() as unknown as SyncEngineDeps['crdtProvider'],
        getDevicePublicKey: vi.fn().mockResolvedValue(new Uint8Array(32))
      })
      const engine = new SyncEngine(deps)

      vi.spyOn(await import('./http-client'), 'fetchCrdtSnapshot').mockResolvedValue(null)
      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        updates: [{ sequenceNum: 7, data: 'eA==', createdAt: 1, signerDeviceId: 'device-1' }],
        hasMore: false
      })
      vi.spyOn(await import('./crdt-encrypt'), 'decryptCrdtUpdate').mockReturnValue(
        new Uint8Array([9])
      )

      // #when
      await engine.mergeRemoteCrdtForNote('note-2')

      // #then the safe route has to stay the exception — a bridge hard-wired to
      // `true` would cost every note in the vault its compaction point.
      expect(engine.hasUnmergedRemoteCrdtState('note-2')).toBe(false)

      vi.restoreAllMocks()
    })
  })

  /**
   * The worker decrypt path's result alignment. Worker replies tag each
   * decrypted payload with the ORIGINAL entry index, and entries whose signer
   * cannot be resolved are filtered out before the request — so the indexes
   * arrive with gaps. Mapping results back by array position instead of by
   * index handed later payloads another entry's bytes or `undefined`, which
   * aborted the whole pass where a revoked peer used to cost one skipped
   * update.
   */
  describe('#given CRDT payloads decrypted through the crypto worker', () => {
    const marker = (index: number): Uint8Array => new Uint8Array([10 + index])

    /** Replies exactly like the real worker: per-item results tagged r.index. */
    const workerBridgeStub = (): {
      isRunning: boolean
      decryptCrdtBatch: ReturnType<typeof vi.fn>
    } => ({
      isRunning: true,
      decryptCrdtBatch: vi.fn(async (items: Array<{ index: number }>) => ({
        results: items.map((item) => ({ index: item.index, update: marker(item.index) })),
        failures: []
      }))
    })

    const signerAwareKeyResolver = (): ((deviceId: string) => Promise<Uint8Array | null>) =>
      vi.fn((deviceId: string) =>
        Promise.resolve(deviceId === 'device-revoked' ? null : new Uint8Array(32))
      )

    // The batch apply sub-chunks at this, so the stub has to carry it —
    // `Math.min(undefined, 100)` is NaN and would silently slice nothing.
    const crdtProviderStub = (applyRemoteUpdate: ReturnType<typeof vi.fn>) =>
      ({
        inactiveDocCapacity: 32,
        isNoteLocalOnly: vi.fn(() => false),
        getDoc: vi.fn().mockReturnValue(undefined),
        open: vi.fn().mockResolvedValue({}),
        closeIfInactive: vi.fn().mockResolvedValue(true),
        applyRemoteUpdate,
        getStateVector: vi.fn().mockReturnValue(new Uint8Array([1, 2, 3, 4])),
        seedFromMarkdownPublic: vi.fn(),
        recordWholeBodyMerged: vi.fn()
      }) as unknown as SyncEngineDeps['crdtProvider']

    it('#then a single-note pull skips an unresolved-signer update without misaligning the good ones', async () => {
      const applyRemoteUpdate = vi.fn()
      const deps = createMockDeps(getDb(), {
        crdtProvider: crdtProviderStub(applyRemoteUpdate),
        workerBridge: workerBridgeStub() as unknown as SyncEngineDeps['workerBridge'],
        getDevicePublicKey: signerAwareKeyResolver()
      })
      const engine = new SyncEngine(deps)

      vi.spyOn(await import('./http-client'), 'fetchCrdtSnapshot').mockResolvedValue(null)
      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        updates: [
          { sequenceNum: 1, data: 'ZzE=', createdAt: 1, signerDeviceId: 'device-good' },
          { sequenceNum: 2, data: 'YmFk', createdAt: 2, signerDeviceId: 'device-revoked' },
          { sequenceNum: 3, data: 'ZzI=', createdAt: 3, signerDeviceId: 'device-good' }
        ],
        hasMore: false
      })

      // #when — the middle entry's signer is unresolvable (a revoked device),
      // leaving a gap in the payload indexes sent to the worker.
      await expect(engine.mergeRemoteCrdtForNote('note-1')).resolves.toBe(true)

      // #then both good updates applied with their OWN bytes and only the bad
      // one skipped. Position-mapped results would hand the third update
      // `undefined` and abort the pass.
      expect(
        applyRemoteUpdate.mock.calls.map(([noteId, update]) => [noteId, Array.from(update)])
      ).toEqual([
        ['note-1', [10]],
        ['note-1', [12]]
      ])

      vi.restoreAllMocks()
    })

    it('#then a batch pull aligns worker results across a filtered-signer gap too', async () => {
      const applyRemoteUpdate = vi.fn()
      const deps = createMockDeps(getDb(), {
        crdtProvider: crdtProviderStub(applyRemoteUpdate),
        workerBridge: workerBridgeStub() as unknown as SyncEngineDeps['workerBridge'],
        getDevicePublicKey: signerAwareKeyResolver()
      })
      const engine = new SyncEngine(deps)
      ;(engine as unknown as { ctx: { abortController: AbortController } }).ctx.abortController =
        new AbortController()
      // A queued pull merges only into a note this device has a row for (#2297).
      for (const id of ['note-a', 'note-b', 'note-c']) {
        getDb()
          .db.insert(noteMetadata)
          .values({ id, path: `${id}.md`, title: id, createdAt: 'x', modifiedAt: 'x' })
          .run()
      }

      // Cold vault: no watermarks, so no probe POST runs — the first batch
      // POST below IS the apply round.
      vi.spyOn(await import('./http-client'), 'fetchCrdtSnapshot').mockResolvedValue(null)
      vi.spyOn(await import('./http-client'), 'postToServer').mockResolvedValue({
        notes: {
          'note-a': {
            updates: [{ sequenceNum: 1, data: 'x', createdAt: 1, signerDeviceId: 'device-good' }],
            hasMore: false
          },
          'note-b': {
            updates: [
              { sequenceNum: 2, data: 'y', createdAt: 2, signerDeviceId: 'device-revoked' }
            ],
            hasMore: false
          },
          'note-c': {
            updates: [{ sequenceNum: 3, data: 'z', createdAt: 3, signerDeviceId: 'device-good' }],
            hasMore: false
          }
        }
      })

      const coordinator = (
        engine as unknown as { crdtSync: { pullCrdtForNotes: (ids: string[]) => Promise<unknown> } }
      ).crdtSync

      // #when — roundEntries order is a(0), b(1), c(2); b is filtered before
      // the worker sees it, so the reply carries indexes 0 and 2 only.
      await expect(
        coordinator.pullCrdtForNotes(['note-a', 'note-b', 'note-c'])
      ).resolves.toBeDefined()

      // #then — a got index 0's bytes, c got index 2's bytes, b was skipped.
      expect(
        applyRemoteUpdate.mock.calls.map(([noteId, update]) => [noteId, Array.from(update)])
      ).toEqual([
        ['note-a', [10]],
        ['note-c', [12]]
      ])

      vi.restoreAllMocks()
    })

    it('#then a transport-level worker reject falls back to byte-identical main-thread decrypt', async () => {
      const decryptSpy = vi
        .spyOn(await import('./crdt-encrypt'), 'decryptCrdtUpdate')
        .mockReturnValue(new Uint8Array([7]))
      const bridge = {
        isRunning: true,
        decryptCrdtBatch: vi.fn().mockRejectedValue(new Error('worker thread died'))
      }
      const applyRemoteUpdate = vi.fn()
      const deps = createMockDeps(getDb(), {
        crdtProvider: crdtProviderStub(applyRemoteUpdate),
        workerBridge: bridge as unknown as SyncEngineDeps['workerBridge']
      })
      const engine = new SyncEngine(deps)

      vi.spyOn(await import('./http-client'), 'fetchCrdtSnapshot').mockResolvedValue(null)
      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        updates: [{ sequenceNum: 5, data: 'eA==', createdAt: 1, signerDeviceId: 'device-good' }],
        hasMore: false
      })

      // #when — the worker transport rejects mid-flight
      await expect(engine.mergeRemoteCrdtForNote('note-1')).resolves.toBe(true)

      // #then the main-thread path produced the result, byte for byte what an
      // always-inline pass would have applied.
      expect(bridge.decryptCrdtBatch).toHaveBeenCalledTimes(1)
      expect(decryptSpy).toHaveBeenCalledTimes(1)
      expect(applyRemoteUpdate).toHaveBeenCalledWith('note-1', new Uint8Array([7]))

      vi.restoreAllMocks()
    })
  })
})
