/**
 * Case kinds and their inputs (a key missing from `input` is an absent side):
 *  - `canonical`: `value` → the §6.4.2 canonical string;
 *  - `order`: `a`, `b` → the sign of `compareVersioned(a, b)`;
 *  - `join-value` / `join-map`: `local`, `remote` → `value`, `remoteBehind`,
 *    `localChanged`. A verifier also joins with the seats swapped: the joined
 *    value is the same from either seat;
 *  - `join-map-associativity`: `a`, `b`, `c` → the value both groupings reach;
 *  - `stamp-map`: `stored`, `patch`, `clockTotal` → the stamped map;
 *  - `stamp-value`: `previous`, `edited` → the stamped object;
 *  - `plain`: `stored` → what a non-sync reader sees.
 */
import {
  canonicalJson,
  compareVersioned,
  joinVersionedMap,
  joinVersionedValue,
  plainVersionedMap,
  stampVersionedMapPatch,
  stampVersionedValue,
  type JsonValue,
  type VersionedObject
} from '../../../shared/src/versioned.ts'
import { meta } from './shared'

type Input = Record<string, unknown>

interface CaseSpec {
  name: string
  kind:
    | 'canonical'
    | 'order'
    | 'join-value'
    | 'join-map'
    | 'join-map-associativity'
    | 'stamp-map'
    | 'stamp-value'
    | 'plain'
  pins: string
  input: Input
}

const PERSON_V2 = {
  t: 2,
  fields: [
    { name: 'Company', relation: { target: 'company', many: false, inverse: 'People' } },
    { name: 'Role' }
  ],
  template: { id: 'tpl_8f2c', autofill: true },
  extends: null,
  preset: 'person'
}
const PERSON_V3 = { ...PERSON_V2, t: 3, fields: [...PERSON_V2.fields, { name: 'Email' }] }
const ROLE_ONLY = { t: 3, fields: [{ name: 'Role' }], template: null, extends: null, preset: null }
const EMAIL_ONLY = {
  t: 3,
  fields: [{ name: 'Email' }],
  template: null,
  extends: null,
  preset: null
}

const WAITING_ON = { v: ['memry://note/n_7Qx2'], t: 2 }
const FOLLOW_UP = { v: '2026-05-14', t: 1 }

const SPECS: CaseSpec[] = [
  {
    name: 'canonical-sorts-keys-at-every-depth',
    kind: 'canonical',
    pins: 'object keys sort at every depth, arrays keep their order, null stays',
    input: { value: { b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } } }
  },
  {
    name: 'canonical-numbers-never-use-an-exponent',
    kind: 'canonical',
    pins: '§6.4.2 rule 2: shortest round-trip digits, no 1e+21 or 1e-7 form',
    input: { value: [1, 1.5, 1e21, 1e-7, 9007199254740991, 0.30000000000000004, -2.5e-8] }
  },
  {
    name: 'canonical-sorts-keys-by-utf16-code-units',
    kind: 'canonical',
    pins: 'a non-BMP key sorts below U+FFFF in UTF-16, the opposite of UTF-8 byte order',
    input: { value: { '\uffff': 1, '😀': 2, a: 3 } }
  },
  {
    name: 'canonical-escapes-strings-like-json',
    kind: 'canonical',
    pins: 'quotes, backslashes and control characters escape; other text stays as is',
    input: { value: 'é "q" \\ \n\t\u0001 😀' }
  },
  {
    name: 'order-higher-version-wins',
    kind: 'order',
    pins: 'the larger t wins whatever the bodies',
    input: { a: PERSON_V3, b: PERSON_V2 }
  },
  {
    name: 'order-equal-version-larger-canonical-wins',
    kind: 'order',
    pins: 'equal t is decided by the canonical string',
    input: { a: ROLE_ONLY, b: EMAIL_ONLY }
  },
  {
    name: 'order-broken-version-reads-as-zero',
    kind: 'order',
    pins: 'a negative or non-integer t reads as 0 and loses to t: 1',
    input: { a: { v: 'x', t: -4 }, b: { v: 'a', t: 1 } }
  },
  {
    name: 'order-key-order-is-not-a-difference',
    kind: 'order',
    pins: 'the same value with keys in another order compares equal',
    input: { a: { t: 2, v: { a: 1, b: 2 } }, b: { v: { b: 2, a: 1 }, t: 2 } }
  },
  {
    name: 'join-value-remote-newer',
    kind: 'join-value',
    pins: 'a newer remote schema is taken and written',
    input: { local: PERSON_V2, remote: PERSON_V3 }
  },
  {
    name: 'join-value-stale-capture-loses',
    kind: 'join-value',
    pins: 'a post-#2265 stale echo under a newer clock loses on t, and the remote is healed',
    input: { local: PERSON_V3, remote: PERSON_V2 }
  },
  {
    name: 'join-value-equal-version-different-bodies',
    kind: 'join-value',
    pins: 'equal t picks the larger canonical form from either seat',
    input: { local: ROLE_ONLY, remote: EMAIL_ONLY }
  },
  {
    name: 'join-value-remote-absent',
    kind: 'join-value',
    pins: 'a peer that stripped the key leaves the local value, which it then needs',
    input: { local: PERSON_V3 }
  },
  {
    name: 'join-value-remote-null',
    kind: 'join-value',
    pins: 'null carries no information: no write and no heal',
    input: { local: PERSON_V3, remote: null }
  },
  {
    name: 'join-value-remote-not-an-object',
    kind: 'join-value',
    pins: 'a non-object remote reads as absent',
    input: { local: PERSON_V3, remote: 'person' }
  },
  {
    name: 'join-value-local-absent',
    kind: 'join-value',
    pins: 'a device with no schema adopts the remote one',
    input: { remote: PERSON_V2 }
  },
  {
    name: 'join-value-both-absent',
    kind: 'join-value',
    pins: 'nothing on either side stays nothing',
    input: {}
  },
  {
    name: 'join-value-keeps-unknown-nested-keys',
    kind: 'join-value',
    pins: 'keys a newer build added, inside array elements included, survive the join',
    input: {
      local: PERSON_V3,
      remote: {
        ...PERSON_V3,
        t: 4,
        fields: [{ name: 'Role', format: 'title-case' }],
        layout: { columns: 2 }
      }
    }
  },
  {
    name: 'join-value-own-echo',
    kind: 'join-value',
    pins: 'pulling back the value this device pushed changes and heals nothing',
    input: { local: PERSON_V3, remote: structuredClone(PERSON_V3) }
  },
  {
    name: 'join-map-disjoint-keys',
    kind: 'join-map',
    pins: 'different keys from each side are both kept, and each side lacks one',
    input: { local: { 'Waiting on': WAITING_ON }, remote: { 'Follow up': FOLLOW_UP } }
  },
  {
    name: 'join-map-same-key-higher-version',
    kind: 'join-map',
    pins: 'the higher t of one key wins',
    input: {
      local: { 'Follow up': FOLLOW_UP },
      remote: { 'Follow up': { v: '2026-06-01', t: 4 } }
    }
  },
  {
    name: 'join-map-removal-beats-older-value',
    kind: 'join-map',
    pins: 'a removal at t 3 beats a value at t 2, so a stale echo cannot resurrect it',
    input: { local: { Thread: { v: null, t: 3 } }, remote: { Thread: { v: 'ts-1', t: 2 } } }
  },
  {
    name: 'join-map-newer-value-beats-removal',
    kind: 'join-map',
    pins: 'a value at t 4 beats a removal at t 3',
    input: { local: { Thread: { v: null, t: 3 } }, remote: { Thread: { v: 'ts-2', t: 4 } } }
  },
  {
    name: 'join-map-equal-version-different-values',
    kind: 'join-map',
    pins: 'equal t picks the larger canonical entry from either seat',
    input: { local: { Owner: { v: 'Ahmet', t: 5 } }, remote: { Owner: { v: 'Deniz', t: 5 } } }
  },
  {
    name: 'join-map-remote-missing-a-key',
    kind: 'join-map',
    pins: 'a remote missing a local key leaves it, and the remote needs it',
    input: {
      local: { 'Waiting on': WAITING_ON, 'Follow up': FOLLOW_UP },
      remote: { 'Waiting on': WAITING_ON }
    }
  },
  {
    name: 'join-map-entry-keeps-unknown-keys',
    kind: 'join-map',
    pins: 'an entry a newer build extended is carried whole',
    input: {
      local: { 'Follow up': FOLLOW_UP },
      remote: { 'Follow up': { v: '2026-05-20', t: 2, d: { source: 'agent' } } }
    }
  },
  {
    name: 'join-map-remote-null',
    kind: 'join-map',
    pins: 'null carries no information: no write and no heal',
    input: { local: { 'Waiting on': WAITING_ON }, remote: null }
  },
  {
    name: 'join-map-remote-absent',
    kind: 'join-map',
    pins: 'a peer that stripped the key leaves the local map, which it then needs',
    input: { local: { 'Waiting on': WAITING_ON } }
  },
  {
    name: 'join-map-local-absent',
    kind: 'join-map',
    pins: 'a task with no map adopts the remote one',
    input: { remote: { 'Waiting on': WAITING_ON } }
  },
  {
    name: 'join-map-drops-entries-that-are-not-objects',
    kind: 'join-map',
    pins: 'a non-object entry is never stored',
    input: { remote: { Broken: 5, 'Follow up': FOLLOW_UP } }
  },
  {
    name: 'join-map-own-echo',
    kind: 'join-map',
    pins: 'pulling back the map this device pushed changes and heals nothing',
    input: {
      local: { 'Waiting on': WAITING_ON, Thread: { v: null, t: 3 } },
      remote: { Thread: { v: null, t: 3 }, 'Waiting on': WAITING_ON }
    }
  },
  {
    name: 'join-map-associativity',
    kind: 'join-map-associativity',
    pins: '(a ⊔ b) ⊔ c and a ⊔ (b ⊔ c) store the same map',
    input: {
      a: { Owner: { v: 'Ahmet', t: 5 }, 'Follow up': FOLLOW_UP },
      b: { Owner: { v: 'Deniz', t: 5 }, Thread: { v: 'ts-1', t: 2 } },
      c: { Thread: { v: null, t: 3 }, 'Follow up': { v: '2026-05-20', t: 1 } }
    }
  },
  {
    name: 'stamp-map-first-value',
    kind: 'stamp-map',
    pins: 'a new task with a clean clock stamps t = 1',
    input: { patch: { 'Waiting on': ['memry://note/n_7Qx2'] }, clockTotal: 0 }
  },
  {
    name: 'stamp-map-floor-from-the-clock',
    kind: 'stamp-map',
    pins: 'the stamp is clockTotal + 1 when the clock has seen more than the map',
    input: { stored: { 'Follow up': FOLLOW_UP }, patch: { Owner: 'Ahmet' }, clockTotal: 5 }
  },
  {
    name: 'stamp-map-floor-from-the-map',
    kind: 'stamp-map',
    pins: 'the stamp is above the highest t in the map when that is larger',
    input: { stored: { Owner: { v: 'Ahmet', t: 7 } }, patch: { Owner: 'Deniz' }, clockTotal: 3 }
  },
  {
    name: 'stamp-map-change-keeps-unknown-entry-keys',
    kind: 'stamp-map',
    pins: 'editing a value keeps the keys a newer build put on its entry',
    input: {
      stored: { 'Follow up': { v: '2026-05-14', t: 2, d: { source: 'agent' } } },
      patch: { 'Follow up': '2026-05-21' },
      clockTotal: 2
    }
  },
  {
    name: 'stamp-map-removal-writes-a-removal-entry',
    kind: 'stamp-map',
    pins: 'null removes by stamping v: null, never by deleting the entry',
    input: { stored: { Thread: { v: 'ts-1', t: 2 } }, patch: { Thread: null }, clockTotal: 4 }
  },
  {
    name: 'stamp-map-no-op-edits-stamp-nothing',
    kind: 'stamp-map',
    pins: 'an unchanged value, a removed removal and a missing key cleared stay as they were',
    input: {
      stored: { Owner: { v: { a: 1, b: 2 }, t: 2 }, Thread: { v: null, t: 3 } },
      patch: { Owner: { b: 2, a: 1 }, Thread: null, Missing: null },
      clockTotal: 9
    }
  },
  {
    name: 'stamp-map-one-stamp-per-edit',
    kind: 'stamp-map',
    pins: 'every key one edit changes shares its stamp',
    input: {
      stored: { Owner: { v: 'Ahmet', t: 1 } },
      patch: { Owner: 'Deniz', 'Follow up': '2026-05-14', Thread: null },
      clockTotal: 1
    }
  },
  {
    name: 'stamp-value-bumps-from-previous',
    kind: 'stamp-value',
    pins: 't is previous + 1 with no clock floor, and the edited keys are kept',
    input: {
      previous: PERSON_V3,
      edited: { ...PERSON_V3, fields: [...PERSON_V3.fields, { name: 'Phone', format: 'e164' }] }
    }
  },
  {
    name: 'stamp-value-first-schema',
    kind: 'stamp-value',
    pins: 'the first schema of a tag is t = 1',
    input: { edited: { fields: [{ name: 'Role' }], template: null, extends: null, preset: null } }
  },
  {
    name: 'stamp-value-no-op-edit',
    kind: 'stamp-value',
    pins: 'an edit that changes nothing keeps the previous value and its t',
    input: { previous: PERSON_V3, edited: { ...PERSON_V3, t: 99 } }
  },
  {
    name: 'plain-drops-removals-and-broken-entries',
    kind: 'plain',
    pins: 'readers see values only; removals and non-object entries are left out',
    input: {
      stored: {
        'Waiting on': WAITING_ON,
        Thread: { v: null, t: 3 },
        Broken: 'not an entry',
        Unset: { t: 2 }
      }
    }
  },
  {
    name: 'plain-of-a-missing-map',
    kind: 'plain',
    pins: 'a task with no map reads as no fields',
    input: { stored: null }
  }
]

function expectedOf(spec: CaseSpec): Record<string, unknown> {
  const { input } = spec
  switch (spec.kind) {
    case 'canonical':
      return { canonical: canonicalJson(input.value) }
    case 'order':
      return { sign: Math.sign(compareVersioned(input.a, input.b)) }
    case 'join-value': {
      const joined = joinVersionedValue(input.local, input.remote)
      return {
        value: joined.value,
        remoteBehind: joined.remoteBehind,
        localChanged: joined.localChanged
      }
    }
    case 'join-map': {
      const joined = joinVersionedMap(input.local, input.remote)
      return {
        value: joined.value,
        remoteBehind: joined.remoteBehind,
        localChanged: joined.localChanged
      }
    }
    case 'join-map-associativity': {
      const ab = joinVersionedMap(input.a, input.b).value
      return { value: joinVersionedMap(ab, input.c).value }
    }
    case 'stamp-map':
      return {
        value: stampVersionedMapPatch(
          input.stored,
          input.patch as Record<string, JsonValue>,
          input.clockTotal as number
        )
      }
    case 'stamp-value':
      return {
        value: stampVersionedValue(input.previous, input.edited as VersionedObject)
      }
    case 'plain':
      return { plain: plainVersionedMap(input.stored) }
  }
}

export function buildVersionedValues(): Record<string, unknown> {
  const cases = SPECS.map((spec) => ({ ...spec, expected: expectedOf(spec) }))
  return {
    meta: meta({
      class: 'versioned-values',
      chapter: 'docs/protocol/06-vector-clocks-and-field-merge.md',
      source: 'packages/shared/src/versioned.ts',
      caseCount: cases.length
    }),
    cases
  }
}
