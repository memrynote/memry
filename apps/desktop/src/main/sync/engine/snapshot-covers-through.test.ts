import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { noteMetadata } from '@memry/db-schema/schema/note-metadata'
import { SyncEngine } from '../engine'
import { NOTE_BODY_LEGACY_SWEEP_DONE, SYNC_STATE_KEYS } from './sync-context'
import { createMockDeps, setupTestDb } from '@tests/utils/engine-mocks'
import { createCrdtSnapshotPush } from '../crdt-snapshot-push'
import { SyncServerError } from '../http-client'
import type { CrdtProvider, SnapshotCoverage } from '../crdt-provider'

vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.0', getPath: () => '/tmp/memry-snapshot-covers-through-test' }
}))

vi.mock('../../lib/logger', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { createLogger: () => logger }
})

/**
 * #2299, desktop half: a snapshot push claims `coversThrough = LAST_CURSOR`
 * only for a note with no tracked, unmerged server state, read at the encode;
 * a flagged note takes the non-pruning route whatever server it talks to. The
 * change feed, the engine and the SQLite state are real; the server is a fake
 * holding one update row per note, which prunes the way the real one does, or
 * the way a server that predates `coversThrough` does.
 */

const KNOWN = ['note-tracked', 'note-clean']

const yUpdate = (text: string): number[] => {
  const doc = new Y.Doc()
  doc.getText('t').insert(0, text)
  return [...Y.encodeStateAsUpdate(doc)]
}
const b64 = (bytes: number[]): string => Buffer.from(bytes).toString('base64')

const body = (noteId: string, cursor: number, data?: number[]): Record<string, unknown> => ({
  op: 'update',
  noteId,
  cursor,
  sequenceNum: cursor,
  signerDeviceId: 'device-2',
  createdAt: 1,
  size: data?.length ?? 5000,
  ...(data ? { data: b64(data) } : {})
})

function fakeProvider() {
  const open = new Set<string>()
  return {
    isNoteLocalOnly: vi.fn(() => false),
    hasPersistence: vi.fn(() => true),
    getSnapshotWatermark: vi.fn(async () => null),
    putSnapshotWatermark: vi.fn(async () => {}),
    getDoc: vi.fn(() => undefined),
    getStateVector: vi.fn((noteId: string) =>
      open.has(noteId) ? new Uint8Array([1, 9, 1]) : null
    ),
    open: vi.fn(async (noteId: string) => {
      open.add(noteId)
    }),
    closeIfInactive: vi.fn(async (noteId: string) => open.delete(noteId)),
    mergeRemoteUpdate: vi.fn(async () => true),
    withholdClaimUntilPulled: vi.fn()
  }
}

/**
 * The server's update log: rows `{ noteId, cursor }`. `pushCrdtSnapshot`
 * prunes a note's rows at or below `coversThrough` (this server) or all of
 * them, as a first snapshot does on a server that ignores the field.
 */
function fakeServer(mode: 'covers-through' | 'predates-covers-through') {
  const rows = [
    { noteId: 'note-tracked', cursor: 40 },
    { noteId: 'note-clean', cursor: 45 }
  ]
  const calls: Array<{ route: 'snapshot' | 'updates'; noteId: string; coversThrough?: number }> = []
  const prune = (noteId: string, coversThrough?: number): void => {
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i]
      if (row.noteId !== noteId) continue
      if (mode === 'covers-through' && coversThrough === undefined) continue
      if (mode === 'covers-through' && row.cursor > (coversThrough as number)) continue
      rows.splice(i, 1)
    }
  }
  return {
    rows,
    calls,
    pushCrdtSnapshot: async (
      noteId: string,
      _snapshot: Uint8Array,
      _token: string,
      claim: { coversThrough?: number } = {}
    ) => {
      const { coversThrough } = claim
      calls.push({ route: 'snapshot', noteId, coversThrough })
      prune(noteId, coversThrough)
      return { sequenceNum: 1, revision: 'rev' }
    },
    pushCrdtFullUpdate: async (noteId: string) => {
      calls.push({ route: 'updates', noteId })
      return {}
    }
  }
}

async function wire(server: ReturnType<typeof fakeServer>, pages: Array<Record<string, unknown>>) {
  const http = await import('../http-client')
  let pageIndex = 0
  vi.spyOn(http, 'getFromServer').mockImplementation(async (url: string) => {
    if (url.startsWith('/sync/changes')) {
      const page = pages[Math.min(pageIndex++, pages.length - 1)]
      return { items: [], deleted: [], hasMore: pageIndex < pages.length, ...page }
    }
    // Every ref GET fails: the failure that leaves a body tracked but
    // unapplied while the cursor moves past it. A 4xx, so no retry backoff.
    if (url.startsWith('/sync/crdt/updates?')) throw new SyncServerError('gone', 404)
    throw new Error(`unexpected GET ${url}`)
  })
  vi.spyOn(http, 'postToServer').mockResolvedValue({ items: [] })
  vi.spyOn(http, 'pushCrdtSnapshot').mockImplementation(server.pushCrdtSnapshot)
  vi.spyOn(http, 'pushCrdtFullUpdate').mockImplementation(server.pushCrdtFullUpdate)
  vi.spyOn(await import('../crdt-encrypt'), 'decryptCrdtUpdate').mockImplementation((p) => p)
  vi.spyOn(await import('../crdt-encrypt'), 'encryptCrdtUpdate').mockImplementation((s) => s)
}

function engineWith(
  getDb: ReturnType<typeof setupTestDb>['getDb'],
  provider = fakeProvider()
): SyncEngine {
  const db = getDb()
  for (const id of KNOWN) {
    const row = { id, path: `${id}.md`, title: id, createdAt: 'x', modifiedAt: 'x' }
    db.db.insert(noteMetadata).values(row).onConflictDoNothing().run()
  }
  const engine = new SyncEngine(
    createMockDeps(db, { crdtProvider: provider as unknown as CrdtProvider })
  )
  engine.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, '39')
  engine.setStateValue(SYNC_STATE_KEYS.NOTE_BODY_LEGACY_SWEEP, NOTE_BODY_LEGACY_SWEEP_DONE)
  // A session that started with no carried-over debt: the runner latches that
  // answer on its first read, which a running session has long made.
  expect(engine.hasUnmergedRemoteCrdtState('note-clean')).toBe(false)
  return engine
}

function pushFor(engine: SyncEngine) {
  return createCrdtSnapshotPush({
    getAccessToken: async () => 'token',
    getVaultKey: async () => new Uint8Array(32),
    getSigningKey: async () => new Uint8Array(64),
    authRetryDeps: { refreshAccessToken: async () => false, getAccessToken: async () => 'token' },
    hasUnmergedRemoteState: (noteId) => engine.hasUnmergedRemoteCrdtState(noteId),
    onNotCovered: (noteId, refusal) => engine.recordSnapshotRefusal(noteId, refusal),
    onPushed: () => undefined,
    onError: () => undefined
  })
}

/** The provider's order: coverage first, then the encode, then the send. */
const snapshot = (engine: SyncEngine, noteId: string): [string, Uint8Array, SnapshotCoverage] => [
  noteId,
  new Uint8Array(yUpdate(noteId)),
  engine.snapshotCoverage(noteId)
]

describe('snapshot push coverage from the change feed (#2299)', () => {
  const { getDb } = setupTestDb()

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const feedPage = {
    noteBodies: [body('note-tracked', 40), body('note-clean', 45, yUpdate('clean'))],
    nextCursor: 50
  }

  // #2299 review: tracked-unapplied body at cursor 40, LAST_CURSOR = 50.
  it('never prunes a tracked-unapplied body at cursor 40 once LAST_CURSOR is 50', async () => {
    const engine = engineWith(getDb)
    const server = fakeServer('covers-through')
    await wire(server, [feedPage])

    await engine.pull()
    expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('50')

    await pushFor(engine)(...snapshot(engine, 'note-tracked'))

    expect(server.calls).toEqual([{ route: 'updates', noteId: 'note-tracked' }])
    expect(server.rows).toContainEqual({ noteId: 'note-tracked', cursor: 40 })
  })

  it('claims LAST_CURSOR for a note whose bodies all landed, and the server prunes through it', async () => {
    const engine = engineWith(getDb)
    const server = fakeServer('covers-through')
    await wire(server, [feedPage])
    await engine.pull()

    await pushFor(engine)(...snapshot(engine, 'note-clean'))

    expect(server.calls).toEqual([{ route: 'snapshot', noteId: 'note-clean', coversThrough: 50 }])
    expect(server.rows).toEqual([{ noteId: 'note-tracked', cursor: 40 }])
  })

  // #2299: a server that predates coversThrough prunes by watermark, so the
  // tracked note must never reach its snapshot route at all.
  it('keeps the tracked body safe on a server that ignores coversThrough', async () => {
    const engine = engineWith(getDb)
    const server = fakeServer('predates-covers-through')
    await wire(server, [feedPage])
    await engine.pull()

    await pushFor(engine)(...snapshot(engine, 'note-tracked'))

    expect(server.calls.map((call) => call.route)).toEqual(['updates'])
    expect(server.rows).toContainEqual({ noteId: 'note-tracked', cursor: 40 })
  })

  it('claims no cursor before the legacy sweep is done, and none at all on a fresh cursor', async () => {
    const engine = engineWith(getDb)
    engine.setStateValue(SYNC_STATE_KEYS.NOTE_BODY_LEGACY_SWEEP, 'pending')
    expect(engine.snapshotCoverage('note-clean')).toEqual({ unmerged: false })

    engine.setStateValue(SYNC_STATE_KEYS.NOTE_BODY_LEGACY_SWEEP, NOTE_BODY_LEGACY_SWEEP_DONE)
    engine.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, '0')
    expect(engine.snapshotCoverage('note-clean')).toEqual({ unmerged: false })

    engine.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, '50')
    expect(engine.snapshotCoverage('note-clean')).toEqual({ unmerged: false, coversThrough: 50 })
  })

  // #2299 with #2297 round 2: a run from cursor 0 does not declare note_body
  // but moves LAST_CURSOR past body rows it never serves, so it re-arms the
  // legacy sweep and no push claims that cursor.
  it('claims nothing after a run from cursor 0 that served no bodies', async () => {
    const engine = engineWith(getDb)
    engine.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, '0')
    await wire(fakeServer('covers-through'), [{ nextCursor: 50 }])

    await engine.pull()

    expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('50')
    expect(engine.getStateValue(SYNC_STATE_KEYS.NOTE_BODY_LEGACY_SWEEP)).toBeUndefined()
    expect(engine.snapshotCoverage('note-clean')).toEqual({ unmerged: false })
  })

  // #2299: flagged at the encode stays flagged for that push, even if the
  // note merged while the push awaited its credentials.
  it('routes a push flagged at its encode away from the prune', async () => {
    const engine = engineWith(getDb)
    const server = fakeServer('covers-through')
    await wire(server, [])

    await pushFor(engine)('note-clean', new Uint8Array(yUpdate('x')), { unmerged: true })

    expect(server.calls).toEqual([{ route: 'updates', noteId: 'note-clean' }])
  })

  // #2299 review A-9/B-4: a refusal names the refusing snapshot's cursor. The
  // note takes the update route until the feed passes it, even after its owed
  // pull merged, so the refusal is never met again on the spot, and the claim
  // route reopens by itself once the feed has read that snapshot.
  it('routes a refused note to the update route until its feed passes the refusing cursor', async () => {
    const engine = engineWith(getDb)
    const server = fakeServer('covers-through')
    await wire(server, [])
    engine.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, '50')
    const http = await import('../http-client')
    vi.mocked(http.pushCrdtSnapshot).mockRejectedValueOnce(
      new SyncServerError(
        'The stored snapshot holds state this push does not cover',
        409,
        'CRDT_SNAPSHOT_NOT_COVERED: The stored snapshot holds state this push does not cover',
        { code: 'CRDT_SNAPSHOT_NOT_COVERED', blockingCursor: 61 }
      )
    )
    const push = pushFor(engine)
    const crdtSync = (
      engine as unknown as {
        crdtSync: { drainPendingPulls(): string[]; markRemoteStateUnmerged(id: string): void }
      }
    ).crdtSync

    await expect(push(...snapshot(engine, 'note-clean'))).rejects.toBeInstanceOf(SyncServerError)
    expect(crdtSync.drainPendingPulls()).toEqual(['note-clean'])
    // The owed pull merged and cleared the flag; the feed is still at 50.
    ;(
      engine as unknown as { crdtSync: { clearUnmergedIfClean(id: string, s: boolean): void } }
    ).crdtSync.clearUnmergedIfClean('note-clean', false)
    await push(...snapshot(engine, 'note-clean'))
    engine.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, '61')
    await push(...snapshot(engine, 'note-clean'))

    expect(http.pushCrdtSnapshot).toHaveBeenCalledTimes(2)
    expect(server.calls).toEqual([
      { route: 'updates', noteId: 'note-clean' },
      { route: 'snapshot', noteId: 'note-clean', coversThrough: 61 }
    ])
  })

  // #2299: a refused unclaimed push (the legacy sweep not done) has no cursor
  // to wait for; it stays on the update route until the note can claim.
  it('keeps a refused unclaimed push on the update route until the note can claim', () => {
    const engine = engineWith(getDb)
    engine.setStateValue(SYNC_STATE_KEYS.NOTE_BODY_LEGACY_SWEEP, 'pending')
    engine.recordSnapshotRefusal('note-clean', { cursor: 61, claimed: false })
    const crdtSync = (
      engine as unknown as {
        crdtSync: {
          drainPendingPulls(): string[]
          clearUnmergedIfClean(id: string, s: boolean): void
        }
      }
    ).crdtSync
    crdtSync.drainPendingPulls()
    crdtSync.clearUnmergedIfClean('note-clean', false)
    engine.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, '70')

    expect(engine.snapshotCoverage('note-clean')).toEqual({ unmerged: true })
    engine.setStateValue(SYNC_STATE_KEYS.NOTE_BODY_LEGACY_SWEEP, NOTE_BODY_LEGACY_SWEEP_DONE)
    expect(engine.snapshotCoverage('note-clean')).toEqual({ unmerged: false, coversThrough: 70 })
  })

  // #2299 review round 2 (B-L3): the owed pull merged the refusing snapshot,
  // so a compare-and-swap on its revision passes before the feed reaches it.
  it('reopens a claimed refusal once the held snapshot revision changed', () => {
    const engine = engineWith(getDb)
    engine.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, '50')
    engine.recordSnapshotRefusal('note-clean', { cursor: 61, claimed: true, baseRevision: 'rev-a' })
    const crdtSync = (
      engine as unknown as {
        crdtSync: {
          drainPendingPulls(): string[]
          clearUnmergedIfClean(id: string, s: boolean): void
        }
      }
    ).crdtSync
    crdtSync.drainPendingPulls()
    crdtSync.clearUnmergedIfClean('note-clean', false)

    expect(engine.snapshotCoverage('note-clean', 'rev-a')).toEqual({ unmerged: true })
    expect(engine.snapshotCoverage('note-clean', undefined)).toEqual({ unmerged: true })
    expect(engine.snapshotCoverage('note-clean', 'rev-peer')).toEqual({
      unmerged: false,
      coversThrough: 50
    })
  })

  // #2299 review round 2 (B-L4): a journal id created here later would lack a
  // body the feed dropped because its row had not arrived.
  it('withholds the claim for an id whose body the feed dropped as rowless', async () => {
    const provider = fakeProvider()
    const engine = engineWith(getDb, provider)
    await wire(fakeServer('covers-through'), [
      { noteBodies: [body('j2026-10-01', 41, yUpdate('peer journal'))], nextCursor: 50 }
    ])

    await engine.pull()

    expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('50')
    expect(provider.withholdClaimUntilPulled).toHaveBeenCalledWith('j2026-10-01')
    expect(provider.withholdClaimUntilPulled).not.toHaveBeenCalledWith('note-clean')
  })

  // #2299 review A-4: bodies of a local-only note were skipped by the feed
  // without flagging it; leaving local-only owes a pull, so no push claims them.
  it('claims nothing for a note leaving local-only until its owed pull merges', () => {
    const engine = engineWith(getDb)
    engine.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, '150')

    engine.oweCrdtPull('note-clean')

    expect(engine.snapshotCoverage('note-clean')).toEqual({ unmerged: true })
  })
})
