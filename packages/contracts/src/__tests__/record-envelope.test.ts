/**
 * Verifier for `record-envelope.json` (T067).
 *
 * Three things, in this order of importance:
 *
 *  1. VERIFY the signature rather than only comparing bytes. A vector that only
 *     compares strings passes for an implementation that signs nothing.
 *  2. DECRYPT and assert the plaintext equals the recorded content, so the
 *     round trip is proven in both directions — a generator bug that is
 *     symmetric would otherwise pass.
 *  3. Assert `encryptRecordForPush` reproduces the committed `pushItem`
 *     byte-for-byte from the same injected material.
 *
 * Desktop's `encryptItemForPush` is asserted against the same file in
 * `apps/desktop/src/main/sync/vector-parity.test.ts`; together the two keep the
 * repository's two record writers from drifting.
 */
import sodium from 'libsodium-wrappers-sumo'
import { beforeAll, describe, expect, it } from 'vitest'

import { decryptRecordItem } from '../../../sync-client/src/pull/record-decrypt.ts'
import { encryptRecordForPush } from '../../../sync-client/src/push/record-encrypt.ts'
import { compressPayload } from '../../../sync-client/src/compress.ts'
import {
  NOTE_SYNC_MAX_BYTES,
  SYNC_ITEM_ENCRYPT_OVERHEAD,
  SYNC_ITEM_MAX_ENCRYPT_BYTES
} from '../../../sync-client/src/note-size.ts'
import { deterministicProvider, fromHex, hex } from '../../test-vectors/deterministic-provider'
import { loadVectorFile } from './vector-loader'

interface PushItem {
  id: string
  type: string
  operation: string
  encryptedKey: string
  keyNonce: string
  encryptedData: string
  dataNonce: string
  signature: string
  signerDeviceId: string
  clock?: Record<string, number>
  stateVector?: string
  deletedAt?: number
}

interface Case {
  name: string
  pins: string
  input: {
    id: string
    type: string
    operation: string
    contentUtf8: string
    vaultKeyHex: string
    signingSeedHex: string
    fileKeyHex: string
    dataNonceHex: string
    keyNonceHex: string
    clock: Record<string, number> | null
    stateVector: string | null
    deletedAt: number | null
  }
  expected: {
    compressedHex: string
    pushItem: PushItem
    sizeBytes: number
    roundTripUtf8: string
  }
}

const vectors = loadVectorFile<{
  meta: { caseCount: number; sizeCeiling: Record<string, number> }
  cases: Case[]
  tamperCases: Array<{
    name: string
    pushItem: PushItem
    signerPublicKeyHex: string
    expectFailure: string
    pins: string
  }>
  sizeCeilingCases: Array<{
    name: string
    contentBytes: number
    expectThrows: boolean
    expectErrorName?: string
    pins: string
  }>
}>('record-envelope.json')

describe('record-envelope vectors', () => {
  beforeAll(async () => {
    await sodium.ready
  })

  it('carries the recorded case count', () => {
    expect(
      vectors.cases.length + vectors.tamperCases.length + vectors.sizeCeilingCases.length
    ).toBe(vectors.meta.caseCount)
  })

  it('the size ceiling matches the production constants', () => {
    expect(vectors.meta.sizeCeiling).toEqual({
      SYNC_ITEM_MAX_ENCRYPT_BYTES,
      SYNC_ITEM_ENCRYPT_OVERHEAD,
      NOTE_SYNC_MAX_BYTES
    })
  })

  for (const entry of vectors.cases) {
    it(`${entry.name}: the writer reproduces the committed envelope`, async () => {
      const crypto = deterministicProvider({
        fileKeyHex: entry.input.fileKeyHex,
        dataNonceHex: entry.input.dataNonceHex,
        keyNonceHex: entry.input.keyNonceHex
      })
      const signer = sodium.crypto_sign_seed_keypair(fromHex(entry.input.signingSeedHex))
      const content = new TextEncoder().encode(entry.input.contentUtf8)

      expect(hex(compressPayload(content)), 'the compression stage').toBe(
        entry.expected.compressedHex
      )

      const { pushItem, sizeBytes } = await encryptRecordForPush(crypto, {
        id: entry.input.id,
        type: entry.input.type as never,
        operation: entry.input.operation as never,
        content,
        vaultKey: fromHex(entry.input.vaultKeyHex),
        signingSecretKey: signer.privateKey,
        signerDeviceId: entry.expected.pushItem.signerDeviceId,
        ...(entry.input.clock ? { clock: entry.input.clock } : {}),
        ...(entry.input.stateVector ? { stateVector: entry.input.stateVector } : {}),
        ...(entry.input.deletedAt !== null ? { deletedAt: entry.input.deletedAt } : {})
      })

      expect(pushItem, entry.pins).toEqual(entry.expected.pushItem)
      expect(sizeBytes).toBe(entry.expected.sizeBytes)
      // Omission, not null: an absent key is a different signed byte string
      // from a key carrying an empty value.
      if (entry.input.clock === null) expect('clock' in pushItem).toBe(false)
      if (entry.input.deletedAt === null) expect('deletedAt' in pushItem).toBe(false)
    })

    it(`${entry.name}: the reader verifies and decrypts it`, async () => {
      const crypto = deterministicProvider()
      const signer = sodium.crypto_sign_seed_keypair(fromHex(entry.input.signingSeedHex))
      const plaintext = await decryptRecordItem(
        crypto,
        { ...entry.expected.pushItem, cryptoVersion: 1 } as never,
        fromHex(entry.input.vaultKeyHex),
        signer.publicKey
      )
      expect(new TextDecoder().decode(plaintext)).toBe(entry.expected.roundTripUtf8)
      expect(entry.expected.roundTripUtf8).toBe(entry.input.contentUtf8)
    })
  }

  for (const entry of vectors.tamperCases) {
    it(entry.name, async () => {
      const crypto = deterministicProvider()
      const firstCase = vectors.cases[0]
      await expect(
        decryptRecordItem(
          crypto,
          { ...entry.pushItem, cryptoVersion: 1 } as never,
          fromHex(firstCase.input.vaultKeyHex),
          fromHex(entry.signerPublicKeyHex)
        ),
        entry.pins
      ).rejects.toThrow(/Signature verification failed/)
    })
  }

  for (const entry of vectors.sizeCeilingCases) {
    it(entry.name, async () => {
      const crypto = deterministicProvider()
      const signer = sodium.crypto_sign_seed_keypair(fromHex(vectors.cases[0].input.signingSeedHex))
      const call = (): Promise<unknown> =>
        encryptRecordForPush(crypto, {
          id: 'sizecheck0001',
          type: 'note' as never,
          operation: 'create' as never,
          content: new Uint8Array(entry.contentBytes),
          vaultKey: fromHex(vectors.cases[0].input.vaultKeyHex),
          signingSecretKey: signer.privateKey,
          signerDeviceId: 'device-a',
          clock: { 'device-a': 1 }
        })

      if (entry.expectThrows) {
        await expect(call(), entry.pins).rejects.toThrow()
      } else {
        await expect(call(), entry.pins).resolves.toBeDefined()
      }
    })
  }
})
