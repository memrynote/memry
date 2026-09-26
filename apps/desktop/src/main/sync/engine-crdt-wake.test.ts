import { describe, it, expect, vi, afterEach } from 'vitest'
import type { SyncSocketEvent } from '@memry/contracts/sync-socket'
import { SyncEngine, type SyncEngineDeps } from './engine'
import { NOTE_BODY_LEGACY_SWEEP_DONE, SYNC_STATE_KEYS } from './engine/sync-context'
import { createMockDeps, setupTestDb } from '@tests/utils/engine-mocks'

/**
 * #2421 review fixes (PR36 ruling): the `crdt_updated` wake keeps the note
 * unmerged until the feed passes its cursor, a wake refused during a full sync
 * is pulled when the sync ends, the flush after a pull outside a full sync
 * never strands a debt, the 60 s tick pull pays what it owed, claims need a
 * durable debt store, and a cursor another build moved re-arms the legacy
 * sweep.
 */

interface EngineInternals {
  handleWsMessage(message: SyncSocketEvent): void
  runPullTick(): void
  ctx: { fullSyncActive: boolean }
  crdtSync: {
    addPendingPull(noteId: string, reason: 'feed_owed'): void
    pullCrdtForNotes(ids: string[], signal?: AbortSignal): Promise<unknown>
    pullCrdtForNote(noteId: string): Promise<boolean>
  }
  pullCoordinator: { pull(): Promise<boolean> }
  fullSyncRunner: { run(): Promise<void>; flushPendingCrdtPulls(): void }
}

const internals = (engine: SyncEngine): EngineInternals => engine as unknown as EngineInternals

const providerStub = (active: string[] = []) =>
  ({
    isNoteLocalOnly: vi.fn(() => false),
    getOpenNoteIds: vi.fn(() => active),
    inactiveDocCapacity: 32
  }) as unknown as SyncEngineDeps['crdtProvider']

const frame = (noteId: string, cursor: number): SyncSocketEvent => ({
  kind: 'crdt_updated',
  noteId,
  cursor
})

describe('SyncEngine crdt_updated wake and debt flush (#2421 review)', () => {
  const { getDb } = setupTestDb()

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function doneEngine(overrides: Partial<SyncEngineDeps> = {}): SyncEngine {
    const engine = new SyncEngine(
      createMockDeps(getDb(), { crdtProvider: providerStub(), ...overrides })
    )
    engine.setStateValue(SYNC_STATE_KEYS.NOTE_BODY_LEGACY_SWEEP, NOTE_BODY_LEGACY_SWEEP_DONE)
    engine.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, '10')
    return engine
  }

  // #2421 ruling 1 (B-1): until LAST_CURSOR reaches the frame's cursor the
  // body is not merged, so no snapshot push may prune around it.
  it('reports a woken note unmerged until LAST_CURSOR reaches the frame cursor', () => {
    const engine = doneEngine()
    vi.spyOn(engine, 'pull').mockReturnValue(new Promise(() => {}))

    internals(engine).handleWsMessage(frame('note-w', 12))

    expect(engine.hasUnmergedRemoteCrdtState('note-w')).toBe(true)
    expect(engine.snapshotCoverage('note-w')).toEqual({ unmerged: true })

    engine.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, '12')
    expect(engine.hasUnmergedRemoteCrdtState('note-w')).toBe(false)
    expect(engine.snapshotCoverage('note-w')).toEqual({ unmerged: false, coversThrough: 12 })
  })

  // #2421 ruling 1 (A-1, B-2): a wake refused during a full sync is pulled
  // once the sync ends.
  it('pulls a wake that arrived during a full sync once the sync ends', async () => {
    const engine = doneEngine()
    const pull = vi.spyOn(engine, 'pull').mockResolvedValue(true)
    vi.spyOn(internals(engine).fullSyncRunner, 'run').mockImplementation(async () => {
      internals(engine).ctx.fullSyncActive = true
      internals(engine).handleWsMessage(frame('note-w', 12))
      internals(engine).ctx.fullSyncActive = false
    })

    await engine.fullSync()

    await vi.waitFor(() => expect(pull).toHaveBeenCalledOnce())
  })

  it('keeps a wake at or below LAST_CURSOR dropped after the full sync', async () => {
    const engine = doneEngine()
    const pull = vi.spyOn(engine, 'pull').mockResolvedValue(true)
    vi.spyOn(internals(engine).fullSyncRunner, 'run').mockImplementation(async () => {
      internals(engine).ctx.fullSyncActive = true
      internals(engine).handleWsMessage(frame('note-w', 10))
      internals(engine).ctx.fullSyncActive = false
    })

    await engine.fullSync()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(pull).not.toHaveBeenCalled()
  })

  // #2421 ruling 2 (A-2, B-3): a direct full sync that starts while a wake
  // pull runs must not strand the active editor's debt.
  it('still pays the active editor debt when a direct full sync overlaps a wake pull', async () => {
    const engine = doneEngine({ crdtProvider: providerStub(['note-a']) })
    const { crdtSync, ctx, fullSyncRunner } = internals(engine)
    crdtSync.addPendingPull('note-a', 'feed_owed')
    const paid = vi
      .spyOn(crdtSync, 'pullCrdtForNotes')
      .mockResolvedValue({ snapshotGets: 0, batchPosts: 0 })
    let pullDone!: () => void
    vi.spyOn(engine, 'pull').mockImplementation(async () => {
      // The direct full sync starts while this wake pull is in flight.
      ctx.fullSyncActive = true
      await new Promise<void>((resolve) => (pullDone = resolve))
      return true
    })

    internals(engine).handleWsMessage(frame('note-w', 12))
    await vi.waitFor(() => expect(pullDone).toBeDefined())
    pullDone()
    await new Promise((resolve) => setTimeout(resolve, 0))

    // The full sync ends and runs its own closing flush.
    ctx.fullSyncActive = false
    fullSyncRunner.flushPendingCrdtPulls()

    await vi.waitFor(() => expect(paid).toHaveBeenCalledWith(['note-a'], expect.anything()))
  })

  // #2421 ruling 3 (A-6, B-4): the 60 s tick pull pays what it owed.
  it('pays what a tick pull owed without a wake', async () => {
    const engine = doneEngine()
    const { crdtSync, pullCoordinator } = internals(engine)
    const paid = vi
      .spyOn(crdtSync, 'pullCrdtForNotes')
      .mockResolvedValue({ snapshotGets: 0, batchPosts: 0 })
    vi.spyOn(pullCoordinator, 'pull').mockImplementation(async () => {
      crdtSync.addPendingPull('note-owed', 'feed_owed')
      return true
    })

    internals(engine).runPullTick()

    await vi.waitFor(() => expect(paid).toHaveBeenCalledWith(['note-owed'], expect.anything()))
    await engine.stop({ skipFinalPush: true })
  })

  // #2421 round 2 ruling 2: a withheld id takes the update route (it may lack
  // rows at or below any cursor), and a queued pull that drops it as rowless
  // merged nothing, so the mark survives.
  it('reports a withheld id unmerged and keeps it across a rowless drop', async () => {
    const engine = doneEngine()
    const crdtSync = internals(engine).crdtSync as unknown as {
      withholdBody(noteId: string): void
      isBodyWithheld(noteId: string): boolean
      addPendingPull(noteId: string, reason: 'feed_owed'): void
      pullCrdtForNotes(ids: string[]): Promise<unknown>
    }
    crdtSync.addPendingPull('note-w', 'feed_owed')
    crdtSync.withholdBody('note-w')

    expect(engine.hasUnmergedRemoteCrdtState('note-w')).toBe(true)

    await crdtSync.pullCrdtForNotes(['note-w'])

    expect(crdtSync.isBodyWithheld('note-w')).toBe(true)
    expect(engine.hasUnmergedRemoteCrdtState('note-w')).toBe(true)
  })

  // #2421 round 2 ruling 3 (A N-2, B-1): a wake coalesced into a queued wake
  // pull keeps its cursor across a direct full sync.
  it('pulls a wake coalesced into a queued wake pull after a direct full sync', async () => {
    const engine = doneEngine()
    const pull = vi.spyOn(engine, 'pull').mockResolvedValue(true)
    const ctx = internals(engine).ctx as unknown as {
      fullSyncActive: boolean
      inFlightSync: Promise<void> | null
    }
    let release!: () => void
    ctx.inFlightSync = new Promise<void>((resolve) => (release = resolve))
    internals(engine).handleWsMessage(frame('note-1', 100))
    vi.spyOn(internals(engine).fullSyncRunner, 'run').mockImplementation(async () => {
      ctx.fullSyncActive = true
      engine.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, '105')
      internals(engine).handleWsMessage(frame('note-2', 110))
      release()
      await new Promise((resolve) => setTimeout(resolve, 0))
      ctx.fullSyncActive = false
    })

    await engine.fullSync()

    await vi.waitFor(() => expect(pull).toHaveBeenCalledTimes(2))
  })

  // #2421 round 2 ruling 3 (A N-9): a reconnect a full sync refuses pulls
  // when the sync ends.
  it('pulls after a full sync that refused a reconnect', async () => {
    const engine = doneEngine()
    const pull = vi.spyOn(engine, 'pull').mockResolvedValue(true)
    const handleWsConnected = (engine as unknown as { handleWsConnected: () => void })
      .handleWsConnected
    vi.spyOn(internals(engine).fullSyncRunner, 'run').mockImplementation(async () => {
      internals(engine).ctx.fullSyncActive = true
      handleWsConnected()
      internals(engine).ctx.fullSyncActive = false
    })

    await engine.fullSync()

    await vi.waitFor(() => expect(pull).toHaveBeenCalledOnce())
  })

  // #2421 ruling 6 (A-4, B-6): a session-only debt store cannot back a claim.
  it('claims no cursor while the debt table is unusable', () => {
    getDb().sqlite.exec('DROP TABLE crdt_body_debts')
    const engine = doneEngine()
    engine.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, '50')

    expect(engine.snapshotCoverage('note-clean')).toEqual({ unmerged: false })
  })

  // #2421 ruling 7 (B-7): another build moved LAST_CURSOR, so `done` no
  // longer holds; the legacy sweep, the per-note path and claims-off re-arm.
  it('re-arms the legacy sweep when another build moved the cursor', async () => {
    const engine = doneEngine()
    engine.setStateValue('noteBodyFeedCursor', '50')
    // An older build pulls on and moves LAST_CURSOR alone.
    getDb().sqlite.prepare("UPDATE sync_state SET value = '90' WHERE key = 'lastCursor'").run()

    const next = new SyncEngine(createMockDeps(getDb(), { crdtProvider: providerStub() }))
    vi.spyOn(next, 'fullSync').mockResolvedValue()
    await next.start()

    expect(next.getStateValue(SYNC_STATE_KEYS.NOTE_BODY_LEGACY_SWEEP)).toBeUndefined()
    await next.stop({ skipFinalPush: true })
  })

  it('records the cursor on its first run and keeps done', async () => {
    const engine = doneEngine()
    engine.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, '90')
    getDb().sqlite.prepare("DELETE FROM sync_state WHERE key = 'noteBodyFeedCursor'").run()

    const next = new SyncEngine(createMockDeps(getDb(), { crdtProvider: providerStub() }))
    vi.spyOn(next, 'fullSync').mockResolvedValue()
    await next.start()

    expect(next.getStateValue(SYNC_STATE_KEYS.NOTE_BODY_LEGACY_SWEEP)).toBe('done')
    expect(next.getStateValue('noteBodyFeedCursor')).toBe('90')
    await next.stop({ skipFinalPush: true })
  })
})
