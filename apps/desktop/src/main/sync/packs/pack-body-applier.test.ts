import sodium, {
  ready as sodiumReady,
  to_base64 as sodiumToBase64,
  base64_variants as sodiumBase64Variants
} from 'libsodium-wrappers-sumo'

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { decryptCrdtUpdate, encryptCrdtUpdate } from '../crdt-encrypt'
import type { PackIndexEntry } from '@memry/contracts/pack-format'

import type { DocumentPlan, PackedUpdate } from './body-plan'
import { createPackBodyApplier, decodeSignerPublicKeys } from './pack-body-applier'
import type { BodySeedStore } from './pack-body-applier'

interface SignKeyPair {
  publicKey: Uint8Array
  privateKey: Uint8Array
}

describe('pack body applier', () => {
  let vaultKey: Uint8Array
  let deviceA: SignKeyPair
  let deviceB: SignKeyPair
  let stranger: SignKeyPair

  let watermarks: Map<string, { appliedSequence: number; snapshotRevision?: string }>
  let applied: Array<{ noteId: string; update: Uint8Array }>
  let opened: Set<string>
  let openCalls: string[]
  let closeCalls: string[]
  let openFailures: Set<string>
  let pending: Set<string>
  let store: BodySeedStore

  beforeAll(async () => {
    await sodiumReady
    vaultKey = sodium.randombytes_buf(32, 'uint8array')
    deviceA = sodium.crypto_sign_keypair('uint8array')
    deviceB = sodium.crypto_sign_keypair('uint8array')
    stranger = sodium.crypto_sign_keypair('uint8array')
  })

  /**
   * Models `CrdtSyncProvider` where it actually bites: `applyRemoteUpdate` is
   * routed through the provider's live `docs` map and an update for a doc the
   * provider is not holding is logged and DROPPED (`crdt-provider.ts`, the
   * `if (!entry) return` branch), while `getStateVector` answers `null` for
   * that same doc. Pack bootstrap runs before the first pull, so nothing has
   * opened any of these docs — a store double that records every update
   * regardless would make a silently empty vault look like a green test.
   */
  beforeEach(() => {
    watermarks = new Map()
    applied = []
    opened = new Set()
    openCalls = []
    closeCalls = []
    openFailures = new Set()
    pending = new Set()
    store = {
      getSnapshotWatermark: async (noteId) => watermarks.get(noteId) ?? null,
      putSnapshotWatermark: async (noteId, watermark) => {
        watermarks.set(noteId, watermark)
      },
      openDoc: async (noteId) => {
        openCalls.push(noteId)
        if (openFailures.has(noteId)) throw new Error('crdt store unavailable')
        opened.add(noteId)
      },
      applyRemoteUpdate: (noteId, update) => {
        if (!opened.has(noteId)) return false
        applied.push({ noteId, update })
        return true
      },
      holdsPendingStructs: (noteId) => pending.has(noteId),
      getStateVector: (noteId) => {
        if (!opened.has(noteId)) return null
        return applied.some((entry) => entry.noteId === noteId)
          ? new Uint8Array([1, 220, 148, 3, 1])
          : new Uint8Array([0])
      },
      closeDoc: async (noteId) => {
        closeCalls.push(noteId)
        opened.delete(noteId)
      }
    }
  })

  const applier = (keys: Record<string, Uint8Array>) =>
    createPackBodyApplier({
      store,
      getVaultKey: async () => vaultKey,
      getSignerPublicKeys: async () => new Map(Object.entries(keys))
    })

  const entry = (id: string): PackIndexEntry => ({
    kind: 'crdt_snapshot',
    id,
    sourceKey: '',
    sortKey: 0,
    offset: 0,
    length: 0,
    sha256: new Uint8Array(32)
  })

  const sealed = (noteId: string, text: string, signer: SignKeyPair): Uint8Array =>
    encryptCrdtUpdate(new TextEncoder().encode(text), vaultKey, noteId, signer.privateKey)

  const snapshotPlan = (
    noteId: string,
    bytes: Uint8Array,
    sequenceNum: number,
    revision: string
  ): DocumentPlan => ({
    snapshot: { entry: entry(noteId), meta: { sequenceNum, revision }, read: async () => bytes },
    updates: [],
    watermark: { appliedSequence: sequenceNum, snapshotRevision: revision }
  })

  const update = (
    noteId: string,
    sequenceNum: number,
    signerDeviceId: string,
    bytes: Uint8Array
  ): PackedUpdate => ({
    entry: { ...entry(noteId), kind: 'crdt_update' },
    sequenceNum,
    signerDeviceId,
    createdAt: 1_700_000_000,
    read: async () => bytes
  })

  describe('signature verification', () => {
    it('seeds the doc when the snapshot verifies under one of several registered keys', async () => {
      const packed = sealed('note-1', 'a real yjs update would go here', deviceB)

      const reached = await applier({ a: deviceA.publicKey, b: deviceB.publicKey }).applyDocument(
        'note-1',
        snapshotPlan('note-1', packed, 11, 'rev-11')
      )

      expect(reached).toEqual({ appliedSequence: 11, snapshotRevision: 'rev-11' })
      expect(applied).toEqual([
        { noteId: 'note-1', update: new TextEncoder().encode('a real yjs update would go here') }
      ])
      // Exactly the watermark shape `snapshotBaselineSkip` reads as "this doc
      // already holds that baseline", which is what suppresses the GET.
      expect(watermarks.get('note-1')).toEqual({ appliedSequence: 11, snapshotRevision: 'rev-11' })
    })

    it.each([
      ['signed by an unregistered key', () => sealed('note-1', 'body', stranger)],
      ['signed for a different note', () => sealed('note-OTHER', 'body', deviceA)]
    ])('refuses a snapshot %s and never opens the doc', async (_label, bytes) => {
      const reached = await applier({ a: deviceA.publicKey, b: deviceB.publicKey }).applyDocument(
        'note-1',
        snapshotPlan('note-1', bytes(), 3, 'r')
      )

      expect(reached).toBeNull()
      expect(applied).toEqual([])
      expect(openCalls).toEqual([])
      // No watermark, so the sweep still fetches this note's baseline.
      expect(watermarks.has('note-1')).toBe(false)
    })

    it('refuses everything with no registered keys, no vault key or no store', async () => {
      const plan = snapshotPlan('note-1', sealed('note-1', 'body', deviceA), 3, 'r')
      await expect(applier({}).applyDocument('note-1', plan)).resolves.toBeNull()
      const noVaultKey = createPackBodyApplier({
        store,
        getVaultKey: async () => null,
        getSignerPublicKeys: async () => new Map([['a', deviceA.publicKey]])
      })
      await expect(noVaultKey.applyDocument('note-1', plan)).resolves.toBeNull()
      const noStore = createPackBodyApplier({
        store: null,
        getVaultKey: async () => vaultKey,
        getSignerPublicKeys: async () => new Map([['a', deviceA.publicKey]])
      })
      await expect(noStore.applyDocument('note-1', plan)).resolves.toBeNull()
      expect(applied).toEqual([])
      expect(watermarks.size).toBe(0)
    })

    // An account accumulates a key per device it ever linked; trying all of
    // them per snapshot cost 126 s of a 270 s pack phase on 17k notes (#5390).
    it('tries the key that verified the last snapshot first, and still finds a new signer', async () => {
      const others = Array.from({ length: 40 }, () => sodium.crypto_sign_keypair('uint8array'))
      const keys: Record<string, Uint8Array> = Object.fromEntries(
        others.map((pair, i) => [`old-${i}`, pair.publicKey])
      )
      keys.b = deviceB.publicKey
      keys.a = deviceA.publicKey
      const decrypt = vi.fn(decryptCrdtUpdate)
      const sut = createPackBodyApplier({
        store,
        getVaultKey: async () => vaultKey,
        getSignerPublicKeys: async () => new Map(Object.entries(keys)),
        decrypt
      })

      const notes = Array.from({ length: 20 }, (_, i) => `note-${i}`)
      for (const noteId of notes) {
        await sut.applyDocument(
          noteId,
          snapshotPlan(noteId, sealed(noteId, noteId, deviceA), 1, 'r')
        )
      }
      const reached = await sut.applyDocument(
        'note-b',
        snapshotPlan('note-b', sealed('note-b', 'from b', deviceB), 1, 'r')
      )

      expect(applied).toHaveLength(21)
      expect(reached).toEqual({ appliedSequence: 1, snapshotRevision: 'r' })
      // The first snapshot walks every key, the next 19 hit at once, and the
      // one from b walks at most every key again.
      expect(decrypt.mock.calls.length).toBeLessThanOrEqual(42 + 19 + 42)
    })

    it('resolves the registered keys once per bootstrap, not once per document', async () => {
      const getSignerPublicKeys = vi.fn(async () => new Map([['a', deviceA.publicKey]]))
      const sut = createPackBodyApplier({
        store,
        getVaultKey: async () => vaultKey,
        getSignerPublicKeys
      })

      await sut.applyDocument(
        'note-1',
        snapshotPlan('note-1', sealed('note-1', 'x', deviceA), 1, 'a')
      )
      await sut.applyDocument(
        'note-2',
        snapshotPlan('note-2', sealed('note-2', 'y', deviceA), 1, 'b')
      )

      expect(getSignerPublicKeys).toHaveBeenCalledTimes(1)
      expect(applied).toHaveLength(2)
    })
  })

  describe('packed updates', () => {
    const plain = (text: string) => new TextEncoder().encode(text)

    it('applies the snapshot then each update in order and records the last sequence', async () => {
      const plan: DocumentPlan = {
        ...snapshotPlan('note-1', sealed('note-1', 'base', deviceA), 4, 'r4'),
        updates: [
          update('note-1', 5, 'b', sealed('note-1', 'u5', deviceB)),
          update('note-1', 6, 'a', sealed('note-1', 'u6', deviceA))
        ],
        watermark: { appliedSequence: 6, snapshotRevision: 'r4' }
      }

      const reached = await applier({ a: deviceA.publicKey, b: deviceB.publicKey }).applyDocument(
        'note-1',
        plan
      )

      expect(applied.map((row) => row.update)).toEqual([plain('base'), plain('u5'), plain('u6')])
      expect(reached).toEqual({ appliedSequence: 6, snapshotRevision: 'r4' })
      expect(watermarks.get('note-1')).toEqual({ appliedSequence: 6, snapshotRevision: 'r4' })
      expect(openCalls).toEqual(['note-1'])
      expect(closeCalls).toEqual(['note-1'])
    })

    it.each([
      ['its named signer is not registered', 'c'],
      ['it verifies only under another registered key', 'a']
    ])('stops at an update when %s, vouching only for what applied', async (_label, signer) => {
      const plan: DocumentPlan = {
        ...snapshotPlan('note-1', sealed('note-1', 'base', deviceA), 4, 'r4'),
        updates: [
          update('note-1', 5, 'a', sealed('note-1', 'u5', deviceA)),
          // Signed by device b, but named as `signer`: chapter 07 §7.14 checks
          // the named device's key only.
          update('note-1', 6, signer, sealed('note-1', 'u6', deviceB)),
          update('note-1', 7, 'a', sealed('note-1', 'u7', deviceA))
        ],
        watermark: { appliedSequence: 7, snapshotRevision: 'r4' }
      }

      const reached = await applier({ a: deviceA.publicKey, b: deviceB.publicKey }).applyDocument(
        'note-1',
        plan
      )

      expect(applied.map((row) => row.update)).toEqual([plain('base'), plain('u5')])
      expect(reached).toEqual({ appliedSequence: 5, snapshotRevision: 'r4' })
      expect(watermarks.get('note-1')).toEqual({ appliedSequence: 5, snapshotRevision: 'r4' })
    })

    it('continues an update-only document from its local watermark without a revision', async () => {
      const plan: DocumentPlan = {
        snapshot: null,
        updates: [update('note-1', 1, 'a', sealed('note-1', 'u1', deviceA))],
        watermark: { appliedSequence: 1 }
      }

      const reached = await applier({ a: deviceA.publicKey }).applyDocument('note-1', plan)

      expect(reached).toEqual({ appliedSequence: 1 })
      expect(watermarks.get('note-1')).toEqual({ appliedSequence: 1 })
    })

    it('#given the doc holds pending structs #then no watermark vouches for it', async () => {
      pending.add('note-1')
      const plan: DocumentPlan = {
        ...snapshotPlan('note-1', sealed('note-1', 'base', deviceA), 4, 'r4'),
        updates: [update('note-1', 5, 'a', sealed('note-1', 'u5', deviceA))],
        watermark: { appliedSequence: 5, snapshotRevision: 'r4' }
      }

      const reached = await applier({ a: deviceA.publicKey }).applyDocument('note-1', plan)

      // The state stays in the doc; the item routes fill the missing dependency.
      expect(applied).toHaveLength(2)
      expect(reached).toBeNull()
      expect(watermarks.has('note-1')).toBe(false)
      expect(closeCalls).toEqual(['note-1'])
    })
  })

  describe('seeding an unopened doc', () => {
    const plan = () => snapshotPlan('note-1', sealed('note-1', 'body', deviceA), 4, 'r4')

    it('opens the doc before seeding and releases it afterwards', async () => {
      await expect(
        applier({ a: deviceA.publicKey }).applyDocument('note-1', plan())
      ).resolves.toEqual({ appliedSequence: 4, snapshotRevision: 'r4' })
      // Open FIRST: the provider drops an update for a doc it is not holding.
      expect(openCalls).toEqual(['note-1'])
      expect(applied.map((row) => row.noteId)).toEqual(['note-1'])
      // And released, so thousands of packed notes are not thousands of pinned
      // Y.Docs in the main process.
      expect(closeCalls).toEqual(['note-1'])
      expect(opened.size).toBe(0)
    })

    it.each([
      [
        'the doc cannot be opened',
        () => {
          openFailures.add('note-1')
        }
      ],
      [
        'the provider drops the update',
        () => {
          // A doc that closes underneath the seed: open resolves, the update
          // goes nowhere.
          store.openDoc = async (noteId) => {
            openCalls.push(noteId)
          }
        }
      ],
      [
        'the doc is still empty after the seed',
        () => {
          store.getStateVector = () => new Uint8Array([0])
        }
      ]
    ])('#given %s #then no watermark is written', async (_label, arrange) => {
      arrange()

      await expect(
        applier({ a: deviceA.publicKey }).applyDocument('note-1', plan())
      ).resolves.toBeNull()

      // The watermark is what suppresses `GET /sync/crdt/snapshot/:noteId`, so
      // writing one for a baseline that never landed loses the body forever.
      expect(watermarks.has('note-1')).toBe(false)
    })
  })

  describe('decodeSignerPublicKeys', () => {
    it('decodes what the device cache stores by device id and drops what it cannot', () => {
      const encoded = sodiumToBase64(deviceA.publicKey, sodiumBase64Variants.ORIGINAL)
      expect(
        decodeSignerPublicKeys([
          { deviceId: 'a', key: encoded },
          { deviceId: 'bad', key: '!!! not base64 !!!' }
        ])
      ).toEqual(new Map([['a', deviceA.publicKey]]))
    })
  })
})
