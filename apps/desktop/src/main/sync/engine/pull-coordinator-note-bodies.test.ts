import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { SyncEngine } from '../engine'
import { SYNC_STATE_KEYS } from './sync-context'
import { SyncStateManager } from './sync-state-manager'
import { NoteBodyFeed } from './note-body-feed'
import { createMockDeps, createMockNetwork, setupTestDb } from '@tests/utils/engine-mocks'
import type { CrdtProvider } from '../crdt-provider'
import type { SyncEngineDeps } from './sync-context'
import { noteMetadata } from '@memry/db-schema/schema/note-metadata'
import { eq, inArray } from 'drizzle-orm'
import type { CrdtSyncCoordinator } from './crdt-sync-coordinator'

vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.0', getPath: () => '/tmp/memry-pull-note-bodies-test' }
}))

vi.mock('../../lib/logger', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { createLogger: () => logger }
})

/**
 * #2297 (P3.3 part a): the desktop declares `note_body`, and a changes page's
 * `noteBodies` are applied with the page. Bodies are fetched and verified
 * before the page transaction opens, refusals are recorded inside the last
 * slice's transaction, and the bodies land in the CRDT store after the commit.
 * Landing is post-commit work, so LAST_CURSOR waits for it (#2294). Only a
 * note or journal with a row here takes a body; `KNOWN` lists the rows every
 * engine below starts with. Every engine starts past cursor 0: a run from 0
 * does not declare note_body.
 */

const FEED = Array.from({ length: 20 }, (_, i) => `f${i + 1}`)

const KNOWN = [
  'note-1',
  'note-2',
  'note-3',
  'note-good',
  'note-bad',
  'note-unknown-op',
  'note-garbage',
  'note-unsigned',
  'j2026-09-25',
  'n1',
  'n2',
  'n3',
  'n4',
  'n5',
  'n6',
  'n7',
  ...FEED
]

/** A real Yjs update: the feed refuses bytes Yjs cannot decode. */
const yUpdate = (text: string): number[] => {
  const doc = new Y.Doc()
  doc.getText('t').insert(0, text)
  return [...Y.encodeStateAsUpdate(doc)]
}
const b64 = (bytes: number[]): string => Buffer.from(bytes).toString('base64')
const A = yUpdate('a')
const B = yUpdate('b')
const C = yUpdate('c')

const update = (
  noteId: string,
  cursor: number,
  data?: number[],
  signerDeviceId = 'device-2'
): Record<string, unknown> => ({
  op: 'update',
  noteId,
  cursor,
  sequenceNum: cursor,
  signerDeviceId,
  createdAt: 1,
  size: data?.length ?? 5000,
  ...(data ? { data: b64(data) } : {})
})

const snapshot = (noteId: string, cursor: number, revision: string): Record<string, unknown> => ({
  op: 'snapshot',
  noteId,
  cursor,
  sequenceNum: 3,
  revision,
  signerDeviceId: 'device-2',
  createdAt: 1,
  size: 3
})

interface Page {
  items?: unknown[]
  deleted?: string[]
  noteBodies?: unknown[]
  nextCursor: number
}

function fakeProvider(
  opts: { heldRevision?: string; failStore?: (noteId: string) => boolean } = {}
) {
  const open = new Set<string>()
  const stored: Array<[string, number[]]> = []
  const provider = {
    stored,
    isNoteLocalOnly: vi.fn(() => false),
    hasPersistence: vi.fn(() => true),
    getSnapshotWatermark: vi.fn(async () =>
      opts.heldRevision ? { appliedSequence: 3, snapshotRevision: opts.heldRevision } : null
    ),
    putSnapshotWatermark: vi.fn(async () => {}),
    getDoc: vi.fn(() => undefined),
    // A doc that already holds persisted state.
    getStateVector: vi.fn((noteId: string) =>
      open.has(noteId) ? new Uint8Array([1, 9, 1]) : null
    ),
    open: vi.fn(async (noteId: string) => {
      open.add(noteId)
    }),
    closeIfInactive: vi.fn(async (noteId: string) => open.delete(noteId)),
    mergeRemoteUpdate: vi.fn(async (noteId: string, bytes: Uint8Array) => {
      if (opts.failStore?.(noteId)) throw new Error('the store refused the write')
      stored.push([noteId, [...bytes]])
      return true
    }),
    withholdClaimUntilPulled: vi.fn()
  }
  return provider
}

async function mockServer(
  pages: Page[],
  crdt: {
    updates?: Record<string, { sequenceNum: number; data: number[] } | Error>
    snapshots?: Record<string, number[]>
    onUpdatesGet?: () => Promise<void>
  } = {}
) {
  const http = await import('../http-client')
  let pageIndex = 0
  const get = vi.spyOn(http, 'getFromServer').mockImplementation(async (url: string) => {
    if (url.startsWith('/sync/changes')) {
      const page = pages[Math.min(pageIndex++, pages.length - 1)]
      return {
        items: page.items ?? [],
        deleted: page.deleted ?? [],
        hasMore: pageIndex < pages.length,
        nextCursor: page.nextCursor,
        ...(page.noteBodies ? { noteBodies: page.noteBodies } : {})
      }
    }
    if (url.startsWith('/sync/crdt/updates?')) {
      await crdt.onUpdatesGet?.()
      const noteId = new URLSearchParams(url.split('?')[1]).get('note_id')!
      const found = crdt.updates?.[noteId]
      if (found instanceof Error) throw found
      return {
        updates: found
          ? [
              {
                sequenceNum: found.sequenceNum,
                data: b64(found.data),
                signerDeviceId: 'device-2',
                createdAt: 1
              }
            ]
          : [],
        hasMore: false
      }
    }
    throw new Error(`unexpected GET ${url}`)
  })
  vi.spyOn(http, 'postToServer').mockResolvedValue({ items: [] })
  const fetchSnapshot = vi
    .spyOn(http, 'fetchCrdtSnapshot')
    .mockImplementation(async (noteId: string) => {
      const bytes = crdt.snapshots?.[noteId]
      return bytes
        ? {
            snapshot: new Uint8Array(bytes),
            sequenceNum: 3,
            signerDeviceId: 'device-2',
            revision: 'r2'
          }
        : null
    })
  // The packed envelope is the plaintext here; decryption is crdt-encrypt's own test.
  const decrypt = vi
    .spyOn(await import('../crdt-encrypt'), 'decryptCrdtUpdate')
    .mockImplementation((packed) => packed)
  return { get, fetchSnapshot, decrypt }
}

function engineWith(
  getDb: ReturnType<typeof setupTestDb>['getDb'],
  provider: ReturnType<typeof fakeProvider>,
  overrides: Partial<SyncEngineDeps> = {}
): SyncEngine {
  const db = getDb()
  for (const id of KNOWN) {
    const row = { id, path: `${id}.md`, title: id, createdAt: 'x', modifiedAt: 'x' }
    db.db.insert(noteMetadata).values(row).onConflictDoNothing().run()
  }
  const engine = new SyncEngine(
    createMockDeps(db, { crdtProvider: provider as unknown as CrdtProvider, ...overrides })
  )
  engine.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, '1')
  return engine
}

const crdtSyncOf = (engine: SyncEngine): CrdtSyncCoordinator =>
  (engine as unknown as { crdtSync: CrdtSyncCoordinator }).crdtSync

const bodyGets = (get: { mock: { calls: unknown[][] } }): string[] =>
  get.mock.calls.map(([url]) => url as string).filter((url) => url.startsWith('/sync/crdt/'))

const ledgerKeys = (engine: SyncEngine): string[] =>
  Object.keys(JSON.parse(engine.getStateValue(SYNC_STATE_KEYS.SCHEMA_INVALID_ITEMS) ?? '{}')).sort()

const owedPulls = (engine: SyncEngine): string[] =>
  (engine as unknown as { crdtSync: { drainPendingPulls(): string[] } }).crdtSync
    .drainPendingPulls()
    .sort()

describe('PullCoordinator note bodies from the change feed (#2297)', () => {
  const { getDb } = setupTestDb()

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // #2297
  it('applies inline body updates of a body-only page and moves the cursor', async () => {
    const provider = fakeProvider()
    const engine = engineWith(getDb, provider)
    await mockServer([{ noteBodies: [update('note-1', 4, A)], nextCursor: 4 }])

    await expect(engine.pull()).resolves.toBe(true)

    expect(provider.stored).toEqual([['note-1', A]])
    expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('4')
  })

  // #2297: landing is post-commit work, so the cursor waits for it (#2294).
  it('moves the cursor only once the bodies landed', async () => {
    const provider = fakeProvider()
    const engine = engineWith(getDb, provider)
    await mockServer([{ noteBodies: [update('note-1', 7, A)], nextCursor: 7 }])
    const cursorAtLanding: Array<string | undefined> = []
    provider.mergeRemoteUpdate.mockImplementation(async (noteId: string, bytes: Uint8Array) => {
      cursorAtLanding.push(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR))
      provider.stored.push([noteId, [...bytes]])
      return true
    })

    await engine.pull()

    expect(cursorAtLanding).toEqual(['1'])
    expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('7')
  })

  // #2297 acceptance: the process dies between the slice commit and the store write.
  it('a crash before the landing leaves the cursor on the page, and the re-pull lands it', async () => {
    const provider = fakeProvider()
    const first = engineWith(getDb, provider)
    await mockServer([{ noteBodies: [update('note-1', 5, A)], nextCursor: 5 }])
    const land = vi
      .spyOn(NoteBodyFeed.prototype, 'land')
      .mockRejectedValueOnce(new Error('process died after the commit'))
    await first.pull()
    expect(first.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('1')
    expect(provider.stored).toEqual([])

    land.mockRestore()
    await expect(first.pull()).resolves.toBe(true)

    expect(provider.stored).toEqual([['note-1', A]])
    expect(first.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('5')
  })

  // #2297 review (A-M1, B-3): a landing that fails is refused, before the cursor moves.
  it('refuses a body whose store write fails, ahead of the cursor write', async () => {
    const provider = fakeProvider({ failStore: (noteId) => noteId === 'note-1' })
    const engine = engineWith(getDb, provider)
    await mockServer([
      { noteBodies: [update('note-1', 4, A), update('note-2', 5, B)], nextCursor: 5 }
    ])
    const writes: string[] = []
    const set = SyncStateManager.prototype.setStateValue
    vi.spyOn(SyncStateManager.prototype, 'setStateValue').mockImplementation(function (
      this: SyncStateManager,
      key: string,
      value: string
    ) {
      writes.push(key)
      set.call(this, key, value)
    })

    await expect(engine.pull()).resolves.toBe(true)

    expect(provider.stored).toEqual([['note-2', B]])
    expect(ledgerKeys(engine)).toEqual(['note_body:note-1'])
    expect(engine.hasUnmergedRemoteCrdtState('note-1')).toBe(true)
    expect(owedPulls(engine)).toEqual(['note-1'])
    expect(writes.lastIndexOf(SYNC_STATE_KEYS.SCHEMA_INVALID_ITEMS)).toBeLessThan(
      writes.lastIndexOf(SYNC_STATE_KEYS.LAST_CURSOR)
    )
    expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('5')
  })

  // #2297 review: journals are CRDT documents under their record id.
  it('applies a journal body edit through the feed', async () => {
    const provider = fakeProvider()
    const engine = engineWith(getDb, provider)
    await mockServer([{ noteBodies: [update('j2026-09-25', 3, C)], nextCursor: 3 }])

    await engine.pull()

    expect(provider.stored).toEqual([['j2026-09-25', C]])
  })

  // #2297 review (A-M3): a tombstone the handler skips keeps its note, so its
  // bodies are not dropped; a body only lands for a note that still has a row.
  it('lands the bodies of a known note the same page tombstones', async () => {
    const provider = fakeProvider()
    const engine = engineWith(getDb, provider)
    await mockServer([
      {
        deleted: ['note-1'],
        noteBodies: [update('note-1', 2, A), update('note-2', 3, B)],
        nextCursor: 4
      }
    ])

    await engine.pull()

    expect(provider.stored).toEqual([
      ['note-1', A],
      ['note-2', B]
    ])
    expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('4')
  })

  // #2297 review: a body for an id with no row is dropped, neither stored nor
  // owed; the page that brings the record pulls the whole body, whose live merge
  // writes the vault file. Stored bytes would make that merge a no-op.
  it('drops a rowless body, and the record on a later page pulls the whole body', async () => {
    const provider = fakeProvider()
    const engine = engineWith(getDb, provider)
    const crdtSync = (engine as unknown as { crdtSync: { applyCrdtBatch: unknown } }).crdtSync
    // The coordinator clears the id array after the call, so copy it.
    const batched: string[][] = []
    crdtSync.applyCrdtBatch = async (noteIds: string[]) => {
      batched.push([...noteIds])
      return { snapshotGets: 0, batchPosts: 0 }
    }
    await mockServer([
      { noteBodies: [update('note-x', 2, A)], nextCursor: 2 },
      {
        items: [{ id: 'note-x', type: 'note', version: 1, modifiedAt: 1, size: 10 }],
        nextCursor: 3
      }
    ])
    const http = await import('../http-client')
    vi.spyOn(http, 'postToServer').mockResolvedValue({
      items: [
        {
          id: 'note-x',
          type: 'note',
          operation: 'create',
          cryptoVersion: 1,
          blob: { encryptedKey: 'ek', keyNonce: 'kn', encryptedData: 'ed', dataNonce: 'dn' },
          signature: 'sig',
          signerDeviceId: 'device-2',
          clock: { 'device-2': 1 }
        }
      ]
    })
    vi.spyOn(await import('../decrypt'), 'decryptItemFromPull').mockReturnValue({
      content: new TextEncoder().encode(JSON.stringify({ title: 'x' })),
      verified: true
    })
    const { ItemApplier } = await import('../apply-item')
    vi.spyOn(ItemApplier.prototype, 'apply').mockReturnValue('applied')

    await expect(engine.pull()).resolves.toBe(true)

    expect(provider.stored).toEqual([])
    expect(provider.open).not.toHaveBeenCalled()
    expect(owedPulls(engine)).toEqual([])
    expect(batched).toEqual([['note-x']])
    expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('3')
  })

  // #2297: a snapshot that did not merge into a doc must not reach the
  // watermark. The CRDT pull's probe would then skip that note's baseline as
  // already held, and the whole-body pull the note is owed would merge nothing
  // (the C4 create-propagation flake after the restack onto #2301).
  it('records no snapshot watermark for a snapshot it did not merge', async () => {
    const provider = fakeProvider()
    provider.getStateVector.mockReturnValue(new Uint8Array([0]))
    const engine = engineWith(getDb, provider)
    await mockServer(
      [{ noteBodies: [snapshot('note-1', 6, 'r2'), snapshot('note-x', 7, 'r2')], nextCursor: 7 }],
      { snapshots: { 'note-1': C, 'note-x': C } }
    )

    await engine.pull()

    expect(provider.stored).toEqual([])
    expect(provider.putSnapshotWatermark).not.toHaveBeenCalled()
    expect(owedPulls(engine)).toEqual(['note-1'])
  })

  // #2297 review (A-L5, B-9): a known note whose doc holds nothing is owed its
  // whole body instead of taking a delta.
  it('owes a known note whose doc holds nothing its whole body, storing nothing', async () => {
    const provider = fakeProvider()
    provider.getStateVector.mockReturnValue(new Uint8Array([0]))
    const engine = engineWith(getDb, provider)
    await mockServer([{ noteBodies: [update('note-1', 2, A)], nextCursor: 2 }])

    await engine.pull()

    expect(provider.stored).toEqual([])
    expect(owedPulls(engine)).toEqual(['note-1'])
    expect(ledgerKeys(engine)).toEqual([])
    expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('2')
  })

  // #2297 review (A-M5): a skipped entry still owes the note its body.
  it('fetches a ref update by sequence, and flags and owes a note whose update was pruned', async () => {
    const provider = fakeProvider()
    const engine = engineWith(getDb, provider)
    const { get } = await mockServer(
      [{ noteBodies: [update('note-1', 8), update('note-2', 9)], nextCursor: 9 }],
      {
        updates: {
          'note-1': { sequenceNum: 8, data: A },
          'note-2': { sequenceNum: 12, data: B }
        }
      }
    )

    await engine.pull()

    expect(get).toHaveBeenCalledWith(
      '/sync/crdt/updates?note_id=note-1&since=7&limit=1',
      'test-token',
      undefined,
      { signal: expect.any(AbortSignal) }
    )
    expect(provider.stored).toEqual([['note-1', A]])
    expect(engine.hasUnmergedRemoteCrdtState('note-2')).toBe(true)
    expect(owedPulls(engine)).toEqual(['note-2'])
    expect(ledgerKeys(engine)).toEqual([])
    expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('9')
  })

  // #2297, review (B-7, A-M6)
  it('fetches a snapshot ref with the abort signal and records its revision; skips a held one', async () => {
    const provider = fakeProvider()
    const engine = engineWith(getDb, provider)
    const { fetchSnapshot } = await mockServer(
      [{ noteBodies: [snapshot('note-1', 6, 'r2')], nextCursor: 6 }],
      { snapshots: { 'note-1': C } }
    )
    await engine.pull()
    expect(provider.stored).toEqual([['note-1', C]])
    expect(fetchSnapshot).toHaveBeenCalledWith('note-1', 'test-token', {
      signal: expect.any(AbortSignal),
      maxRetries: 0
    })
    expect(provider.putSnapshotWatermark).toHaveBeenCalledWith('note-1', {
      appliedSequence: 3,
      snapshotRevision: 'r2'
    })

    vi.restoreAllMocks()
    const held = fakeProvider({ heldRevision: 'r2' })
    const second = engineWith(getDb, held)
    const again = await mockServer([{ noteBodies: [snapshot('note-1', 6, 'r2')], nextCursor: 6 }], {
      snapshots: { 'note-1': C }
    })
    await second.pull()

    expect(again.fetchSnapshot).not.toHaveBeenCalled()
    expect(held.stored).toEqual([])
  })

  // #2297 review (A-M5)
  it('flags and owes a note whose snapshot GET finds no blob', async () => {
    const provider = fakeProvider()
    const engine = engineWith(getDb, provider)
    await mockServer([{ noteBodies: [snapshot('note-1', 6, 'r2')], nextCursor: 6 }])

    await engine.pull()

    expect(engine.hasUnmergedRemoteCrdtState('note-1')).toBe(true)
    expect(owedPulls(engine)).toEqual(['note-1'])
    expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('6')
  })

  // #2297: one bad entry never fails the page (protocol 05 §5.14). Review (A-L1, B-11):
  // bytes Yjs cannot decode are refused and never stored.
  it('routes malformed, unverifiable and undecodable entries to the ledger and applies the rest', async () => {
    const provider = fakeProvider()
    const engine = engineWith(getDb, provider, {
      getDevicePublicKey: vi.fn(async (id: string) =>
        id === 'device-3' ? null : new Uint8Array(32)
      )
    })
    await mockServer([
      {
        noteBodies: [
          { op: 'update', noteId: 'note-bad', cursor: 'two' },
          { op: 'rename', noteId: 'note-unknown-op', cursor: 3 },
          { cursor: 4 },
          update('note-unsigned', 5, A, 'device-3'),
          update('note-garbage', 6, [1, 2, 3]),
          update('note-good', 7, B)
        ],
        nextCursor: 7
      }
    ])

    await expect(engine.pull()).resolves.toBe(true)

    expect(provider.stored).toEqual([['note-good', B]])
    expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('7')
    expect(ledgerKeys(engine)).toEqual([
      'note_body:note-bad',
      'note_body:note-garbage',
      'note_body:note-unknown-op',
      'note_body:note-unsigned'
    ])
    // A snapshot push would prune the update this device could not merge.
    expect(engine.hasUnmergedRemoteCrdtState('note-unsigned')).toBe(true)
    expect(engine.hasUnmergedRemoteCrdtState('note-garbage')).toBe(true)
  })

  // #2297 review (A-M4, B-6): a transport failure is per entry, never a page failure.
  it('refuses and owes the entry whose fetch or key lookup fails, and still applies the page', async () => {
    const provider = fakeProvider()
    const { SyncServerError } = await import('../http-client')
    const engine = engineWith(getDb, provider, {
      getDevicePublicKey: vi.fn(async (id: string) => {
        if (id === 'device-4') throw new Error('device list unreachable')
        return new Uint8Array(32)
      })
    })
    await mockServer(
      [
        {
          noteBodies: [
            update('note-1', 3),
            update('note-2', 4, A, 'device-4'),
            update('note-3', 5, B)
          ],
          nextCursor: 5
        }
      ],
      { updates: { 'note-1': new SyncServerError('no such note', 404, 'not found') } }
    )

    await expect(engine.pull()).resolves.toBe(true)

    expect(provider.stored).toEqual([['note-3', B]])
    expect(ledgerKeys(engine)).toEqual(['note_body:note-1', 'note_body:note-2'])
    expect(owedPulls(engine)).toEqual(['note-1', 'note-2'])
    expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('5')
  })

  // #2297 review (B-2): an in-memory provider cannot hold a body, so nothing is
  // fetched and every note is owed to the CRDT pull, which merges into its docs.
  it('owes every body to the CRDT pull when the provider has no store', async () => {
    const provider = fakeProvider()
    provider.hasPersistence.mockReturnValue(false)
    const engine = engineWith(getDb, provider)
    const { get } = await mockServer([
      { noteBodies: [update('note-1', 3), update('note-2', 4, A)], nextCursor: 4 }
    ])

    await expect(engine.pull()).resolves.toBe(true)

    expect(get).not.toHaveBeenCalledWith(expect.stringContaining('/sync/crdt/'), expect.anything())
    expect(provider.stored).toEqual([])
    expect(owedPulls(engine)).toEqual(['note-1', 'note-2'])
    expect(ledgerKeys(engine)).toEqual([])
    expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('4')
  })

  // #2297 review (A-M6): ref GETs run in parallel, at most four at a time.
  it('fetches refs with bounded concurrency', async () => {
    const provider = fakeProvider()
    const engine = engineWith(getDb, provider)
    let inFlight = 0
    let peak = 0
    const ids = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7']
    await mockServer(
      [{ noteBodies: ids.map((id, i) => update(id, i + 1)), nextCursor: ids.length }],
      {
        updates: Object.fromEntries(ids.map((id, i) => [id, { sequenceNum: i + 1, data: A }])),
        onUpdatesGet: async () => {
          inFlight++
          peak = Math.max(peak, inFlight)
          await new Promise((resolve) => setTimeout(resolve, 5))
          inFlight--
        }
      }
    )

    await engine.pull()

    expect(peak).toBe(4)
    expect(provider.stored.map(([id]) => id)).toEqual(ids)
  })

  // #2297 review (B-5): the vault-key guard records use covers bodies too.
  it('holds the cursor and ledgers nothing when every body fails while the key is mid-swap', async () => {
    const provider = fakeProvider()
    const checkAccountKey = vi.fn(async () => 'transition' as const)
    const engine = engineWith(getDb, provider, { checkAccountKey })
    const { decrypt } = await mockServer([
      { noteBodies: [update('note-1', 4, A), update('note-2', 5, B)], nextCursor: 5 }
    ])
    decrypt.mockImplementation(() => {
      throw new Error('decryption failed')
    })

    await expect(engine.pull()).resolves.toBe(false)

    expect(checkAccountKey).toHaveBeenCalledOnce()
    expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('1')
    expect(ledgerKeys(engine)).toEqual([])
    expect(provider.stored).toEqual([])
  })

  // #2297 review (A-M6, B-7): decrypt off the main thread when the worker runs.
  it('decrypts through the crypto worker when it is running', async () => {
    const provider = fakeProvider()
    const decryptCrdtBatch = vi.fn(async (items: Array<{ index: number; data?: Uint8Array }>) => ({
      results: items.map((item) => ({ index: item.index, update: item.data! })),
      failures: []
    }))
    const engine = engineWith(getDb, provider, {
      workerBridge: {
        isRunning: true,
        decryptCrdtBatch
      } as unknown as SyncEngineDeps['workerBridge']
    })
    const { decrypt } = await mockServer([{ noteBodies: [update('note-1', 4, A)], nextCursor: 4 }])

    await engine.pull()

    expect(decryptCrdtBatch).toHaveBeenCalledOnce()
    expect(decrypt).not.toHaveBeenCalled()
    expect(provider.stored).toEqual([['note-1', A]])
  })

  // #2297 review (A-H1, B-4): healing a refused body never re-creates a deleted note.
  it('resolves a refused body of a note that no longer exists without pulling it', async () => {
    const provider = fakeProvider()
    const engine = engineWith(getDb, provider)
    engine.setStateValue(
      SYNC_STATE_KEYS.SCHEMA_INVALID_ITEMS,
      JSON.stringify({
        'note_body:note-gone': {
          id: 'note-gone',
          type: 'note_body',
          kind: 'envelope',
          lastRefusedByVersion: '1.0.0',
          failedAt: 0
        }
      })
    )
    const crdtSync = (engine as unknown as { crdtSync: { applyCrdtIncrementals: unknown } })
      .crdtSync
    const pullWhole = vi.fn(async () => true)
    crdtSync.applyCrdtIncrementals = pullWhole
    await mockServer([{ noteBodies: [], nextCursor: 1 }])

    await engine.pull()

    expect(pullWhole).not.toHaveBeenCalled()
    expect(provider.open).not.toHaveBeenCalled()
    expect(ledgerKeys(engine)).toEqual([])
  })

  // #2297 with #2301: the pull start drains pending sync intents before it
  // heals refused bodies, like every other ledger retry.
  it('drains pending sync intents before it heals a refused body', async () => {
    const provider = fakeProvider()
    const engine = engineWith(getDb, provider)
    engine.setStateValue(
      SYNC_STATE_KEYS.SCHEMA_INVALID_ITEMS,
      JSON.stringify({
        'note_body:note-1': {
          id: 'note-1',
          type: 'note_body',
          kind: 'envelope',
          lastRefusedByVersion: '1.0.0',
          failedAt: 0
        }
      })
    )
    const crdtSync = (engine as unknown as { crdtSync: { applyCrdtIncrementals: unknown } })
      .crdtSync
    crdtSync.applyCrdtIncrementals = vi.fn(async () => true)
    const drain = vi.spyOn(await import('../sync-intents'), 'drainPendingSyncIntents')
    const heal = vi.spyOn(NoteBodyFeed.prototype, 'heal')
    await mockServer([{ noteBodies: [], nextCursor: 1 }])

    await engine.pull()

    expect(drain).toHaveBeenCalledWith(expect.anything(), 'pull')
    expect(heal).toHaveBeenCalledWith('note-1', 'test-token', expect.any(Uint8Array))
    expect(drain.mock.invocationCallOrder[0]).toBeLessThan(heal.mock.invocationCallOrder[0])
    expect(ledgerKeys(engine)).toEqual([])
  })

  // #2297 with #2302: a purged tombstone applied on the page removes the note's
  // row inside the slice transaction, so the page's body for it is dropped,
  // never merged into a doc or stored.
  it('drops the body of a note a purged tombstone deletes on the same page', async () => {
    const provider = fakeProvider()
    const engine = engineWith(getDb, provider)
    engine.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, '1')
    await mockServer([
      {
        deleted: ['note-1'],
        noteBodies: [update('note-1', 3, A), update('note-2', 4, B)],
        nextCursor: 4
      }
    ])
    const envelope = await import('./pull-envelope')
    vi.spyOn(envelope, 'purgedTombstoneApplyItems').mockReturnValue([
      envelope.purgedTombstoneToApplyItem({
        id: 'note-1',
        type: 'note',
        deletedAt: 5,
        clock: { 'device-2': 3 }
      })
    ])
    const db = getDb().db
    const { ItemApplier } = await import('../apply-item')
    vi.spyOn(ItemApplier.prototype, 'apply').mockImplementation((input) => {
      // What the note handler's delete does to the row the landing checks.
      db.delete(noteMetadata).where(eq(noteMetadata.id, input.itemId)).run()
      return 'applied'
    })

    await expect(engine.pull()).resolves.toBe(true)

    expect(provider.stored).toEqual([['note-2', B]])
    expect(provider.open).not.toHaveBeenCalledWith('note-1', undefined, { skipSeed: true })
    expect(owedPulls(engine)).toEqual([])
    expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('4')
  })

  // #2297 review: the first launch that negotiates bodies owes one legacy sweep,
  // and a server that stops serving bodies (rollback) re-arms it (A-M7, B-8).
  it('marks the legacy sweep pending when bodies are served and resets it when they are not', async () => {
    const provider = fakeProvider()
    const engine = engineWith(getDb, provider)
    await mockServer([{ nextCursor: 1 }])
    await engine.pull()
    expect(engine.getStateValue(SYNC_STATE_KEYS.NOTE_BODY_LEGACY_SWEEP)).toBeUndefined()

    vi.restoreAllMocks()
    await mockServer([{ noteBodies: [], nextCursor: 2 }])
    await engine.pull()
    expect(engine.getStateValue(SYNC_STATE_KEYS.NOTE_BODY_LEGACY_SWEEP)).toBe('pending')

    engine.setStateValue(SYNC_STATE_KEYS.NOTE_BODY_LEGACY_SWEEP, 'done')
    vi.restoreAllMocks()
    await mockServer([{ noteBodies: [], nextCursor: 3 }])
    await engine.pull()
    expect(engine.getStateValue(SYNC_STATE_KEYS.NOTE_BODY_LEGACY_SWEEP)).toBe('done')

    vi.restoreAllMocks()
    await mockServer([{ nextCursor: 4 }])
    await engine.pull()
    expect(engine.getStateValue(SYNC_STATE_KEYS.NOTE_BODY_LEGACY_SWEEP)).toBeUndefined()
  })

  // #2297 round 2 (A-H1, B-H1): an id with no row is never ledgered or owed,
  // whichever step refused or owed its entry.
  it('never ledgers or owes a refused or owed entry whose note is gone', async () => {
    const provider = fakeProvider()
    const engine = engineWith(getDb, provider)
    const db = getDb().db
    const { SyncServerError } = await import('../http-client')
    await mockServer([{ noteBodies: [update('note-1', 3), update('note-2', 4)], nextCursor: 4 }], {
      updates: {
        'note-1': new SyncServerError('no such note', 404, 'not found'),
        'note-2': { sequenceNum: 9, data: A }
      },
      // Deleted between the fetch and the page transaction, as the page's
      // tombstones do.
      onUpdatesGet: async () => {
        db.delete(noteMetadata)
          .where(inArray(noteMetadata.id, ['note-1', 'note-2']))
          .run()
      }
    })

    await expect(engine.pull()).resolves.toBe(true)

    expect(ledgerKeys(engine)).toEqual([])
    expect(owedPulls(engine)).toEqual([])
    expect(engine.hasUnmergedRemoteCrdtState('note-1')).toBe(false)
    expect(engine.hasUnmergedRemoteCrdtState('note-2')).toBe(false)
    expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('4')
  })

  // #2297 round 2 (A-H1, B-H1)
  it('refuses nothing for a note deleted while its body landed', async () => {
    const provider = fakeProvider()
    const engine = engineWith(getDb, provider)
    const db = getDb().db
    provider.mergeRemoteUpdate.mockImplementation(async (noteId: string) => {
      db.delete(noteMetadata).where(eq(noteMetadata.id, noteId)).run()
      throw new Error('No open doc to merge a change-feed body into')
    })
    await mockServer([{ noteBodies: [update('note-1', 3, A)], nextCursor: 3 }])

    await engine.pull()

    expect(ledgerKeys(engine)).toEqual([])
    expect(owedPulls(engine)).toEqual([])
  })

  // #2297 round 2 (A-H1, B-H1): an in-memory provider owes only notes it has.
  it('owes an in-memory provider no rowless body', async () => {
    const provider = fakeProvider()
    provider.hasPersistence.mockReturnValue(false)
    const engine = engineWith(getDb, provider)
    await mockServer([{ noteBodies: [update('note-1', 3), update('note-x', 4, A)], nextCursor: 4 }])

    await engine.pull()

    expect(owedPulls(engine)).toEqual(['note-1'])
  })

  // #2297 round 2 (A-H1, B-H1): a note refused while it had a row and deleted
  // before the drain is dropped where queued pulls merge into a doc, so that
  // merge cannot write the deleted note back as a new file.
  it('drops a queued pull of a note deleted after its body was refused', async () => {
    const provider = fakeProvider()
    const engine = engineWith(getDb, provider)
    const { SyncServerError } = await import('../http-client')
    await mockServer([{ noteBodies: [update('note-1', 3)], nextCursor: 3 }], {
      updates: { 'note-1': new SyncServerError('no such note', 404, 'not found') }
    })
    await engine.pull()
    const crdtSync = crdtSyncOf(engine)
    const owed = crdtSync.drainPendingPulls()
    expect(owed).toEqual(['note-1'])
    getDb().db.delete(noteMetadata).where(eq(noteMetadata.id, 'note-1')).run()
    const batch = vi.spyOn(crdtSync, 'applyCrdtBatch')

    await crdtSync.pullCrdtForNotes(owed)

    expect(batch).not.toHaveBeenCalled()
    expect(provider.open).not.toHaveBeenCalled()
    expect(crdtSync.hasUnmergedRemoteState('note-1')).toBe(false)
    expect(
      getDb().db.select().from(noteMetadata).where(eq(noteMetadata.id, 'note-1')).all()
    ).toEqual([])
  })

  // #2297 round 2 (A-M2, B-M1, B-L3): nothing is fetched for an id with no row,
  // nor for a note whose record is on the page: that page pulls the whole body.
  it('fetches no body for a rowless id or for a note whose record is on the page', async () => {
    const provider = fakeProvider()
    const engine = engineWith(getDb, provider)
    const { get } = await mockServer(
      [
        {
          items: [{ id: 'note-2', type: 'note', version: 1, modifiedAt: 1, size: 10 }],
          noteBodies: [update('note-x', 2), update('note-2', 3), update('note-1', 4)],
          nextCursor: 4
        }
      ],
      {
        updates: {
          'note-x': { sequenceNum: 2, data: A },
          'note-2': { sequenceNum: 3, data: B },
          'note-1': { sequenceNum: 4, data: C }
        }
      }
    )

    await engine.pull()

    expect(bodyGets(get)).toEqual(['/sync/crdt/updates?note_id=note-1&since=3&limit=1'])
    expect(provider.stored).toEqual([['note-1', C]])
    expect(owedPulls(engine)).toEqual([])
  })

  // #2297 round 2 (A-M2, B-M1): a run from cursor 0 (bootstrap, or any reset)
  // walks 500-row record pages without bodies; the record pages and the legacy
  // sweep deliver them. Only a run that starts past 0 declares note_body.
  it('declares note_body only on a run that starts past cursor 0', async () => {
    const provider = fakeProvider()
    const engine = engineWith(getDb, provider)
    engine.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, '0')
    const { get } = await mockServer([{ noteBodies: [update('note-1', 2, A)], nextCursor: 2 }])
    const declared = (): unknown[] =>
      get.mock.calls
        .filter(([url]) => (url as string).startsWith('/sync/changes'))
        .map(
          (call) =>
            (call[3] as { headers?: Record<string, string> } | undefined)?.headers?.[
              'X-Memry-Sync-Types'
            ]
        )

    await engine.pull()
    expect(declared()).toEqual([undefined])
    expect(provider.stored).toEqual([])
    expect(engine.getStateValue(SYNC_STATE_KEYS.NOTE_BODY_LEGACY_SWEEP)).toBeUndefined()

    get.mockClear()
    await engine.pull()
    expect(declared()).toEqual([expect.stringContaining('note_body')])
    expect(provider.stored).toEqual([['note-1', A]])
  })

  // #2297 round 2 (A-M2, B-M1): body GETs are bounded per page, so one page
  // spends at most 16 of the crdt_pull budget; the rest are owed to the paced
  // sweep, which charges its own GETs.
  it('fetches at most 16 bodies per page and owes the rest', async () => {
    const provider = fakeProvider()
    const engine = engineWith(getDb, provider)
    const { get } = await mockServer(
      [{ noteBodies: FEED.map((id, i) => update(id, i + 2)), nextCursor: 30 }],
      {
        updates: Object.fromEntries(FEED.map((id, i) => [id, { sequenceNum: i + 2, data: A }]))
      }
    )

    await engine.pull()

    expect(bodyGets(get)).toHaveLength(16)
    expect(provider.stored).toHaveLength(16)
    expect(owedPulls(engine)).toEqual(['f17', 'f18', 'f19', 'f20'])
    expect(ledgerKeys(engine)).toEqual([])
  })

  // #2297 round 2 (A-M3, B-M2): a transport failure is no fault of the entry.
  // The first one stops the page's body GETs; that entry and every entry not
  // yet fetched are owed, and nothing is ledgered.
  it('stops fetching at the first rate limit and owes the rest without ledgering', async () => {
    const provider = fakeProvider()
    const engine = engineWith(getDb, provider)
    const { RateLimitError } = await import('../http-client')
    const ids = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6']
    const { get } = await mockServer(
      [{ noteBodies: ids.map((id, i) => update(id, i + 2)), nextCursor: 8 }],
      { updates: Object.fromEntries(ids.map((id) => [id, new RateLimitError(60)])) }
    )

    await expect(engine.pull()).resolves.toBe(true)

    expect(bodyGets(get)).toHaveLength(4)
    expect(owedPulls(engine)).toEqual(ids)
    expect(ledgerKeys(engine)).toEqual([])
    expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('8')
  })

  // #2297 round 2 (B-M2): a token that expires mid-page is refreshed once, as
  // the record slice does, instead of failing every remaining body.
  it('refreshes an expired session once and fetches the body with the fresh token', async () => {
    const provider = fakeProvider()
    const { SyncServerError } = await import('../http-client')
    let token = 'test-token'
    const engine = engineWith(getDb, provider, {
      getAccessToken: vi.fn(async () => token),
      refreshAccessToken: vi.fn(async () => {
        token = 'fresh-token'
        return true
      })
    })
    let expired = true
    const { get } = await mockServer([{ noteBodies: [update('note-1', 3)], nextCursor: 3 }], {
      updates: { 'note-1': { sequenceNum: 3, data: A } },
      onUpdatesGet: async () => {
        if (!expired) return
        expired = false
        throw new SyncServerError('token expired', 401)
      }
    })

    await engine.pull()

    expect(provider.stored).toEqual([['note-1', A]])
    expect(get).toHaveBeenCalledWith(
      '/sync/crdt/updates?note_id=note-1&since=2&limit=1',
      'fresh-token',
      undefined,
      expect.anything()
    )
  })

  // #2297 round 2 (A-M1): of two snapshot entries for one note on a page, the
  // newest decides, so a peer's later snapshot is not skipped as held.
  it('compares the held revision against the newest snapshot entry of a note', async () => {
    const provider = fakeProvider({ heldRevision: 'rB' })
    const engine = engineWith(getDb, provider)
    const { fetchSnapshot } = await mockServer(
      [{ noteBodies: [snapshot('note-1', 5, 'rB'), snapshot('note-1', 6, 'rA')], nextCursor: 6 }],
      { snapshots: { 'note-1': C } }
    )

    await engine.pull()

    expect(fetchSnapshot).toHaveBeenCalledOnce()
    expect(provider.stored).toEqual([['note-1', C]])
  })

  // #2297 round 2 (B-L2): an abort (vault close or switch) mid-landing stops
  // the landing. The page re-pulls, so nothing is ledgered or owed.
  it('stops landing on abort and refuses nothing', async () => {
    const provider = fakeProvider()
    const engine = engineWith(getDb, provider)
    provider.mergeRemoteUpdate.mockImplementation(async () => {
      engine.requestCancel()
      throw new Error('No CRDT store to hold a change-feed body')
    })
    await mockServer([
      { noteBodies: [update('note-1', 3, A), update('note-2', 4, B)], nextCursor: 4 }
    ])

    await expect(engine.pull()).resolves.toBe(false)

    expect(provider.mergeRemoteUpdate).toHaveBeenCalledOnce()
    expect(ledgerKeys(engine)).toEqual([])
    expect(owedPulls(engine)).toEqual([])
    expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('1')
  })

  // #2297 round 2 (B-L4): a note record the deferred retry applies pulls its
  // whole body, like one applied on its page. A body dropped as rowless on
  // that page relies on it.
  it('pulls the whole body of a note record the deferred retry applies', async () => {
    const provider = fakeProvider()
    const engine = engineWith(getDb, provider)
    const crdtSync = crdtSyncOf(engine)
    const batched: string[][] = []
    vi.spyOn(crdtSync, 'applyCrdtBatch').mockImplementation(async (noteIds: string[]) => {
      batched.push([...noteIds])
      return { snapshotGets: 0, batchPosts: 0 }
    })
    await mockServer([
      {
        items: [{ id: 'note-y', type: 'note', version: 1, modifiedAt: 1, size: 10 }],
        noteBodies: [update('note-y', 2, A)],
        nextCursor: 3
      }
    ])
    const http = await import('../http-client')
    vi.spyOn(http, 'postToServer').mockResolvedValue({
      items: [
        {
          id: 'note-y',
          type: 'note',
          operation: 'create',
          cryptoVersion: 1,
          blob: { encryptedKey: 'ek', keyNonce: 'kn', encryptedData: 'ed', dataNonce: 'dn' },
          signature: 'sig',
          signerDeviceId: 'device-2',
          clock: { 'device-2': 1 }
        }
      ]
    })
    vi.spyOn(await import('../decrypt'), 'decryptItemFromPull').mockReturnValue({
      content: new TextEncoder().encode(JSON.stringify({ title: 'y' })),
      verified: true
    })
    const { ItemApplier } = await import('../apply-item')
    vi.spyOn(ItemApplier.prototype, 'apply')
      .mockImplementationOnce(() => {
        throw new Error('parent folder not pulled yet')
      })
      .mockReturnValue('applied')

    await engine.pull()

    expect(batched).toEqual([['note-y']])
    expect(provider.stored).toEqual([])
  })
})

describe('Durable CRDT body debts across a record page (#2297)', () => {
  const { getDb } = setupTestDb()

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const debts = () =>
    getDb()
      .sqlite.prepare(
        'SELECT note_id AS noteId, reason, lowest_cursor AS lowestCursor FROM crdt_body_debts ORDER BY note_id'
      )
      .all()

  /** A provider the real CRDT batch can merge into. */
  function mergeableProvider() {
    return Object.assign(fakeProvider(), {
      applyRemoteUpdate: vi.fn(),
      recordWholeBodyMerged: vi.fn(),
      inactiveDocCapacity: 32,
      raiseInactiveDocCapacity: vi.fn(() => null)
    })
  }

  /** A record page carrying `noteId`'s record; the batch POST answers `batch`. */
  async function mockRecordPage(noteId: string, batch: () => Promise<unknown>) {
    const http = await import('../http-client')
    vi.spyOn(http, 'getFromServer').mockResolvedValue({
      items: [{ id: noteId, type: 'note', version: 1, modifiedAt: 1, size: 10 }],
      deleted: [],
      hasMore: false,
      nextCursor: 3,
      noteBodies: []
    })
    vi.spyOn(http, 'postToServer').mockImplementation(async (path: string) => {
      if (path === '/sync/crdt/updates/batch') return batch()
      return {
        items: [
          {
            id: noteId,
            type: 'note',
            operation: 'update',
            cryptoVersion: 1,
            blob: { encryptedKey: 'ek', keyNonce: 'kn', encryptedData: 'ed', dataNonce: 'dn' },
            signature: 'sig',
            signerDeviceId: 'device-2',
            clock: { 'device-2': 2 }
          }
        ]
      }
    })
    vi.spyOn(http, 'fetchCrdtSnapshot').mockResolvedValue(null)
    vi.spyOn(await import('../decrypt'), 'decryptItemFromPull').mockReturnValue({
      content: new TextEncoder().encode(JSON.stringify({ title: noteId })),
      verified: true
    })
    const { ItemApplier } = await import('../apply-item')
    vi.spyOn(ItemApplier.prototype, 'apply').mockReturnValue('applied')
  }

  // #2297: the page's CRDT batch fails after the page moved the cursor, and the
  // app quits. The next engine must still pull the note: nothing else would
  // until a vault sweep, while the old blanket only kept pushes off the prune.
  it('a record debt the batch did not pay survives a restart and the next engine pays it', async () => {
    const provider = mergeableProvider()
    const first = engineWith(getDb, provider)
    const { SyncServerError } = await import('../http-client')
    await mockRecordPage('note-1', async () => {
      throw new SyncServerError('Too many requests', 429, 'RATE_LIMITED')
    })

    await expect(first.pull()).resolves.toBe(true)
    expect(first.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('3')
    await first.stop({ skipFinalPush: true })

    const second = new SyncEngine(
      createMockDeps(getDb(), {
        crdtProvider: provider as unknown as CrdtProvider,
        network: createMockNetwork(false)
      })
    )
    await second.start()

    expect(second.hasUnmergedRemoteCrdtState('note-1')).toBe(true)
    const batch = vi.fn(async () => ({ notes: { 'note-1': { updates: [], hasMore: false } } }))
    await mockRecordPage('note-1', batch)
    // A rate limit is pacing, not a failed body pull: no backoff (#2297 A-2).
    const owed = crdtSyncOf(second).drainPendingPulls()
    expect(owed).toEqual(['note-1'])
    await crdtSyncOf(second).pullCrdtForNotes(owed)

    expect(batch).toHaveBeenCalledOnce()
    expect(second.hasUnmergedRemoteCrdtState('note-1')).toBe(false)
    // The same clean walk lets the doc vouch for claims again (#2299).
    expect(provider.recordWholeBodyMerged).toHaveBeenCalledWith('note-1')
    expect(debts()).toEqual([])
    expect(second.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('3')
    expect(second.getStateValue(SYNC_STATE_KEYS.CRDT_UNMERGED_DEBT)).toBe('0')
  })

  // #2297: the record debt is in the database before any cursor write.
  it('writes a record debt with no cursor before the cursor moves past the page', async () => {
    const provider = mergeableProvider()
    const engine = engineWith(getDb, provider)
    await mockRecordPage('note-1', async () => ({ notes: {} }))
    vi.spyOn(crdtSyncOf(engine), 'applyCrdtBatch').mockResolvedValue({
      snapshotGets: 0,
      batchPosts: 0
    })
    const atCursorWrite: unknown[] = []
    const set = SyncStateManager.prototype.setStateValue
    vi.spyOn(SyncStateManager.prototype, 'setStateValue').mockImplementation(function (
      this: SyncStateManager,
      key: string,
      value: string
    ) {
      if (key === SYNC_STATE_KEYS.LAST_CURSOR) atCursorWrite.push(debts())
      set.call(this, key, value)
    })

    await engine.pull()

    expect(atCursorWrite).toEqual([[{ noteId: 'note-1', reason: 'record', lowestCursor: null }]])
  })

  // #2297: feed debts carry the lowest cursor of the note's entries on the
  // page; an entry this build could not parse owes the whole body.
  it('owes feed entries with their lowest page cursor, and NULL for an unparsable one', async () => {
    const provider = fakeProvider()
    const engine = engineWith(getDb, provider)
    await mockServer([
      {
        noteBodies: [
          update('note-2', 6),
          update('note-2', 5),
          update('note-3', 4, A),
          { op: 'update', noteId: 'note-3', cursor: 'two' }
        ],
        nextCursor: 7
      }
    ])

    await engine.pull()

    expect(debts()).toEqual([
      { noteId: 'note-2', reason: 'feed_owed', lowestCursor: 5 },
      { noteId: 'note-3', reason: 'feed_refused', lowestCursor: null }
    ])
    expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('7')
  })

  // #2297 review B-H1, A-3: bodies skipped because the record is on the page
  // are owed in the page transaction, so a record that does not apply leaves
  // its note owed and flagged, and the note never claims the cursor.
  it('owes a note whose record on the same page did not apply, and it claims nothing', async () => {
    const provider = mergeableProvider()
    const engine = engineWith(getDb, provider)
    engine.setStateValue(SYNC_STATE_KEYS.NOTE_BODY_LEGACY_SWEEP, 'done')
    const batch = vi.spyOn(crdtSyncOf(engine), 'applyCrdtBatch')
    await mockRecordPage('note-1', async () => ({ notes: {} }))
    const http = await import('../http-client')
    vi.mocked(http.getFromServer).mockResolvedValue({
      items: [{ id: 'note-1', type: 'note', version: 1, modifiedAt: 1, size: 10 }],
      deleted: [],
      hasMore: false,
      nextCursor: 9,
      noteBodies: [update('note-1', 7, A), update('note-1', 8, B)]
    })
    const { ItemApplier } = await import('../apply-item')
    vi.mocked(ItemApplier.prototype.apply).mockReturnValue('schema_invalid')

    await engine.pull()

    expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('9')
    expect(debts()).toEqual([{ noteId: 'note-1', reason: 'feed_owed', lowestCursor: 7 }])
    expect(engine.hasUnmergedRemoteCrdtState('note-1')).toBe(true)
    expect(engine.snapshotCoverage('note-1')).toEqual({ unmerged: true })
    expect(batch).not.toHaveBeenCalled()
  })

  // #2297 round 2 b-M2: on a multi-slice page the skipped body is owed in the
  // slice that applied its record, before that slice's batch, so the batch's
  // clean walk settles it. Owed in the last slice it would outlive the walk.
  it('owes a skipped body in its record slice, so that slice batch settles it', async () => {
    const provider = mergeableProvider()
    const engine = engineWith(getDb, provider)
    engine.setStateValue(SYNC_STATE_KEYS.NOTE_BODY_LEGACY_SWEEP, 'done')
    const batch = vi.fn(async () => ({ notes: { 'note-1': { updates: [], hasMore: false } } }))
    await mockRecordPage('note-1', batch)
    const tasks = Array.from({ length: 250 }, (_, i) => `task-${i}`)
    const http = await import('../http-client')
    vi.mocked(http.getFromServer).mockResolvedValue({
      items: [
        { id: 'note-1', type: 'note', version: 1, modifiedAt: 1, size: 10 },
        ...tasks.map((id) => ({ id, type: 'task', version: 1, modifiedAt: 1, size: 10 }))
      ],
      deleted: [],
      hasMore: false,
      nextCursor: 9,
      noteBodies: [update('note-1', 7, A)]
    })
    const pulls: string[][] = []
    vi.mocked(http.postToServer).mockImplementation(async (path: string, body: unknown) => {
      if (path === '/sync/crdt/updates/batch') return batch()
      const { itemIds } = body as { itemIds: string[] }
      pulls.push(itemIds)
      return {
        items: itemIds.map((id) => ({
          id,
          type: id === 'note-1' ? 'note' : 'task',
          operation: 'update',
          cryptoVersion: 1,
          blob: { encryptedKey: 'ek', keyNonce: 'kn', encryptedData: 'ed', dataNonce: 'dn' },
          signature: 'sig',
          signerDeviceId: 'device-2',
          clock: { 'device-2': 2 }
        }))
      }
    })

    await engine.pull()

    expect(pulls).toHaveLength(3)
    expect(pulls[0]).toContain('note-1')
    expect(batch).toHaveBeenCalled()
    expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('9')
    expect(debts()).toEqual([])
    expect(engine.hasUnmergedRemoteCrdtState('note-1')).toBe(false)
  })

  // #2297: a missing base owes the whole body; a failed landing owes from its cursor.
  it('owes a missing base with no cursor and a failed landing from its page cursor', async () => {
    const provider = fakeProvider({ failStore: (noteId) => noteId === 'note-2' })
    provider.getStateVector.mockImplementation((noteId: string) =>
      noteId === 'note-1' ? new Uint8Array([0]) : new Uint8Array([1, 9, 1])
    )
    const engine = engineWith(getDb, provider)
    await mockServer([
      { noteBodies: [update('note-1', 3, A), update('note-2', 4, B)], nextCursor: 4 }
    ])

    await engine.pull()

    expect(debts()).toEqual([
      { noteId: 'note-1', reason: 'missing_base', lowestCursor: null },
      { noteId: 'note-2', reason: 'land_failed', lowestCursor: 4 }
    ])
  })
})
