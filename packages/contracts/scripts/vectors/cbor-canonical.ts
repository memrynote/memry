/**
 * Class: canonical CBOR (`cbor-canonical.json`), 14 cases.
 *
 * Exists because the ordering rule is not what `CBOR_FIELD_ORDER` looks like,
 * and because a Rust CBOR crate's "canonical" setting usually means RFC 8949
 * §4.2.1 (plain bytewise) while this protocol uses §4.2.3 (length-first, then
 * bytewise). Case 3 is the only case where the two disagree, so it is the case
 * a wrongly-configured encoder fails on and nothing else.
 *
 * Determinism: D1. `encodeCbor` is pure.
 *
 * Generated through the production encoder, not a local one. There are two
 * byte-identical copies of it (`packages/sync-client/src/pull/cbor.ts` and
 * `apps/desktop/src/main/crypto/cbor.ts`); the generator calls the first and
 * the verifier asserts the second agrees on every case, which turns the
 * "kept byte-identical by comment" claim into a test.
 *
 * Chapter: docs/protocol/04-record-envelope.md §4.7.
 */
import { decode } from 'cborg'

import { CBOR_FIELD_ORDER } from '../../src/cbor-ordering'
import { encodeCbor } from '../../../sync-client/src/pull/cbor.ts'
import { meta } from './shared'

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')

/** A two-key ordering used only by case 3, where §4.2.1 and §4.2.3 disagree. */
const LENGTH_FIRST_PROBE = ['aa', 'z'] as const

type Ordering = readonly string[]

interface OkCase {
  name: string
  fieldOrderName: string
  fieldOrder: Ordering
  input: Record<string, unknown>
  pins: string
}

const SYNC_ITEM_FULL: Record<string, unknown> = {
  id: 'abc123def456',
  type: 'note',
  operation: 'create',
  cryptoVersion: 1,
  encryptedKey: 'ZW5jcnlwdGVkS2V5',
  keyNonce: 'a2V5Tm9uY2U=',
  encryptedData: 'ZW5jcnlwdGVkRGF0YQ==',
  dataNonce: 'ZGF0YU5vbmNl',
  deletedAt: 1760000000000,
  metadata: { clock: { 'device-a': 3 } }
}

const reversedKeys = (value: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).reverse())

const CASES: OkCase[] = [
  {
    name: 'sync-item, all ten keys',
    fieldOrderName: 'SYNC_ITEM',
    fieldOrder: CBOR_FIELD_ORDER.SYNC_ITEM,
    input: SYNC_ITEM_FULL,
    pins: 'the real payload; the encoded order is length-first, not the field-list order'
  },
  {
    name: 'sync-item, keys inserted in reverse',
    fieldOrderName: 'SYNC_ITEM',
    fieldOrder: CBOR_FIELD_ORDER.SYNC_ITEM,
    input: reversedKeys(SYNC_ITEM_FULL),
    pins: 'identical bytes; input insertion order is irrelevant'
  },
  {
    name: 'length-first versus lexicographic disagreement',
    fieldOrderName: 'LENGTH_FIRST_PROBE',
    fieldOrder: LENGTH_FIRST_PROBE,
    input: { aa: 1, z: 2 },
    pins: 'RFC 8949 §4.2.3: `z` (1 byte) sorts before `aa` (2 bytes). A §4.2.1 encoder fails here and nowhere else'
  },
  {
    name: 'nested metadata sorts recursively',
    fieldOrderName: 'SYNC_ITEM',
    fieldOrder: CBOR_FIELD_ORDER.SYNC_ITEM,
    input: { id: 'i', type: 'note', metadata: { stateVector: 'c3Y=', clock: { 'device-a': 1 } } },
    pins: '`clock` (5) before `stateVector` (11) inside a nested map'
  },
  {
    name: 'equal-length nested keys sort bytewise',
    fieldOrderName: 'SYNC_ITEM',
    fieldOrder: CBOR_FIELD_ORDER.SYNC_ITEM,
    input: { id: 'i', type: 'note', metadata: { clock: { d1: 1, aa: 2 } } },
    pins: '`aa` before `d1`: equal length falls through to bytewise'
  },
  {
    name: 'three-level nesting',
    fieldOrderName: 'SYNC_ITEM',
    fieldOrder: CBOR_FIELD_ORDER.SYNC_ITEM,
    input: { id: 'i', metadata: { stateVector: 'c3Y=', clock: { zzz: 1, a: 2, bb: 3 } } },
    pins: 'recursion does not stop at depth two'
  },
  {
    name: 'integer 1',
    fieldOrderName: 'SYNC_ITEM',
    fieldOrder: CBOR_FIELD_ORDER.SYNC_ITEM,
    input: { cryptoVersion: 1 },
    pins: 'shortest-form unsigned integer, `01`'
  },
  {
    name: 'integer 1000000',
    fieldOrderName: 'SYNC_ITEM',
    fieldOrder: CBOR_FIELD_ORDER.SYNC_ITEM,
    input: { deletedAt: 1000000 },
    pins: 'shortest form with a 4-byte argument, `1a 000f4240`'
  },
  {
    name: 'integer -1',
    fieldOrderName: 'SYNC_ITEM',
    fieldOrder: CBOR_FIELD_ORDER.SYNC_ITEM,
    input: { deletedAt: -1 },
    pins: 'shortest-form negative integer, `20`'
  },
  {
    name: 'float 1.5 narrows to float16',
    fieldOrderName: 'SYNC_ITEM',
    fieldOrder: CBOR_FIELD_ORDER.SYNC_ITEM,
    input: { deletedAt: 1.5 },
    pins: '`f9 3e00`. An encoder that always emits float64 signs different bytes'
  },
  {
    name: 'float 0.1 stays float64',
    fieldOrderName: 'SYNC_ITEM',
    fieldOrder: CBOR_FIELD_ORDER.SYNC_ITEM,
    input: { deletedAt: 0.1 },
    pins: '`fb 3fb999999999999a`: narrowing is lossy, so it does not happen'
  },
  {
    name: 'byte string value',
    fieldOrderName: 'SYNC_ITEM',
    fieldOrder: CBOR_FIELD_ORDER.SYNC_ITEM,
    input: { encryptedData: new Uint8Array([1, 2, 3]) },
    pins: 'major type 2, `43 010203` — not an array of integers'
  },
  {
    name: 'null is encoded, undefined is dropped',
    fieldOrderName: 'SYNC_ITEM',
    fieldOrder: CBOR_FIELD_ORDER.SYNC_ITEM,
    input: { id: null, type: undefined, operation: 'create' },
    pins: '`null` encodes as `f6`; an `undefined` value omits the key entirely'
  }
]

/** Case 14: a key outside the allowlist must throw, not be silently dropped. */
const REJECT_CASE = {
  name: 'a key outside the field order throws',
  fieldOrderName: 'SYNC_ITEM',
  input: { id: 'i', notInTheList: 1 },
  expectErrorContains: 'CBOR encoding rejected: fields not in ordering would be excluded',
  pins: 'rejection is a hard throw, never a silent exclusion'
}

export function buildCborCanonical(): Record<string, unknown> {
  const cases = CASES.map((entry) => {
    const bytes = encodeCbor(entry.input, entry.fieldOrder)
    const decoded = decode(bytes) as Map<string, unknown> | Record<string, unknown>
    const keyOrder = decoded instanceof Map ? [...decoded.keys()] : Object.keys(decoded as object)
    return {
      name: entry.name,
      fieldOrderName: entry.fieldOrderName,
      fieldOrder: [...entry.fieldOrder],
      input: serialisableInput(entry.input),
      expectedHex: hex(bytes),
      expectedDecodedKeyOrder: keyOrder,
      pins: entry.pins
    }
  })

  return {
    meta: meta({
      class: 'cbor-canonical',
      chapter: 'docs/protocol/04-record-envelope.md §4.7',
      ordering: 'RFC 8949 §4.2.3, Length-First Map Key Ordering',
      encoder: 'packages/sync-client/src/pull/cbor.ts (twin: apps/desktop/src/main/crypto/cbor.ts)',
      caseCount: cases.length + 1
    }),
    cases,
    rejectCases: [REJECT_CASE]
  }
}

/** `Uint8Array` is not JSON; record it as a tagged object the verifier rebuilds. */
function serialisableInput(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) {
      out[key] = { $undefined: true }
    } else if (value instanceof Uint8Array) {
      out[key] = { $bytesHex: hex(value) }
    } else {
      out[key] = value
    }
  }
  return out
}
