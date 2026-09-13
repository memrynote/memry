/**
 * Class: signed record envelope (`record-envelope.json`), 14 cases.
 *
 * Generated through the production writer
 * `packages/sync-client/src/push/record-encrypt.ts` and read back through
 * `packages/sync-client/src/pull/record-decrypt.ts`, with the deterministic
 * provider supplying the file key and both nonces.
 *
 * WHY NOT DESKTOP'S WRITER, which conformance-vectors.md §5 names.
 * `apps/desktop/src/main/sync/encrypt.ts` reaches
 * `apps/desktop/src/main/crypto/primitives.ts` → `memory-lock.ts` →
 * `apps/desktop/src/main/lib/logger.ts` → `electron-log`, so importing it into
 * a `packages/contracts` script drags Electron into a package that must not
 * depend on an app (the same boundary conformance-vectors.md §10 refuses to
 * breach for the pack writer). The parity assertion §5 asks for is not lost —
 * it moves to `apps/desktop/src/main/sync/vector-parity.test.ts`, which runs in
 * `pnpm test:desktop` where desktop's modules are importable and asserts
 * desktop's `encryptItemForPush` produces byte-identical output to this file.
 * Both TypeScript writers are therefore pinned to one committed artefact,
 * which is what §5 exists to achieve.
 *
 * THE TWO VAULT-NAME CASES live in that desktop test too, for the same reason:
 * `apps/desktop/src/main/sync/vault-name-crypto.ts` is the only implementation
 * of that envelope and it sits behind the same import chain. They are asserted
 * there in both directions, including the null-on-failure contract that
 * differs from every other envelope in this chapter.
 *
 * Chapters: docs/protocol/04-record-envelope.md, docs/protocol/05-record-sync.md.
 */
import { encryptRecordForPush } from '../../../sync-client/src/push/record-encrypt.ts'
import { decryptRecordItem } from '../../../sync-client/src/pull/record-decrypt.ts'
import { compressPayload } from '../../../sync-client/src/compress.ts'
import {
  NOTE_SYNC_MAX_BYTES,
  SYNC_ITEM_ENCRYPT_OVERHEAD,
  SYNC_ITEM_MAX_ENCRYPT_BYTES
} from '../../../sync-client/src/note-size.ts'
import type { SyncItemType, SyncOperation, VectorClock } from '../../src/sync-api'
import {
  FIXED,
  b64,
  deterministicProvider,
  fromHex,
  hex,
  signerFromSeed,
  utf8
} from '../../test-vectors/deterministic-provider'
import { meta } from './shared'

const VAULT_KEY = '0f1e2d3c4b5a69788796a5b4c3d2e1f00112233445566778899aabbccddeeff0'

interface Spec {
  name: string
  id: string
  type: SyncItemType
  operation: SyncOperation
  content: string
  clock?: VectorClock
  stateVector?: string
  deletedAt?: number
  dataNonceHex?: string
  pins: string
}

/** Deterministic incompressible bytes, as UTF-8-safe latin1 text. */
function noise(length: number): string {
  let state = 0x6d656d72
  let out = ''
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    out += String.fromCharCode(0x21 + ((state >>> 24) % 0x5e))
  }
  return out
}

// A function, not a constant: `b64` touches libsodium, which is not ready at
// module-evaluation time.
const SPECS = (): Spec[] => [
  {
    name: 'note create, body over 64 bytes and compressible',
    id: FIXED.NOTE_ID,
    type: 'note',
    operation: 'create',
    content: '# Title\n\n'.concat('The quick brown fox. '.repeat(12)),
    clock: { [FIXED.DEVICE_A]: 1 },
    pins: 'the 0x01 compression branch and the happy path'
  },
  {
    name: 'note create, body under 64 bytes',
    id: FIXED.NOTE_ID,
    type: 'note',
    operation: 'create',
    content: '# Short',
    clock: { [FIXED.DEVICE_A]: 1 },
    pins: 'the always-stored rule: under 64 bytes never compresses'
  },
  {
    name: 'note update, over 64 bytes but incompressible',
    id: FIXED.NOTE_ID,
    type: 'note',
    operation: 'update',
    content: noise(512),
    clock: { [FIXED.DEVICE_A]: 2 },
    pins: 'the >= fallback to 0x00 when deflate does not shrink the input'
  },
  {
    name: 'note delete with deletedAt',
    id: FIXED.NOTE_ID,
    type: 'note',
    operation: 'delete',
    content: '',
    clock: { [FIXED.DEVICE_A]: 3 },
    deletedAt: 1760000000000,
    pins: 'deletedAt inside the signed CBOR'
  },
  {
    name: 'task update with clock',
    id: 'V1StGXR8Z5jdHi6BmyT12',
    type: 'task',
    operation: 'update',
    content: JSON.stringify({ title: 'Ship the spec', clock: { [FIXED.DEVICE_A]: 4 } }),
    clock: { [FIXED.DEVICE_A]: 4 },
    pins: 'metadata.clock on a field-merged type'
  },
  {
    name: 'note with clock and stateVector',
    id: FIXED.NOTE_ID,
    type: 'note',
    operation: 'update',
    content: 'body with both metadata keys present',
    clock: { [FIXED.DEVICE_A]: 5, [FIXED.DEVICE_B]: 1 },
    stateVector: b64(new Uint8Array([1, 2, 3, 4])),
    pins: 'both metadata keys, and that CBOR sorts clock before stateVector by length'
  },
  {
    name: 'settings update with no clock',
    id: 'synced_settings',
    type: 'settings',
    operation: 'update',
    content: JSON.stringify({ settings: { general: { theme: 'dark' } }, fieldClocks: {} }),
    pins: 'the one record type exempt from the clock requirement'
  },
  {
    name: 'journal update',
    id: FIXED.JOURNAL_ID,
    type: 'journal',
    operation: 'update',
    content: JSON.stringify({ date: '2026-04-16', tags: ['daily'] }),
    clock: { [FIXED.DEVICE_A]: 1 },
    pins: 'the journal type string: a record for metadata, a CRDT document for its body'
  },
  {
    name: 'note create with a second data nonce',
    id: 'zzz999aaa111',
    type: 'note',
    operation: 'create',
    content: 'a second item in the same batch, distinguished only by its nonce',
    clock: { [FIXED.DEVICE_B]: 1 },
    dataNonceHex: FIXED.NONCE_24_C,
    pins: 'two items in one push differ in dataNonce, not in key material'
  }
]

export async function buildRecordEnvelope(): Promise<Record<string, unknown>> {
  const signerA = signerFromSeed(FIXED.SEED_A)
  const signerC = signerFromSeed(FIXED.SEED_C)
  const vaultKey = fromHex(VAULT_KEY)

  const cases = []
  for (const spec of SPECS()) {
    const crypto = deterministicProvider({ dataNonceHex: spec.dataNonceHex })
    const content = utf8(spec.content)
    const { pushItem, sizeBytes } = await encryptRecordForPush(crypto, {
      id: spec.id,
      type: spec.type,
      operation: spec.operation,
      content,
      vaultKey,
      signingSecretKey: signerA.secretKey,
      signerDeviceId: FIXED.DEVICE_A,
      ...(spec.clock ? { clock: spec.clock } : {}),
      ...(spec.stateVector ? { stateVector: spec.stateVector } : {}),
      ...(spec.deletedAt !== undefined ? { deletedAt: spec.deletedAt } : {})
    })

    // Round-trip through the production reader, so the vector records a proven
    // pair rather than a writer's word for it.
    const roundTripped = await decryptRecordItem(
      crypto,
      { ...pushItem, cryptoVersion: 1 },
      vaultKey,
      signerA.publicKey
    )

    cases.push({
      name: spec.name,
      pins: spec.pins,
      input: {
        id: spec.id,
        type: spec.type,
        operation: spec.operation,
        contentUtf8: spec.content,
        vaultKeyHex: VAULT_KEY,
        signingSeedHex: FIXED.SEED_A,
        fileKeyHex: FIXED.FILE_KEY,
        dataNonceHex: spec.dataNonceHex ?? FIXED.NONCE_24_A,
        keyNonceHex: FIXED.NONCE_24_B,
        clock: spec.clock ?? null,
        stateVector: spec.stateVector ?? null,
        deletedAt: spec.deletedAt ?? null
      },
      expected: {
        // Intermediates are exposed deliberately: when a second implementation
        // fails the final signature, the useful question is which of the three
        // stages diverged, and a vector carrying only the envelope forces a
        // bisect by hand.
        compressedHex: hex(compressPayload(content)),
        pushItem,
        sizeBytes,
        roundTripUtf8: new TextDecoder().decode(roundTripped)
      }
    })
  }

  const base = cases[0].expected.pushItem as Record<string, unknown>
  const tamperCases = [
    {
      name: 'tamper: clock removed after signing',
      pushItem: Object.fromEntries(Object.entries(base).filter(([k]) => k !== 'clock')),
      signerPublicKeyHex: hex(signerA.publicKey),
      expectFailure: 'signature',
      pins: 'the signature covers metadata; stripping it must not verify'
    },
    {
      name: 'tamper: one ciphertext byte flipped',
      pushItem: { ...base, encryptedData: flipLastBase64Byte(base.encryptedData as string) },
      signerPublicKeyHex: hex(signerA.publicKey),
      expectFailure: 'signature',
      pins: 'the signature covers the base64 ciphertext string, so a flip fails there first'
    },
    {
      name: 'tamper: verified against the wrong signer',
      pushItem: base,
      signerPublicKeyHex: hex(signerC.publicKey),
      expectFailure: 'signature',
      pins: 'SEED_A signed it; SEED_C must not verify it'
    }
  ]

  return {
    meta: meta({
      class: 'record-envelope',
      chapter: 'docs/protocol/04-record-envelope.md',
      writer: 'packages/sync-client/src/push/record-encrypt.ts',
      reader: 'packages/sync-client/src/pull/record-decrypt.ts',
      desktopParityAssertedIn: 'apps/desktop/src/main/sync/vector-parity.test.ts',
      cryptoVersion: 1,
      sizeCeiling: {
        SYNC_ITEM_MAX_ENCRYPT_BYTES,
        SYNC_ITEM_ENCRYPT_OVERHEAD,
        NOTE_SYNC_MAX_BYTES
      },
      caseCount: cases.length + tamperCases.length + 2,
      vaultNameCasesLiveIn: 'apps/desktop/src/main/sync/vector-parity.test.ts'
    }),
    cases,
    tamperCases,
    sizeCeilingCases: buildSizeCeilingCases()
  }
}

function flipLastBase64Byte(value: string): string {
  const bytes = Uint8Array.from(Buffer.from(value, 'base64'))
  bytes[bytes.length - 1] ^= 0x01
  return Buffer.from(bytes).toString('base64')
}

/** The `ItemTooLargeError` boundary, stated as the two payload sizes around it. */
function buildSizeCeilingCases(): unknown[] {
  return [
    {
      name: 'payload one byte under the ceiling',
      contentBytes: NOTE_SYNC_MAX_BYTES,
      expectThrows: false,
      pins: `estimated size is ${NOTE_SYNC_MAX_BYTES} * ${SYNC_ITEM_ENCRYPT_OVERHEAD}, still <= ${SYNC_ITEM_MAX_ENCRYPT_BYTES}`
    },
    {
      name: 'payload one byte over the ceiling',
      contentBytes: NOTE_SYNC_MAX_BYTES + 1,
      expectThrows: true,
      expectErrorName: 'ItemTooLargeError',
      pins: 'the check runs BEFORE any crypto and is non-retryable'
    }
  ]
}
