import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PackListResponse, PackSummary } from '@memry/contracts/sync-api'

import type { PageApplyHandle } from '../bulk-apply'
import { SYNC_STATE_KEYS } from '../engine/sync-context'
import { createCrdtSnapshotApplier } from './crdt-snapshot-applier'
import { contiguousAppliedCursor, runPackBootstrap, type PackBootstrapDeps } from './pack-bootstrap'
import { buildTestPack } from './test-pack-builder'

// The whole point of pack-seeded bodies: not one item-granular CRDT request is
// issued for a note a pack covered. Mocking the module is how that is proved
// rather than asserted by eye.
const httpSpies = vi.hoisted(() => ({
  fetchCrdtSnapshot: vi.fn(),
  getFromServer: vi.fn()
}))

vi.mock('../http-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../http-client')>()
  return { ...actual, ...httpSpies }
})

const snapshotBytes = (noteId: string): Uint8Array =>
  new TextEncoder().encode(`ciphertext:${noteId}`)

interface Harness {
  deps: PackBootstrapDeps
  state: Map<string, string>
  stateWrites: Array<{ key: string; value: string; committed: boolean }>
  progress: Array<{ phase: string; processedItems: number; totalItems: number }>
  docs: Map<string, Uint8Array[]>
  watermarks: Map<string, { appliedSequence: number; snapshotRevision?: string }>
  downloaded: string[]
  tempDir: string
  packFiles: Map<string, Uint8Array>
}

const packSummary = (over: Partial<PackSummary> & { id: string }): PackSummary => ({
  itemKind: 'crdt_snapshot',
  packKey: `packs/${over.id}`,
  minCursor: 1,
  maxCursor: 100,
  itemCount: 2,
  byteSize: 128,
  createdAt: 1_700_000_000,
  url: `https://r2.example/${over.id}`,
  expiresAt: 1_800_000_000,
  ...over
})

const listResponse = (packs: PackSummary[]): PackListResponse => ({
  packs,
  serverTime: 1_700_000_100
})

describe('runPackBootstrap', () => {
  let tempRoot: string

  const makeHarness = (over: Partial<PackBootstrapDeps> = {}): Harness => {
    const state = new Map<string, string>()
    const stateWrites: Harness['stateWrites'] = []
    const progress: Harness['progress'] = []
    const docs = new Map<string, Uint8Array[]>()
    const watermarks = new Map<string, { appliedSequence: number; snapshotRevision?: string }>()
    const downloaded: string[] = []
    const packFiles = new Map<string, Uint8Array>()
    const tempDir = path.join(tempRoot, 'packs')

    // A page handle that only lets writes made INSIDE it survive `commit()`,
    // so "the watermark is persisted atomically with the page" is testable.
    let pending: Array<{ key: string; value: string }> = []
    const beginPage = (): PageApplyHandle =>
      ({
        db: {} as PageApplyHandle['db'],
        commit: () => {
          for (const write of pending) {
            state.set(write.key, write.value)
            stateWrites.push({ ...write, committed: true })
          }
          pending = []
        },
        rollback: () => {
          for (const write of pending) stateWrites.push({ ...write, committed: false })
          pending = []
        },
        flushFiles: async () => {}
      }) satisfies PageApplyHandle

    const deps: PackBootstrapDeps = {
      getAccessToken: async () => 'jwt',
      tempDir,
      snapshots: createCrdtSnapshotApplier({
        store: {
          getSnapshotWatermark: async (noteId) => watermarks.get(noteId) ?? null,
          putSnapshotWatermark: async (noteId, watermark) => {
            watermarks.set(noteId, watermark)
          },
          applyRemoteUpdate: (noteId, update) => {
            const list = docs.get(noteId) ?? []
            list.push(update)
            docs.set(noteId, list)
          }
        },
        getVaultKey: async () => new Uint8Array(32).fill(7),
        getSignerPublicKeys: async () => [new Uint8Array(32).fill(1)],
        decrypt: (packed) => packed
      }),
      beginPage,
      getStateValue: (key) => state.get(key) ?? undefined,
      setStateValue: (key, value) => {
        pending.push({ key, value })
      },
      emit: (_channel, data) => {
        progress.push(data as Harness['progress'][number])
      },
      now: () => 1_700_000_100_000,
      pageEntries: 2,
      maxParallelDownloads: 1,
      download: async ({ url, destPath }) => {
        const id = url.split('/').pop()!
        const bytes = packFiles.get(id)
        downloaded.push(id)
        if (!bytes) throw new Error(`no pack fixture for ${id}`)
        await fs.mkdir(path.dirname(destPath), { recursive: true })
        await fs.writeFile(destPath, bytes)
        return { bytes: bytes.length, resumed: false }
      },
      ...over
    }

    return { deps, state, stateWrites, progress, docs, watermarks, downloaded, tempDir, packFiles }
  }

  beforeEach(async () => {
    httpSpies.fetchCrdtSnapshot.mockReset()
    httpSpies.getFromServer.mockReset()
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'memry-pack-boot-'))
  })

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true })
  })

  describe('fallback to the item-granular bootstrap', () => {
    it('#given zero packs #then nothing is downloaded and no state is written', async () => {
      const harness = makeHarness({ fetchPackPage: async () => listResponse([]) })

      const result = await runPackBootstrap(harness.deps)

      expect(result.usedPacks).toBe(false)
      expect(harness.downloaded).toEqual([])
      expect(harness.stateWrites).toEqual([])
      expect(harness.state.get(SYNC_STATE_KEYS.LAST_CURSOR)).toBeUndefined()
      expect(harness.progress).toEqual([])
    })

    it('#given an old server that 404s /sync/packs #then the same untouched fallback', async () => {
      const harness = makeHarness({
        fetchPackPage: async () => {
          throw Object.assign(new Error('Not found'), { status: 404 })
        }
      })

      const result = await runPackBootstrap(harness.deps)

      expect(result).toEqual({
        usedPacks: false,
        packsApplied: 0,
        entriesApplied: 0,
        entriesSkipped: 0,
        entriesFailed: 0,
        appliedThroughCursor: null
      })
      expect(harness.downloaded).toEqual([])
      expect(harness.stateWrites).toEqual([])
    })

    it('#given a pack with no presigned url #then it is never fetched', async () => {
      const bare = packSummary({ id: 'p1' })
      delete (bare as { url?: string }).url
      delete (bare as { expiresAt?: number }).expiresAt
      const harness = makeHarness({ fetchPackPage: async () => listResponse([bare]) })

      const result = await runPackBootstrap(harness.deps)

      expect(result.usedPacks).toBe(false)
      expect(harness.downloaded).toEqual([])
      expect(harness.stateWrites).toEqual([])
    })

    it('#given an already-expired presigned url #then it is never fetched', async () => {
      const harness = makeHarness({
        fetchPackPage: async () =>
          listResponse([packSummary({ id: 'p1', expiresAt: 1_700_000_050 })])
      })

      const result = await runPackBootstrap(harness.deps)

      expect(result.usedPacks).toBe(false)
      expect(harness.downloaded).toEqual([])
    })

    it('#given a malformed pack list #then schema validation refuses it', async () => {
      const harness = makeHarness({
        fetchPackPage: async () => ({ packs: [{ id: 5 }], serverTime: 'soon' })
      })

      const result = await runPackBootstrap(harness.deps)

      expect(result.usedPacks).toBe(false)
      expect(harness.downloaded).toEqual([])
    })

    it('#given record packs only #then they are refused (no signature metadata)', async () => {
      const harness = makeHarness({
        fetchPackPage: async () =>
          listResponse([packSummary({ id: 'p-records', itemKind: 'record' })])
      })

      const result = await runPackBootstrap(harness.deps)

      expect(result.usedPacks).toBe(false)
      expect(harness.downloaded).toEqual([])
      // The record cursor is what the item-granular pull runs on; nothing here
      // may move it.
      expect(harness.state.get(SYNC_STATE_KEYS.LAST_CURSOR)).toBeUndefined()
    })
  })

  describe('happy path', () => {
    it('applies both packs, persists the watermark and issues no snapshot GETs', async () => {
      const harness = makeHarness({
        fetchPackPage: async () =>
          listResponse([
            packSummary({ id: 'p-new', minCursor: 101, maxCursor: 200 }),
            packSummary({ id: 'p-old', minCursor: 1, maxCursor: 100 })
          ])
      })
      harness.packFiles.set(
        'p-old',
        buildTestPack([
          {
            id: 'note-1',
            bytes: snapshotBytes('note-1'),
            meta: { sequenceNum: 4, revision: 'r1' }
          },
          { id: 'note-2', bytes: snapshotBytes('note-2'), meta: { sequenceNum: 5, revision: 'r2' } }
        ]).bytes
      )
      harness.packFiles.set(
        'p-new',
        buildTestPack([
          {
            id: 'note-3',
            bytes: snapshotBytes('note-3'),
            meta: { sequenceNum: 6, revision: 'r3' }
          },
          { id: 'note-4', bytes: snapshotBytes('note-4'), meta: { sequenceNum: 7, revision: 'r4' } }
        ]).bytes
      )

      const result = await runPackBootstrap(harness.deps)

      expect(result.entriesApplied).toBe(4)
      expect(result.packsApplied).toBe(2)
      // Newest cursor range first, so recent notes land before old ones.
      expect(harness.downloaded).toEqual(['p-new', 'p-old'])
      expect([...harness.docs.keys()].sort()).toEqual(['note-1', 'note-2', 'note-3', 'note-4'])
      expect(harness.docs.get('note-3')).toEqual([snapshotBytes('note-3')])

      // Watermark: the highest cursor covered by an unbroken run from the
      // oldest pack up. Both landed, so the run reaches the newest pack.
      expect(result.appliedThroughCursor).toBe(200)
      expect(harness.state.get(SYNC_STATE_KEYS.PACKS_APPLIED_THROUGH_CURSOR)).toBe('200')
      // Every watermark write committed inside a page transaction.
      expect(harness.stateWrites.every((write) => write.committed)).toBe(true)
      expect(harness.stateWrites.map((write) => write.key)).toEqual(
        Array(harness.stateWrites.length).fill(SYNC_STATE_KEYS.PACKS_APPLIED_THROUGH_CURSOR)
      )

      // The record cursor never moves: the tail pull runs exactly as it does
      // on a server with no packs at all.
      expect(harness.state.get(SYNC_STATE_KEYS.LAST_CURSOR)).toBeUndefined()
      // And not one `GET /sync/crdt/snapshot/:noteId` for a seeded note.
      expect(httpSpies.fetchCrdtSnapshot).not.toHaveBeenCalled()
      expect(httpSpies.getFromServer).not.toHaveBeenCalled()

      // Each seeded note carries the watermark the sweep reads as "already
      // holds this baseline" (crdt-sync-coordinator snapshotBaselineSkip).
      expect(harness.watermarks.get('note-4')).toEqual({
        appliedSequence: 7,
        snapshotRevision: 'r4'
      })

      // Temp files never survive the run.
      expect(await fs.readdir(harness.tempDir)).toEqual([])
    })

    it('emits INITIAL_SYNC_PROGRESS on the additive packs phase', async () => {
      const harness = makeHarness({
        fetchPackPage: async () => listResponse([packSummary({ id: 'p1', itemCount: 2 })])
      })
      harness.packFiles.set(
        'p1',
        buildTestPack([
          { id: 'note-1', bytes: snapshotBytes('note-1'), meta: { sequenceNum: 1, revision: 'a' } },
          { id: 'note-2', bytes: snapshotBytes('note-2'), meta: { sequenceNum: 1, revision: 'b' } }
        ]).bytes
      )

      await runPackBootstrap(harness.deps)

      expect(harness.progress.length).toBeGreaterThan(0)
      expect(harness.progress.every((event) => event.phase === 'packs')).toBe(true)
      expect(harness.progress[0]).toEqual({ phase: 'packs', processedItems: 0, totalItems: 2 })
      expect(harness.progress.at(-1)).toEqual({
        phase: 'packs',
        processedItems: 2,
        totalItems: 2
      })
    })

    it('feeds pack bytes into the bootstrap throughput channel', async () => {
      const recordBytes = vi.fn()
      const harness = makeHarness({
        fetchPackPage: async () => listResponse([packSummary({ id: 'p1', itemCount: 1 })]),
        recordBytes
      })
      harness.packFiles.set(
        'p1',
        buildTestPack([
          { id: 'note-1', bytes: snapshotBytes('note-1'), meta: { sequenceNum: 1, revision: 'a' } }
        ]).bytes
      )

      await runPackBootstrap(harness.deps)

      expect(recordBytes).toHaveBeenCalledWith('crdt', snapshotBytes('note-1').byteLength)
    })
  })

  describe('corruption', () => {
    it('#given a pack whose payload digest is wrong #then the pack is discarded whole', async () => {
      const harness = makeHarness({
        fetchPackPage: async () => listResponse([packSummary({ id: 'p1' })])
      })
      harness.packFiles.set(
        'p1',
        buildTestPack(
          [
            {
              id: 'note-1',
              bytes: snapshotBytes('note-1'),
              meta: { sequenceNum: 1, revision: 'a' }
            }
          ],
          { breakPayloadDigest: true }
        ).bytes
      )

      const result = await runPackBootstrap(harness.deps)

      expect(result.entriesApplied).toBe(0)
      expect(harness.docs.size).toBe(0)
      // Nothing committed — an unreadable pack must not advance the watermark.
      expect(harness.stateWrites).toEqual([])
      expect(harness.state.get(SYNC_STATE_KEYS.PACKS_APPLIED_THROUGH_CURSOR)).toBeUndefined()
      expect(await fs.readdir(harness.tempDir)).toEqual([])
    })

    it('#given one bad entry digest #then only that entry falls back', async () => {
      const harness = makeHarness({
        fetchPackPage: async () => listResponse([packSummary({ id: 'p1', itemCount: 2 })])
      })
      harness.packFiles.set(
        'p1',
        buildTestPack(
          [
            {
              id: 'note-1',
              bytes: snapshotBytes('note-1'),
              meta: { sequenceNum: 1, revision: 'a' }
            },
            {
              id: 'note-2',
              bytes: snapshotBytes('note-2'),
              meta: { sequenceNum: 2, revision: 'b' }
            }
          ],
          { breakEntryDigestFor: ['note-2'] }
        ).bytes
      )

      const result = await runPackBootstrap(harness.deps)

      expect(result.entriesApplied).toBe(1)
      expect(result.entriesFailed).toBe(1)
      expect([...harness.docs.keys()]).toEqual(['note-1'])
      // note-2 keeps NO watermark, so the sweep still fetches its baseline.
      expect(harness.watermarks.has('note-2')).toBe(false)
    })

    it('#given a corrupt footer magic #then the run is not fatal', async () => {
      const harness = makeHarness({
        fetchPackPage: async () => listResponse([packSummary({ id: 'p1' })])
      })
      const pack = buildTestPack([
        { id: 'note-1', bytes: snapshotBytes('note-1'), meta: { sequenceNum: 1, revision: 'a' } }
      ])
      pack.bytes[pack.bytes.length - 5] = 0x00
      harness.packFiles.set('p1', pack.bytes)

      await expect(runPackBootstrap(harness.deps)).resolves.toMatchObject({ entriesApplied: 0 })
      expect(harness.stateWrites).toEqual([])
    })

    it('#given a dead transfer #then the temp file is still cleaned up', async () => {
      const harness = makeHarness({
        fetchPackPage: async () => listResponse([packSummary({ id: 'p1' })]),
        download: async () => {
          throw new Error('socket closed')
        }
      })

      const result = await runPackBootstrap(harness.deps)

      expect(result.usedPacks).toBe(false)
      expect(await fs.readdir(harness.tempDir)).toEqual([])
    })
  })

  describe('freshness', () => {
    it('#given local state at or beyond the packed snapshot #then the bytes are skipped', async () => {
      const harness = makeHarness({
        fetchPackPage: async () => listResponse([packSummary({ id: 'p1', itemCount: 2 })])
      })
      // note-1: already merged a NEWER sequence than the pack advertises.
      harness.watermarks.set('note-1', { appliedSequence: 9, snapshotRevision: 'newer' })
      // note-2: already merged this exact blob.
      harness.watermarks.set('note-2', { appliedSequence: 1, snapshotRevision: 'b' })
      harness.packFiles.set(
        'p1',
        buildTestPack([
          { id: 'note-1', bytes: snapshotBytes('note-1'), meta: { sequenceNum: 4, revision: 'a' } },
          { id: 'note-2', bytes: snapshotBytes('note-2'), meta: { sequenceNum: 2, revision: 'b' } }
        ]).bytes
      )

      const result = await runPackBootstrap(harness.deps)

      expect(result.entriesApplied).toBe(0)
      expect(result.entriesSkipped).toBe(2)
      expect(harness.docs.size).toBe(0)
      // Untouched: the item-granular sweep owns these notes now.
      expect(harness.watermarks.get('note-1')).toEqual({
        appliedSequence: 9,
        snapshotRevision: 'newer'
      })
    })

    it('#given an entry with no freshness token #then its bytes are not trusted', async () => {
      const harness = makeHarness({
        fetchPackPage: async () => listResponse([packSummary({ id: 'p1', itemCount: 2 })])
      })
      harness.packFiles.set(
        'p1',
        buildTestPack([
          { id: 'note-1', bytes: snapshotBytes('note-1') },
          { id: 'note-2', bytes: snapshotBytes('note-2'), meta: { sequenceNum: 2 } }
        ]).bytes
      )

      const result = await runPackBootstrap(harness.deps)

      expect(result.entriesApplied).toBe(0)
      expect(result.entriesSkipped).toBe(2)
      expect(harness.docs.size).toBe(0)
    })
  })

  describe('resume', () => {
    it('#given a run aborted mid-pack #then a resume applies each note exactly once', async () => {
      const controller = new AbortController()
      const harness = makeHarness({
        fetchPackPage: async () => listResponse([packSummary({ id: 'p1', itemCount: 4 })]),
        signal: controller.signal
      })
      harness.packFiles.set(
        'p1',
        buildTestPack([
          { id: 'note-1', bytes: snapshotBytes('note-1'), meta: { sequenceNum: 1, revision: 'a' } },
          { id: 'note-2', bytes: snapshotBytes('note-2'), meta: { sequenceNum: 1, revision: 'b' } },
          { id: 'note-3', bytes: snapshotBytes('note-3'), meta: { sequenceNum: 1, revision: 'c' } },
          { id: 'note-4', bytes: snapshotBytes('note-4'), meta: { sequenceNum: 1, revision: 'd' } }
        ]).bytes
      )

      // Abort as soon as the first page commits (pageEntries = 2).
      const originalEmit = harness.deps.emit
      harness.deps.emit = (channel, data) => {
        originalEmit(channel, data)
        const event = data as { processedItems: number }
        if (event.processedItems >= 2) controller.abort()
      }

      const first = await runPackBootstrap(harness.deps)
      expect(first.entriesApplied).toBe(2)
      expect([...harness.docs.keys()]).toEqual(['note-1', 'note-2'])
      // The pack never finished, so its cursor is NOT claimed as covered.
      expect(harness.state.get(SYNC_STATE_KEYS.PACKS_APPLIED_THROUGH_CURSOR)).toBeUndefined()

      // Resume with a live signal and the state the first run left behind.
      const resumed = makeHarness({
        fetchPackPage: harness.deps.fetchPackPage!,
        download: harness.deps.download!
      })
      resumed.packFiles.set('p1', harness.packFiles.get('p1')!)
      for (const [key, value] of harness.state) resumed.state.set(key, value)
      for (const [noteId, watermark] of harness.watermarks) {
        resumed.watermarks.set(noteId, watermark)
      }

      const second = await runPackBootstrap(resumed.deps)

      // Only the two that never landed. note-1/note-2 fail the freshness gate.
      expect(second.entriesApplied).toBe(2)
      expect(second.entriesSkipped).toBe(2)
      expect([...resumed.docs.keys()]).toEqual(['note-3', 'note-4'])
      // No gap and no double-apply across the two runs.
      const allNotes = [...harness.docs.keys(), ...resumed.docs.keys()].sort()
      expect(allNotes).toEqual(['note-1', 'note-2', 'note-3', 'note-4'])
      expect(resumed.state.get(SYNC_STATE_KEYS.PACKS_APPLIED_THROUGH_CURSOR)).toBe('100')
    })

    it('#given a persisted watermark #then covered packs are not downloaded again', async () => {
      const harness = makeHarness({
        fetchPackPage: async () =>
          listResponse([
            packSummary({ id: 'p-new', minCursor: 101, maxCursor: 200, itemCount: 1 }),
            packSummary({ id: 'p-old', minCursor: 1, maxCursor: 100, itemCount: 1 })
          ])
      })
      harness.state.set(SYNC_STATE_KEYS.PACKS_APPLIED_THROUGH_CURSOR, '100')
      harness.packFiles.set(
        'p-new',
        buildTestPack([
          { id: 'note-3', bytes: snapshotBytes('note-3'), meta: { sequenceNum: 1, revision: 'c' } }
        ]).bytes
      )

      const result = await runPackBootstrap(harness.deps)

      expect(harness.downloaded).toEqual(['p-new'])
      expect(result.entriesApplied).toBe(1)
      expect(result.appliedThroughCursor).toBe(200)
    })
  })
})

describe('contiguousAppliedCursor', () => {
  const p = (id: string, maxCursor: number): PackSummary => packSummary({ id, maxCursor })

  it('advances only across an unbroken run from the oldest pack', () => {
    const packs = [p('a', 100), p('b', 200), p('c', 300)]
    expect(contiguousAppliedCursor(packs, new Set(['a', 'b']))).toBe(200)
    // The newest pack finishing first must NOT claim the ranges below it.
    expect(contiguousAppliedCursor(packs, new Set(['c']))).toBeNull()
    expect(contiguousAppliedCursor(packs, new Set(['a', 'c']))).toBe(100)
    expect(contiguousAppliedCursor(packs, new Set(['a', 'b', 'c']))).toBe(300)
  })

  it('is null when nothing completed', () => {
    expect(contiguousAppliedCursor([p('a', 100)], new Set())).toBeNull()
  })
})
