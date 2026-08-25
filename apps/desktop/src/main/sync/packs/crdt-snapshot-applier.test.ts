import sodium from 'libsodium-wrappers-sumo'

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { encryptCrdtUpdate } from '../crdt-encrypt'
import { createCrdtSnapshotApplier, decodeSignerPublicKeys } from './crdt-snapshot-applier'
import type { SnapshotSeedStore } from './crdt-snapshot-applier'

interface SignKeyPair {
  publicKey: Uint8Array
  privateKey: Uint8Array
}

describe('crdt snapshot pack applier', () => {
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
  let store: SnapshotSeedStore

  beforeAll(async () => {
    await sodium.ready
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
        if (!opened.has(noteId)) return
        applied.push({ noteId, update })
      },
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

  const applier = (keys: Uint8Array[]) =>
    createCrdtSnapshotApplier({
      store,
      getVaultKey: async () => vaultKey,
      getSignerPublicKeys: async () => keys
    })

  describe('freshness gate', () => {
    it('#given no local watermark #then the packed bytes are applied', async () => {
      await expect(
        applier([deviceA.publicKey]).shouldApply('note-1', { sequenceNum: 3, revision: 'r' })
      ).resolves.toBe(true)
    })

    it('#given local state at or beyond the packed sequence #then the bytes are stale', async () => {
      watermarks.set('note-1', { appliedSequence: 5, snapshotRevision: 'other' })
      const sut = applier([deviceA.publicKey])
      await expect(sut.shouldApply('note-1', { sequenceNum: 5, revision: 'r' })).resolves.toBe(
        false
      )
      await expect(sut.shouldApply('note-1', { sequenceNum: 4, revision: 'r' })).resolves.toBe(
        false
      )
      await expect(sut.shouldApply('note-1', { sequenceNum: 6, revision: 'r' })).resolves.toBe(true)
    })

    it('#given the same revision already merged #then the bytes are redundant', async () => {
      watermarks.set('note-1', { appliedSequence: 2, snapshotRevision: 'rev-9' })
      await expect(
        applier([deviceA.publicKey]).shouldApply('note-1', { sequenceNum: 7, revision: 'rev-9' })
      ).resolves.toBe(false)
    })

    it('#given no CRDT store #then nothing is ever applied from a pack', async () => {
      const sut = createCrdtSnapshotApplier({
        store: null,
        getVaultKey: async () => vaultKey,
        getSignerPublicKeys: async () => [deviceA.publicKey]
      })
      await expect(sut.shouldApply('note-1', { sequenceNum: 1, revision: 'r' })).resolves.toBe(
        false
      )
      await expect(
        sut.apply('note-1', new Uint8Array([1]), { sequenceNum: 1, revision: 'r' })
      ).resolves.toBe(false)
    })
  })

  describe('signature verification', () => {
    it('seeds the doc when the blob verifies under one of several registered keys', async () => {
      const body = new TextEncoder().encode('a real yjs update would go here')
      const packed = encryptCrdtUpdate(body, vaultKey, 'note-1', deviceB.privateKey)

      const ok = await applier([deviceA.publicKey, deviceB.publicKey]).apply('note-1', packed, {
        sequenceNum: 11,
        revision: 'rev-11'
      })

      expect(ok).toBe(true)
      expect(applied).toEqual([{ noteId: 'note-1', update: body }])
      // Exactly the watermark shape `snapshotBaselineSkip` reads as "this doc
      // already holds that baseline", which is what suppresses the GET.
      expect(watermarks.get('note-1')).toEqual({
        appliedSequence: 11,
        snapshotRevision: 'rev-11'
      })
    })

    it('refuses a blob that verifies under no registered key', async () => {
      const packed = encryptCrdtUpdate(
        new TextEncoder().encode('body'),
        vaultKey,
        'note-1',
        stranger.privateKey
      )

      const ok = await applier([deviceA.publicKey, deviceB.publicKey]).apply('note-1', packed, {
        sequenceNum: 3,
        revision: 'r'
      })

      expect(ok).toBe(false)
      expect(applied).toEqual([])
      // No watermark, so the sweep still fetches this note's baseline.
      expect(watermarks.has('note-1')).toBe(false)
    })

    it('refuses a blob signed for a different note', async () => {
      const packed = encryptCrdtUpdate(
        new TextEncoder().encode('body'),
        vaultKey,
        'note-OTHER',
        deviceA.privateKey
      )

      await expect(
        applier([deviceA.publicKey]).apply('note-1', packed, { sequenceNum: 3, revision: 'r' })
      ).resolves.toBe(false)
      expect(applied).toEqual([])
    })

    it('refuses everything when the account has no registered keys', async () => {
      const packed = encryptCrdtUpdate(
        new TextEncoder().encode('body'),
        vaultKey,
        'note-1',
        deviceA.privateKey
      )
      await expect(
        applier([]).apply('note-1', packed, { sequenceNum: 3, revision: 'r' })
      ).resolves.toBe(false)
    })

    it('refuses everything when the vault key is unavailable', async () => {
      const sut = createCrdtSnapshotApplier({
        store,
        getVaultKey: async () => null,
        getSignerPublicKeys: async () => [deviceA.publicKey]
      })
      await expect(
        sut.apply('note-1', new Uint8Array([1, 2]), { sequenceNum: 1, revision: 'r' })
      ).resolves.toBe(false)
    })

    it('resolves the registered keys once per bootstrap, not once per entry', async () => {
      const getSignerPublicKeys = vi.fn(async () => [deviceA.publicKey])
      const sut = createCrdtSnapshotApplier({
        store,
        getVaultKey: async () => vaultKey,
        getSignerPublicKeys
      })
      const packed = (noteId: string) =>
        encryptCrdtUpdate(new TextEncoder().encode(noteId), vaultKey, noteId, deviceA.privateKey)

      await sut.apply('note-1', packed('note-1'), { sequenceNum: 1, revision: 'a' })
      await sut.apply('note-2', packed('note-2'), { sequenceNum: 1, revision: 'b' })

      expect(getSignerPublicKeys).toHaveBeenCalledTimes(1)
      expect(applied).toHaveLength(2)
    })
  })

  describe('seeding an unopened doc', () => {
    const packedFor = (noteId: string): Uint8Array =>
      encryptCrdtUpdate(new TextEncoder().encode('body'), vaultKey, noteId, deviceA.privateKey)

    it('opens the doc before seeding and releases it afterwards', async () => {
      const ok = await applier([deviceA.publicKey]).apply('note-1', packedFor('note-1'), {
        sequenceNum: 4,
        revision: 'r4'
      })

      expect(ok).toBe(true)
      // Open FIRST: the provider drops an update for a doc it is not holding.
      expect(openCalls).toEqual(['note-1'])
      expect(applied.map((entry) => entry.noteId)).toEqual(['note-1'])
      // And released, so hundreds of packed notes are not hundreds of pinned
      // Y.Docs in the main process.
      expect(closeCalls).toEqual(['note-1'])
      expect(opened.size).toBe(0)
    })

    it('#given the doc cannot be opened #then no watermark is written', async () => {
      openFailures.add('note-1')

      const ok = await applier([deviceA.publicKey]).apply('note-1', packedFor('note-1'), {
        sequenceNum: 4,
        revision: 'r4'
      })

      expect(ok).toBe(false)
      expect(applied).toEqual([])
      // The watermark is what suppresses `GET /sync/crdt/snapshot/:noteId`, so
      // writing one for a baseline that never landed loses the body forever.
      expect(watermarks.has('note-1')).toBe(false)
    })

    it('#given the update is dropped by the provider #then no watermark is written', async () => {
      // A doc that closes underneath the seed: open resolves, the update goes
      // nowhere, and the doc stays empty.
      store.openDoc = async (noteId) => {
        openCalls.push(noteId)
      }

      const ok = await applier([deviceA.publicKey]).apply('note-1', packedFor('note-1'), {
        sequenceNum: 4,
        revision: 'r4'
      })

      expect(ok).toBe(false)
      expect(applied).toEqual([])
      expect(watermarks.has('note-1')).toBe(false)
    })

    it('#given the doc is still empty after the seed #then no watermark is written', async () => {
      // Applied, but the doc holds nothing: an empty state vector is exactly
      // the "no CRDT state" signal the sweep's seed fallback exists for.
      store.getStateVector = () => new Uint8Array([0])

      const ok = await applier([deviceA.publicKey]).apply('note-1', packedFor('note-1'), {
        sequenceNum: 4,
        revision: 'r4'
      })

      expect(ok).toBe(false)
      expect(watermarks.has('note-1')).toBe(false)
      // Released even on the refusal path.
      expect(closeCalls).toEqual(['note-1'])
    })

    it('#given the blob never verifies #then the doc is never opened at all', async () => {
      const ok = await applier([deviceB.publicKey]).apply('note-1', packedFor('note-1'), {
        sequenceNum: 4,
        revision: 'r4'
      })

      expect(ok).toBe(false)
      expect(openCalls).toEqual([])
    })
  })

  describe('decodeSignerPublicKeys', () => {
    it('decodes what the device cache stores and drops what it cannot', () => {
      const encoded = sodium.to_base64(deviceA.publicKey, sodium.base64_variants.ORIGINAL)
      expect(decodeSignerPublicKeys([encoded, '!!! not base64 !!!'])).toEqual([deviceA.publicKey])
    })

    it('is empty for an empty cache', () => {
      expect(decodeSignerPublicKeys([])).toEqual([])
    })
  })
})
