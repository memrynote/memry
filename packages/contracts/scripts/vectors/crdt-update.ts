/**
 * Class: packed CRDT update envelope (`crdt-update.json`), 8 cases.
 *
 * Generated through `packages/sync-client/src/push/crdt-encrypt.ts` and read
 * back through `decryptCrdtUpdatePacked`. Desktop's twin
 * (`apps/desktop/src/main/sync/crdt-encrypt.ts`) is asserted byte-identical
 * against this file in `apps/desktop/src/main/sync/vector-parity.test.ts`; see
 * the header of `record-envelope.ts` for why the parity assertion lives there.
 *
 * The `decomposition` block is what turns an offset bug into a one-line
 * diagnosis instead of "the signature failed".
 *
 * Chapter: docs/protocol/04-record-envelope.md §4.11, §4.12.
 */
import * as Y from 'yjs'

import { encryptCrdtUpdatePacked } from '../../../sync-client/src/push/crdt-encrypt.ts'
import { decryptCrdtUpdatePacked } from '../../../sync-client/src/pull/record-decrypt.ts'
import {
  FIXED,
  deterministicProvider,
  fromHex,
  hex,
  signerFromSeed
} from '../../test-vectors/deterministic-provider'
import { meta } from './shared'

const VAULT_KEY = '0f1e2d3c4b5a69788796a5b4c3d2e1f00112233445566778899aabbccddeeff0'

/**
 * A Y.Doc with a PINNED client id.
 *
 * `new Y.Doc()` draws a random `clientID`, and that id is encoded into every
 * update, so an unpinned document makes this class non-reproducible and
 * therefore exempt from the `vectors:check` gate — exactly the carve-out the
 * gate exists to prevent. The value is arbitrary; only its fixedness matters.
 */
const VECTOR_CLIENT_ID = 0x6d656d72

function fixedDoc(): Y.Doc {
  const doc = new Y.Doc()
  doc.clientID = VECTOR_CLIENT_ID
  return doc
}

const HEADER_LEN = 160
const SIG_OFFSET = 96

/** A real Yjs update over a small BlockNote-shaped document. */
function realYjsUpdate(): Uint8Array {
  const doc = fixedDoc()
  const fragment = doc.getXmlFragment('prosemirror')
  const paragraph = new Y.XmlElement('paragraph')
  paragraph.insert(0, [new Y.XmlText('The body a phone would see.')])
  fragment.insert(0, [paragraph])
  doc.getMap('meta').set('title', 'Vector note')
  doc.getArray('tags').push(['protocol'])
  return Y.encodeStateAsUpdate(doc)
}

/** Deterministic filler bytes of an exact length. */
function filler(length: number): Uint8Array {
  const out = new Uint8Array(length)
  for (let i = 0; i < length; i++) out[i] = (i * 7 + 13) & 0xff
  return out
}

interface Spec {
  name: string
  noteId: string
  update: Uint8Array
  pins: string
}

const SPECS = (): Spec[] => [
  {
    name: '512-byte update, compressible',
    noteId: FIXED.NOTE_ID,
    update: new Uint8Array(512),
    pins: 'the 0x01 branch; 512 zero bytes deflate well'
  },
  {
    name: '40-byte update',
    noteId: FIXED.NOTE_ID,
    update: filler(40),
    pins: 'the stored branch: under 64 bytes never compresses'
  },
  {
    name: 'a real Yjs update over a BlockNote-shaped document',
    noteId: FIXED.NOTE_ID,
    update: realYjsUpdate(),
    pins: 'the transport does not inspect the bytes, and a second implementation gets something real to apply'
  },
  {
    name: 'the same update for a journal id',
    noteId: FIXED.JOURNAL_ID,
    update: realYjsUpdate(),
    pins: 'a journal body uses the identical envelope; the wire carries no item type'
  }
]

export async function buildCrdtUpdate(): Promise<Record<string, unknown>> {
  const signerA = signerFromSeed(FIXED.SEED_A)
  const vaultKey = fromHex(VAULT_KEY)
  const crypto = deterministicProvider()

  const cases = []
  for (const spec of SPECS()) {
    const packed = encryptCrdtUpdatePacked(
      crypto,
      spec.update,
      vaultKey,
      spec.noteId,
      signerA.secretKey
    )
    const roundTripped = await decryptCrdtUpdatePacked(
      crypto,
      packed,
      vaultKey,
      spec.noteId,
      signerA.publicKey
    )
    cases.push({
      name: spec.name,
      pins: spec.pins,
      input: {
        noteId: spec.noteId,
        updateHex: hex(spec.update),
        vaultKeyHex: VAULT_KEY,
        signingSeedHex: FIXED.SEED_A,
        fileKeyHex: FIXED.FILE_KEY,
        dataNonceHex: FIXED.NONCE_24_A,
        keyNonceHex: FIXED.NONCE_24_B
      },
      expected: {
        packedHex: hex(packed),
        packedBytes: packed.length,
        decomposition: {
          dataNonceHex: hex(packed.subarray(0, 24)),
          keyNonceHex: hex(packed.subarray(24, 48)),
          wrappedKeyHex: hex(packed.subarray(48, 96)),
          signatureHex: hex(packed.subarray(96, 160)),
          ciphertextHex: hex(packed.subarray(160))
        },
        signedPayloadHex: hex(signedPayload(spec.noteId, packed)),
        roundTripHex: hex(roundTripped)
      }
    })
  }

  const first = cases[0].expected.packedHex as string
  const firstBytes = fromHex(first)

  const errorCases = [
    {
      name: 'exactly 161 bytes is the minimum accepted length',
      noteId: FIXED.NOTE_ID,
      packedBytes: HEADER_LEN + 1,
      expectRejected: false,
      pins: 'HEADER_LEN + 1; a packet this short is structurally valid and fails later, on the signature'
    },
    {
      name: 'exactly 160 bytes is rejected',
      noteId: FIXED.NOTE_ID,
      packedHex: hex(firstBytes.subarray(0, HEADER_LEN)),
      expectErrorContains: 'CRDT update too short',
      pins: 'the length guard, before any crypto'
    },
    {
      name: 'case 1 read under a different note id',
      noteId: 'ffffffffffff',
      packedHex: first,
      expectErrorContains: 'Signature verification failed',
      pins: 'the note id is AUTHENTICATED, not merely associated, so this is a signature error and not an AEAD error'
    },
    {
      name: 'case 1 with the last ciphertext byte flipped',
      noteId: FIXED.NOTE_ID,
      packedHex: hex(flipLast(firstBytes)),
      expectErrorContains: 'Signature verification failed',
      pins: 'the ciphertext is inside the signed message, so tampering fails at the signature'
    }
  ]

  return {
    meta: meta({
      class: 'crdt-update',
      chapter: 'docs/protocol/04-record-envelope.md §4.11',
      writer: 'packages/sync-client/src/push/crdt-encrypt.ts',
      reader: 'packages/sync-client/src/pull/record-decrypt.ts',
      desktopParityAssertedIn: 'apps/desktop/src/main/sync/vector-parity.test.ts',
      layout: {
        headerBytes: HEADER_LEN,
        dataNonceOffset: 0,
        keyNonceOffset: 24,
        wrappedKeyOffset: 48,
        signatureOffset: SIG_OFFSET,
        ciphertextOffset: HEADER_LEN,
        minimumAcceptedBytes: HEADER_LEN + 1
      },
      caseCount: cases.length + errorCases.length
    }),
    cases,
    errorCases
  }
}

function signedPayload(noteId: string, packed: Uint8Array): Uint8Array {
  const idBytes = new TextEncoder().encode(noteId)
  const before = packed.subarray(0, SIG_OFFSET)
  const after = packed.subarray(SIG_OFFSET + 64)
  const out = new Uint8Array(idBytes.length + before.length + after.length)
  out.set(idBytes, 0)
  out.set(before, idBytes.length)
  out.set(after, idBytes.length + before.length)
  return out
}

function flipLast(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes)
  copy[copy.length - 1] ^= 0x01
  return copy
}
