import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PackListResponse, PackSummary } from '@memry/contracts/sync-api'

import type { PageApplyHandle } from '../bulk-apply'
import { SYNC_STATE_KEYS } from '../engine/sync-context'
import { createPackBodyApplier } from './pack-body-applier'
import { contiguousAppliedCursor, runPackBootstrap, type PackBootstrapDeps } from './pack-bootstrap'
import { buildTestPack } from './test-pack-builder'
import type * as HttpClientModule from '../http-client'
import { NetworkError, RateLimitError, SyncServerError } from '../http-client'

// The whole point of pack-seeded bodies: not one item-granular CRDT request is
// issued for a note a pack covered. Mocking the module is how that is proved
// rather than asserted by eye.
const httpSpies = vi.hoisted(() => ({
  fetchCrdtSnapshot: vi.fn(),
  getFromServer: vi.fn()
}))

vi.mock('../http-client', async (importOriginal) => {
  const actual = await importOriginal<typeof HttpClientModule>()
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
  destPaths: string[]
  /** Times a second page-apply session was opened while one was already live. */
  overlaps: () => number
  openDocs: Set<string>
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
    const destPaths: string[] = []
    const openDocs = new Set<string>()
    const packFiles = new Map<string, Uint8Array>()
    const tempDir = path.join(tempRoot, 'packs')

    // A page handle that only lets writes made INSIDE it survive `commit()`,
    // so "the watermark is persisted atomically with the page" is testable.
    //
    // `active` models the real thing: `beginPageApply` is a process-wide
    // SINGLETON that throws while a session is open. Production runs three
    // pack workers, so the only reason concurrent commits are safe is that
    // begin -> setStateValue -> commit contains no await; a double handle here
    // would hide the day someone adds one.
    let pending: Array<{ key: string; value: string }> = []
    let active = false
    let overlaps = 0
    const beginPage = (): PageApplyHandle => {
      if (active) {
        overlaps++
        throw new Error('A bulk page apply session is already active')
      }
      active = true
      return {
        db: {} as PageApplyHandle['db'],
        transacted: true,
        afterCommit: () => {},
        commit: () => {
          for (const write of pending) {
            state.set(write.key, write.value)
            stateWrites.push({ ...write, committed: true })
          }
          pending = []
          active = false
        },
        rollback: () => {
          for (const write of pending) stateWrites.push({ ...write, committed: false })
          pending = []
          active = false
        },
        flushFiles: async () => {},
        savepoint: (apply) => apply(),
        flushFilesSync: () => {}
      } satisfies PageApplyHandle
    }

    const deps: PackBootstrapDeps = {
      getAccessToken: async () => 'jwt',
      tempDir,
      // An old server by default: no body manifest, so the pre-#5390 rule.
      readManifest: async () => null,
      bodies: createPackBodyApplier({
        // Models the provider contract that matters here: an update for a doc
        // the provider is not holding is dropped on the floor, and its state
        // vector reads back null.
        store: {
          getSnapshotWatermark: async (noteId) => watermarks.get(noteId) ?? null,
          putSnapshotWatermark: async (noteId, watermark) => {
            watermarks.set(noteId, watermark)
          },
          openDoc: async (noteId) => {
            openDocs.add(noteId)
          },
          applyRemoteUpdate: (noteId, update) => {
            if (!openDocs.has(noteId)) return false
            const list = docs.get(noteId) ?? []
            list.push(update)
            docs.set(noteId, list)
            return true
          },
          holdsPendingStructs: () => false,
          getStateVector: (noteId) => {
            if (!openDocs.has(noteId)) return null
            return docs.has(noteId) ? new Uint8Array([1, 220, 148, 3, 1]) : new Uint8Array([0])
          },
          closeDoc: async (noteId) => {
            openDocs.delete(noteId)
          }
        },
        getVaultKey: async () => new Uint8Array(32).fill(7),
        getSignerPublicKeys: async () => new Map([['device-a', new Uint8Array(32).fill(1)]]),
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
        destPaths.push(destPath)
        if (!bytes) throw new Error(`no pack fixture for ${id}`)
        await fs.mkdir(path.dirname(destPath), { recursive: true })
        await fs.writeFile(destPath, bytes)
        return { bytes: bytes.length, resumed: false }
      },
      ...over
    }

    return {
      deps,
      state,
      stateWrites,
      progress,
      docs,
      watermarks,
      downloaded,
      destPaths,
      overlaps: () => overlaps,
      openDocs,
      tempDir,
      packFiles
    }
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
        updatesApplied: 0,
        appliedThroughCursor: null
      })
      expect(harness.downloaded).toEqual([])
      expect(harness.stateWrites).toEqual([])
    })

    it('#given a pack with no presigned url #then it is never fetched', async () => {
      // A deployment without presign secrets: the expiry is perfectly valid,
      // so only the missing `url` can refuse this pack.
      const bare = packSummary({ id: 'p1' })
      delete (bare as { url?: string }).url
      const harness = makeHarness({ fetchPackPage: async () => listResponse([bare]) })

      const result = await runPackBootstrap(harness.deps)

      expect(result.usedPacks).toBe(false)
      expect(harness.downloaded).toEqual([])
      expect(harness.stateWrites).toEqual([])
    })

    it('#given a url with no expiry at all #then it is never fetched', async () => {
      const undated = packSummary({ id: 'p1' })
      delete (undated as { expiresAt?: number }).expiresAt
      const harness = makeHarness({ fetchPackPage: async () => listResponse([undated]) })

      expect(await runPackBootstrap(harness.deps)).toMatchObject({ usedPacks: false })
      expect(harness.downloaded).toEqual([])
    })

    it('#given an expiry inside the clock-skew margin #then it is never fetched', async () => {
      // now = 1_700_000_100. Ten seconds of validity left is inside the 30s
      // safety margin: a URL that expires while the transfer is being set up
      // is a 403 mid-run, not a transfer.
      const harness = makeHarness({
        fetchPackPage: async () =>
          listResponse([packSummary({ id: 'p1', expiresAt: 1_700_000_110 })])
      })

      expect(await runPackBootstrap(harness.deps)).toMatchObject({ usedPacks: false })
      expect(harness.downloaded).toEqual([])
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
      expect([...harness.docs.keys()].toSorted()).toEqual(['note-1', 'note-2', 'note-3', 'note-4'])
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
      const allNotes = [...harness.docs.keys(), ...resumed.docs.keys()].toSorted()
      expect(allNotes).toEqual(['note-1', 'note-2', 'note-3', 'note-4'])
      expect(resumed.state.get(SYNC_STATE_KEYS.PACKS_APPLIED_THROUGH_CURSOR)).toBe('100')
    })

    it('#given a document in two packs #then the older pack is not complete until its own documents ran', async () => {
      const controller = new AbortController()
      const harness = makeHarness({
        fetchPackPage: async () =>
          listResponse([
            packSummary({ id: 'p-new', maxCursor: 200 }),
            packSummary({ id: 'p-old', maxCursor: 100 })
          ]),
        signal: controller.signal
      })
      const snap = (id: string) => ({
        id,
        bytes: snapshotBytes(id),
        meta: { sequenceNum: 1, revision: id }
      })
      harness.packFiles.set('p-new', buildTestPack([snap('note-a'), snap('note-x')]).bytes)
      // note-a is p-old's last-listed document (dead bytes, protocol 08 §8.8).
      harness.packFiles.set('p-old', buildTestPack([snap('note-y'), snap('note-a')]).bytes)
      const originalEmit = harness.deps.emit
      harness.deps.emit = (channel, data) => {
        originalEmit(channel, data)
        if ((data as { processedItems: number }).processedItems >= 1) controller.abort()
      }

      await runPackBootstrap(harness.deps)

      expect(harness.docs.has('note-y')).toBe(false)
      // note-y never ran, so p-old's cursor must not be claimed.
      expect(harness.state.get(SYNC_STATE_KEYS.PACKS_APPLIED_THROUGH_CURSOR)).toBeUndefined()
    })

    it('#given a snapshot pack with no usable entry #then it completes and the watermark passes it', async () => {
      const harness = makeHarness({
        fetchPackPage: async () =>
          listResponse([
            packSummary({ id: 'p-new', maxCursor: 200 }),
            packSummary({ id: 'p-old', maxCursor: 100 })
          ])
      })
      harness.packFiles.set(
        'p-new',
        buildTestPack([
          { id: 'note-1', bytes: snapshotBytes('note-1'), meta: { sequenceNum: 1, revision: 'a' } }
        ]).bytes
      )
      // No freshness token: nothing in it can be applied.
      harness.packFiles.set(
        'p-old',
        buildTestPack([{ id: 'note-2', bytes: snapshotBytes('note-2') }]).bytes
      )

      await runPackBootstrap(harness.deps)

      expect(harness.state.get(SYNC_STATE_KEYS.PACKS_APPLIED_THROUGH_CURSOR)).toBe('200')
    })

    it('#given a persisted watermark #then covered packs are not downloaded again', async () => {
      const harness = makeHarness({
        fetchPackPage: async () =>
          listResponse([
            packSummary({ id: 'p-new', minCursor: 101, maxCursor: 200, itemCount: 1 }),
            // Exactly one cursor above the watermark: covered is covered, but
            // 101 is NOT, and an off-by-one in the filter would exclude it from
            // this run and — the watermark never moving past it — every run
            // after it too.
            packSummary({ id: 'p-edge', minCursor: 101, maxCursor: 101, itemCount: 1 }),
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
      harness.packFiles.set(
        'p-edge',
        buildTestPack([
          { id: 'note-e', bytes: snapshotBytes('note-e'), meta: { sequenceNum: 1, revision: 'e' } }
        ]).bytes
      )

      const result = await runPackBootstrap(harness.deps)

      expect(harness.downloaded).toEqual(['p-new', 'p-edge'])
      expect(result.entriesApplied).toBe(2)
      expect(result.appliedThroughCursor).toBe(200)
    })
  })

  describe('entry kinds', () => {
    it('#given a crdt_snapshot pack carrying other kinds #then only snapshots are seeded', async () => {
      // The pack-level guard refuses a `record` PACK; this is the entry-level
      // one. A record or update entry carries no signature metadata a client
      // can check, and seeding an incremental as if it were a baseline writes
      // the watermark that permanently suppresses the baseline GET.
      const harness = makeHarness({
        fetchPackPage: async () => listResponse([packSummary({ id: 'p1', itemCount: 3 })])
      })
      harness.packFiles.set(
        'p1',
        buildTestPack([
          {
            kind: 'crdt_update',
            id: 'note-update',
            bytes: snapshotBytes('note-update'),
            meta: { sequenceNum: 1, revision: 'u' }
          },
          {
            kind: 'record',
            id: 'note:note-record',
            bytes: snapshotBytes('note-record'),
            meta: { sequenceNum: 2, revision: 'v' }
          },
          {
            kind: 'crdt_snapshot',
            id: 'note-snapshot',
            bytes: snapshotBytes('note-snapshot'),
            meta: { sequenceNum: 3, revision: 'w' }
          }
        ]).bytes
      )

      const result = await runPackBootstrap(harness.deps)

      expect(result.entriesApplied).toBe(1)
      expect(result.entriesSkipped).toBe(2)
      expect([...harness.docs.keys()]).toEqual(['note-snapshot'])
      expect(harness.watermarks.has('note-update')).toBe(false)
      expect(harness.watermarks.has('note:note-record')).toBe(false)
    })
  })

  describe('update packs (#5390)', () => {
    const updateBytes = (noteId: string, seq: number): Uint8Array =>
      new TextEncoder().encode(`update:${noteId}:${seq}`)
    const updateEntry = (noteId: string, sequenceNum: number) => ({
      kind: 'crdt_update' as const,
      id: noteId,
      sourceKey: '',
      sortKey: 1000 + sequenceNum,
      meta: { sequenceNum, signerDeviceId: 'device-a', createdAt: 1_700_000_000 },
      bytes: updateBytes(noteId, sequenceNum)
    })
    const manifestDoc = (noteId: string, revision: string | null, floor = 0) => ({
      noteId,
      floor,
      maxSequenceNum: 9,
      snapshot: revision ? { revision, sequenceNum: 4 } : null
    })

    const harnessWith = (manifest: ReturnType<typeof manifestDoc>[] | null | 'short') => {
      const reads: string[] = []
      const harness = makeHarness({
        fetchPackPage: async () =>
          listResponse([
            packSummary({ id: 'p-snap', maxCursor: 200 }),
            packSummary({ id: 'p-upd', itemKind: 'crdt_update', maxCursor: 900 })
          ]),
        readManifest: async () => {
          reads.push(harness.downloaded.join(','))
          if (manifest === 'short' || manifest === null) return manifest
          return new Map(manifest.map((doc) => [doc.noteId, doc]))
        }
      })
      harness.packFiles.set(
        'p-snap',
        buildTestPack([
          { id: 'note-1', bytes: snapshotBytes('note-1'), meta: { sequenceNum: 4, revision: 'r4' } }
        ]).bytes
      )
      harness.packFiles.set(
        'p-upd',
        buildTestPack([
          updateEntry('note-1', 5),
          updateEntry('note-1', 6),
          updateEntry('note-2', 1),
          updateEntry('note-2', 3)
        ]).bytes
      )
      return { harness, reads }
    }

    it('applies a confirmed snapshot and the contiguous updates above it in one open', async () => {
      const { harness, reads } = harnessWith([
        manifestDoc('note-1', 'r4'),
        manifestDoc('note-2', null)
      ])

      const result = await runPackBootstrap(harness.deps)

      // The manifest is read once, after every pack is held (protocol 08 §8.4.3).
      expect(reads).toEqual(['p-snap,p-upd'])
      expect(harness.docs.get('note-1')).toEqual([
        snapshotBytes('note-1'),
        updateBytes('note-1', 5),
        updateBytes('note-1', 6)
      ])
      expect(harness.watermarks.get('note-1')).toEqual({
        appliedSequence: 6,
        snapshotRevision: 'r4'
      })
      // note-2 stops at the gap after 1: 3 waits for the routes.
      expect(harness.docs.get('note-2')).toEqual([updateBytes('note-2', 1)])
      expect(harness.watermarks.get('note-2')).toEqual({ appliedSequence: 1 })
      expect(result.updatesApplied).toBe(3)
      expect(httpSpies.getFromServer).not.toHaveBeenCalled()
    })

    it('#given an old server with no body manifest #then no packed update applies', async () => {
      const { harness } = harnessWith(null)

      const result = await runPackBootstrap(harness.deps)

      expect(harness.docs.get('note-1')).toEqual([snapshotBytes('note-1')])
      expect(harness.watermarks.get('note-1')).toEqual({
        appliedSequence: 4,
        snapshotRevision: 'r4'
      })
      expect(harness.docs.has('note-2')).toBe(false)
      expect(harness.watermarks.has('note-2')).toBe(false)
      expect(result.updatesApplied).toBe(0)
    })

    it('#given a manifest read that stopped short on a server with the route #then no packed body applies', async () => {
      const { harness } = harnessWith('short')

      const result = await runPackBootstrap(harness.deps)

      expect(harness.docs.size).toBe(0)
      expect(harness.watermarks.size).toBe(0)
      expect(result.entriesApplied).toBe(0)
      expect(harness.state.get(SYNC_STATE_KEYS.PACKS_APPLIED_THROUGH_CURSOR)).toBeUndefined()
    })

    it('#given a floor above packed updates #then they are never applied', async () => {
      const { harness } = harnessWith([
        manifestDoc('note-1', 'r4', 6),
        manifestDoc('note-2', null, 1)
      ])

      await runPackBootstrap(harness.deps)

      expect(harness.docs.get('note-1')).toEqual([snapshotBytes('note-1')])
      expect(harness.watermarks.get('note-1')).toEqual({
        appliedSequence: 4,
        snapshotRevision: 'r4'
      })
      expect(harness.docs.has('note-2')).toBe(false)
    })

    it('#given the server snapshot is newer than the packed one #then the document is left to the routes', async () => {
      const { harness } = harnessWith([manifestDoc('note-1', 'r5')])

      await runPackBootstrap(harness.deps)

      expect(harness.docs.has('note-1')).toBe(false)
      expect(harness.watermarks.has('note-1')).toBe(false)
      // Absent from the manifest: no body row at the read.
      expect(harness.docs.has('note-2')).toBe(false)
    })
  })

  describe('presigned url lifetime', () => {
    it('#given a url that expires mid-run #then it is re-signed rather than dropped', async () => {
      // Every URL in a page is signed once, at list time, with a TTL of
      // minutes. A vault big enough to need packs out-runs it: this models the
      // second transfer starting after the first one used up the whole TTL.
      let clock = 1_700_000_100_000
      const signed = (id: string, seconds: number): PackSummary =>
        packSummary({
          id,
          maxCursor: id === 'p-new' ? 200 : 100,
          itemCount: 1,
          url: `https://r2.example/${id}?exp=${seconds}`,
          expiresAt: seconds
        })
      const pages: string[] = []
      const harness = makeHarness({
        now: () => clock,
        fetchPackPage: async () => {
          const nowSeconds = Math.floor(clock / 1000)
          pages.push('list')
          return listResponse([
            signed('p-new', nowSeconds + 300),
            signed('p-old', nowSeconds + 300)
          ])
        },
        download: async ({ url, destPath }) => {
          const id = url.split('/').pop()!.split('?')[0]
          const expiresAt = Number(new URL(url).searchParams.get('exp'))
          // R2 answers an expired signature with a 403; the pack is lost.
          if (expiresAt <= Math.floor(clock / 1000)) {
            throw new Error(`pack fetch returned 403 for ${id}`)
          }
          // The transfer itself burns the whole remaining TTL.
          clock += 400_000
          const bytes = harness.packFiles.get(id)!
          await fs.mkdir(path.dirname(destPath), { recursive: true })
          await fs.writeFile(destPath, bytes)
          return { bytes: bytes.length, resumed: false }
        }
      })
      for (const [id, noteId] of [
        ['p-new', 'note-new'],
        ['p-old', 'note-old']
      ]) {
        harness.packFiles.set(
          id,
          buildTestPack([
            { id: noteId, bytes: snapshotBytes(noteId), meta: { sequenceNum: 1, revision: 'r' } }
          ]).bytes
        )
      }

      const result = await runPackBootstrap(harness.deps)

      // Both packs land: the second one's URL was re-minted, not abandoned.
      expect(result.entriesApplied).toBe(2)
      expect([...harness.docs.keys()].toSorted()).toEqual(['note-new', 'note-old'])
      expect(pages.length).toBe(2)
    })
  })

  describe('network drop (#5389, protocol 08 §8.12)', () => {
    const twoPacks = (harness: Harness): void => {
      harness.deps.fetchPackPage = async () =>
        listResponse([
          packSummary({ id: 'p-new', maxCursor: 200, itemCount: 1 }),
          packSummary({ id: 'p-old', maxCursor: 100, itemCount: 1 })
        ])
      for (const [id, noteId] of [
        ['p-new', 'note-new'],
        ['p-old', 'note-old']
      ]) {
        harness.packFiles.set(
          id,
          buildTestPack([
            { id: noteId, bytes: snapshotBytes(noteId), meta: { sequenceNum: 1, revision: 'r' } }
          ]).bytes
        )
      }
    }

    /** Fails each GET while `fault` answers an error, then serves the fixture. */
    const faulty = (harness: Harness, fault: (id: string, attempt: number) => Error | null) => {
      const serve = harness.deps.download!
      const attempts: string[] = []
      const sleeps: number[] = []
      harness.deps.sleep = async (ms) => {
        sleeps.push(ms)
      }
      harness.deps.download = async (options) => {
        const id = options.url.split('/').pop()!.split('?')[0]
        attempts.push(id)
        const error = fault(id, attempts.filter((seen) => seen === id).length)
        if (error) throw error
        return serve({ ...options, url: options.url.split('?')[0] })
      }
      return { attempts, sleeps }
    }

    it('#given a drop that outlasts the transport ladder #then the phase pauses and the lost pack downloads again', async () => {
      const harness = makeHarness()
      twoPacks(harness)
      const { attempts, sleeps } = faulty(harness, (id, attempt) =>
        id === 'p-new' && attempt === 1 ? new NetworkError('pack fetch failed: offline') : null
      )

      const result = await runPackBootstrap(harness.deps)

      expect(sleeps).toEqual([30_000])
      // No new GET starts once the phase is paused.
      expect(attempts).toEqual(['p-new', 'p-new', 'p-old'])
      expect(result.entriesApplied).toBe(2)
    })

    it('#given a drop longer than every pause #then the pack is a gap after the fourth', async () => {
      const harness = makeHarness()
      twoPacks(harness)
      const { sleeps } = faulty(harness, () => new SyncServerError('pack fetch returned 503', 503))

      const result = await runPackBootstrap(harness.deps)

      expect(sleeps).toEqual([30_000, 60_000, 120_000, 240_000])
      expect(result.usedPacks).toBe(false)
      expect(await fs.readdir(harness.tempDir)).toEqual([])
    })

    it('#given a 404 #then the pack is a gap at once, with no pause', async () => {
      const harness = makeHarness()
      twoPacks(harness)
      const { sleeps } = faulty(harness, (id) =>
        id === 'p-new' ? new SyncServerError('pack fetch returned 404', 404) : null
      )

      const result = await runPackBootstrap(harness.deps)

      expect(sleeps).toEqual([])
      expect([...harness.docs.keys()]).toEqual(['note-old'])
      expect(result.entriesApplied).toBe(1)
    })

    it('#given a 429 #then the pause lasts at least its Retry-After', async () => {
      const harness = makeHarness()
      twoPacks(harness)
      const { sleeps } = faulty(harness, (id, attempt) =>
        id === 'p-new' && attempt === 1 ? new RateLimitError(90) : null
      )

      await runPackBootstrap(harness.deps)

      expect(sleeps).toEqual([90_000])
    })

    it('#given a 403 on a url that expired during the drop #then the pack is re-listed and downloads', async () => {
      let clock = 1_700_000_100_000
      const pages: string[] = []
      const harness = makeHarness({ now: () => clock })
      twoPacks(harness)
      harness.deps.fetchPackPage = async () => {
        const nowSeconds = Math.floor(clock / 1000)
        pages.push('list')
        return listResponse([
          packSummary({
            id: 'p-new',
            itemCount: 1,
            url: `https://r2.example/p-new?exp=${nowSeconds + 300}`,
            expiresAt: nowSeconds + 300
          })
        ])
      }
      const { sleeps } = faulty(harness, (_id, attempt) => {
        if (attempt > 1) return null
        // The transport's retries outlive the signature; R2 answers 403.
        clock += 400_000
        return new SyncServerError('pack fetch returned 403', 403)
      })

      const result = await runPackBootstrap(harness.deps)

      expect(sleeps).toEqual([30_000])
      expect(pages).toEqual(['list', 'list'])
      expect(result.entriesApplied).toBe(1)
    })

    it('#given a re-list that fails during the drop #then the pack stays lost for the next pause', async () => {
      let clock = 1_700_000_100_000
      let lists = 0
      const harness = makeHarness({ now: () => clock })
      twoPacks(harness)
      harness.deps.fetchPackPage = async () => {
        lists++
        if (lists === 2) throw new NetworkError('offline')
        const nowSeconds = Math.floor(clock / 1000)
        return listResponse([
          packSummary({ id: 'p-new', itemCount: 1, expiresAt: nowSeconds + 60 })
        ])
      }
      const { sleeps } = faulty(harness, (_id, attempt) => {
        if (attempt > 1) return null
        clock += 60_000
        return new NetworkError('pack fetch failed: offline')
      })

      const result = await runPackBootstrap(harness.deps)

      expect(sleeps).toEqual([30_000, 60_000])
      expect(lists).toBe(3)
      expect(result.entriesApplied).toBe(1)
    })

    it('#given a 403 on a live url #then the pack is a gap with no pause', async () => {
      const harness = makeHarness()
      twoPacks(harness)
      const { sleeps } = faulty(harness, (id) =>
        id === 'p-new' ? new SyncServerError('pack fetch returned 403', 403) : null
      )

      const result = await runPackBootstrap(harness.deps)

      expect(sleeps).toEqual([])
      expect(result.entriesApplied).toBe(1)
    })
  })

  describe('pack listing', () => {
    it('#given more than one page #then every page is walked with its cursor', async () => {
      const cursors: Array<string | null> = []
      const harness = makeHarness({
        fetchPackPage: async (_token, cursor) => {
          cursors.push(cursor)
          if (cursor === null) {
            return {
              ...listResponse([packSummary({ id: 'p-new', maxCursor: 200, itemCount: 1 })]),
              nextCursor: 'c1'
            }
          }
          return listResponse([packSummary({ id: 'p-old', maxCursor: 100, itemCount: 1 })])
        }
      })
      for (const [id, noteId] of [
        ['p-new', 'note-new'],
        ['p-old', 'note-old']
      ]) {
        harness.packFiles.set(
          id,
          buildTestPack([
            { id: noteId, bytes: snapshotBytes(noteId), meta: { sequenceNum: 1, revision: 'r' } }
          ]).bytes
        )
      }

      const result = await runPackBootstrap(harness.deps)

      // The server caps a page at 50 packs; without the walk, everything older
      // than the newest page is invisible and silently item-granular.
      expect(cursors).toEqual([null, 'c1'])
      expect(harness.downloaded).toEqual(['p-new', 'p-old'])
      expect(result.entriesApplied).toBe(2)
    })

    it('#given no injected fetcher #then the real /sync/packs request is made', async () => {
      const harness = makeHarness()
      httpSpies.getFromServer
        .mockResolvedValueOnce({
          ...listResponse([packSummary({ id: 'p-new', maxCursor: 200, itemCount: 1 })]),
          nextCursor: 'c1'
        })
        .mockResolvedValueOnce(
          listResponse([packSummary({ id: 'p-old', maxCursor: 100, itemCount: 1 })])
        )
      for (const [id, noteId] of [
        ['p-new', 'note-new'],
        ['p-old', 'note-old']
      ]) {
        harness.packFiles.set(
          id,
          buildTestPack([
            { id: noteId, bytes: snapshotBytes(noteId), meta: { sequenceNum: 1, revision: 'r' } }
          ]).bytes
        )
      }

      const result = await runPackBootstrap(harness.deps)

      // A wrong path or a dropped cursor param 404s in production and this
      // module treats every 404 as "no packs" — green CI, dead feature.
      expect(httpSpies.getFromServer.mock.calls.map((call) => call[0])).toEqual([
        '/sync/packs?limit=50',
        '/sync/packs?limit=50&cursor=c1'
      ])
      expect(httpSpies.getFromServer.mock.calls.every((call) => call[1] === 'jwt')).toBe(true)
      expect(result.entriesApplied).toBe(2)
    })

    it('#given a listing truncated at the page ceiling #then no watermark is claimed', async () => {
      // Twenty pages of `nextCursor` and the walk stops: packs OLDER than
      // everything listed exist and were never seen, so "contiguous from the
      // oldest pack in hand" would claim a range nothing walked — and the
      // resume filter would then exclude those packs forever.
      let page = 0
      const harness = makeHarness({
        fetchPackPage: async () => {
          const packs = page === 0 ? [packSummary({ id: 'p1', itemCount: 1 })] : []
          page++
          return { ...listResponse(packs), nextCursor: `c${page}` }
        }
      })
      harness.packFiles.set(
        'p1',
        buildTestPack([
          { id: 'note-1', bytes: snapshotBytes('note-1'), meta: { sequenceNum: 1, revision: 'a' } }
        ]).bytes
      )

      const result = await runPackBootstrap(harness.deps)

      expect(result.entriesApplied).toBe(1)
      expect(result.appliedThroughCursor).toBeNull()
      expect(harness.state.get(SYNC_STATE_KEYS.PACKS_APPLIED_THROUGH_CURSOR)).toBeUndefined()
    })
  })

  describe('watermark contiguity', () => {
    it('#given the newest pack completes and an older one fails #then nothing is claimed', async () => {
      const harness = makeHarness({
        fetchPackPage: async () =>
          listResponse([
            packSummary({ id: 'p-new', minCursor: 101, maxCursor: 200, itemCount: 1 }),
            packSummary({ id: 'p-old', minCursor: 1, maxCursor: 100, itemCount: 1 })
          ])
      })
      // Only the newer pack has a fixture; the older transfer dies.
      harness.packFiles.set(
        'p-new',
        buildTestPack([
          { id: 'note-3', bytes: snapshotBytes('note-3'), meta: { sequenceNum: 1, revision: 'c' } }
        ]).bytes
      )

      const result = await runPackBootstrap(harness.deps)

      expect(result.entriesApplied).toBe(1)
      // A max-of-completed watermark would record 200 here and the resume
      // filter would drop p-old permanently, claiming a range never applied.
      expect(result.appliedThroughCursor).toBeNull()
      expect(harness.state.get(SYNC_STATE_KEYS.PACKS_APPLIED_THROUGH_CURSOR)).toBeUndefined()
    })

    it('#given two packs share a maxCursor and one fails #then the other is retried', async () => {
      // `crdt_snapshot` packs sort on created_at epoch seconds, which tie
      // heavily, and a same-second group over the byte target is split across
      // packs — so a tie must advance as a group or not at all.
      const list = async (): Promise<PackListResponse> =>
        listResponse([
          packSummary({ id: 'p-tie-a', minCursor: 1, maxCursor: 100, itemCount: 1 }),
          packSummary({ id: 'p-tie-b', minCursor: 1, maxCursor: 100, itemCount: 1 })
        ])
      const first = makeHarness({ fetchPackPage: list })
      first.packFiles.set(
        'p-tie-a',
        buildTestPack([
          { id: 'note-a', bytes: snapshotBytes('note-a'), meta: { sequenceNum: 1, revision: 'a' } }
        ]).bytes
      )

      const firstRun = await runPackBootstrap(first.deps)

      expect(first.downloaded).toEqual(['p-tie-a', 'p-tie-b'])
      expect(firstRun.entriesApplied).toBe(1)
      // 100 is also p-tie-b's maxCursor, and the resume filter is strictly
      // greater — recording it would exclude p-tie-b from every future run.
      expect(firstRun.appliedThroughCursor).toBeNull()
      expect(first.state.get(SYNC_STATE_KEYS.PACKS_APPLIED_THROUGH_CURSOR)).toBeUndefined()

      const second = makeHarness({ fetchPackPage: list })
      for (const [key, value] of first.state) second.state.set(key, value)
      for (const [noteId, watermark] of first.watermarks) second.watermarks.set(noteId, watermark)
      second.packFiles.set('p-tie-a', first.packFiles.get('p-tie-a')!)
      second.packFiles.set(
        'p-tie-b',
        buildTestPack([
          { id: 'note-b', bytes: snapshotBytes('note-b'), meta: { sequenceNum: 1, revision: 'b' } }
        ]).bytes
      )

      const secondRun = await runPackBootstrap(second.deps)

      expect(second.downloaded).toContain('p-tie-b')
      expect([...second.docs.keys()]).toEqual(['note-b'])
      expect(secondRun.appliedThroughCursor).toBe(100)
    })
  })

  describe('temp files', () => {
    it('#given a pack id with path separators #then the temp path stays inside the dir', async () => {
      const harness = makeHarness({
        fetchPackPage: async () => listResponse([packSummary({ id: '../../escape', itemCount: 1 })])
      })
      harness.packFiles.set(
        'escape',
        buildTestPack([
          { id: 'note-1', bytes: snapshotBytes('note-1'), meta: { sequenceNum: 1, revision: 'a' } }
        ]).bytes
      )

      await runPackBootstrap(harness.deps)

      // Pack ids come out of a server response body, and the path they build
      // is both written to and `rm -f`'d.
      expect(harness.destPaths).toHaveLength(1)
      const destPath = harness.destPaths[0]
      expect(path.dirname(path.resolve(destPath))).toBe(path.resolve(harness.tempDir))
      expect(path.basename(destPath)).toBe('______escape.pack')
    })
  })

  describe('parallel transfers', () => {
    const manyPacks = (count: number): PackSummary[] =>
      Array.from({ length: count }, (_, i) =>
        packSummary({ id: `p${i}`, minCursor: i * 100 + 1, maxCursor: (i + 1) * 100, itemCount: 4 })
      )

    const withPool = (parallel: number): { harness: Harness; peak: () => number } => {
      let inFlight = 0
      let peak = 0
      const harness = makeHarness({
        maxParallelDownloads: parallel,
        fetchPackPage: async () => listResponse(manyPacks(6)),
        download: async ({ url, destPath }) => {
          inFlight++
          peak = Math.max(peak, inFlight)
          try {
            await new Promise((resolve) => setTimeout(resolve, 1))
            const id = url.split('/').pop()!
            const bytes = harness.packFiles.get(id)!
            await fs.mkdir(path.dirname(destPath), { recursive: true })
            await fs.writeFile(destPath, bytes)
            return { bytes: bytes.length, resumed: false }
          } finally {
            inFlight--
          }
        }
      })
      for (let i = 0; i < 6; i++) {
        harness.packFiles.set(
          `p${i}`,
          buildTestPack(
            Array.from({ length: 4 }, (_, entry) => ({
              id: `note-${i}-${entry}`,
              bytes: snapshotBytes(`note-${i}-${entry}`),
              meta: { sequenceNum: 1, revision: `r${i}${entry}` }
            }))
          ).bytes
        )
      }
      return { harness, peak: () => peak }
    }

    it('#given the production pool width #then transfers overlap and pages never do', async () => {
      const { harness, peak } = withPool(3)

      const result = await runPackBootstrap(harness.deps)

      expect(peak()).toBe(3)
      expect(result.entriesApplied).toBe(24)
      // begin -> setStateValue -> commit holds no await, which is the only
      // reason three workers can share a process-wide singleton session.
      expect(harness.overlaps()).toBe(0)
      expect(result.appliedThroughCursor).toBe(600)
    })

    it('#given a pool width of one #then transfers are serialized', async () => {
      const { harness, peak } = withPool(1)

      await runPackBootstrap(harness.deps)

      expect(peak()).toBe(1)
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
