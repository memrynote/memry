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
  let store: SnapshotSeedStore

  beforeAll(async () => {
    await sodium.ready
    vaultKey = sodium.randombytes_buf(32, 'uint8array')
    deviceA = sodium.crypto_sign_keypair('uint8array')
    deviceB = sodium.crypto_sign_keypair('uint8array')
    stranger = sodium.crypto_sign_keypair('uint8array')
  })

  beforeEach(() => {
    watermarks = new Map()
    applied = []
    store = {
      getSnapshotWatermark: async (noteId) => watermarks.get(noteId) ?? null,
      putSnapshotWatermark: async (noteId, watermark) => {
        watermarks.set(noteId, watermark)
      },
      applyRemoteUpdate: (noteId, update) => {
        applied.push({ noteId, update })
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
