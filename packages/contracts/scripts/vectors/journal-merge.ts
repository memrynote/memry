/**
 * Class: journal field merge (`journal-merge.json`), chapter 06 §6.12.
 *
 * A journal's `tags` merge as a set and its `properties` per key, each unit
 * under its own clock (#5508). `edits` records the unit clocks a local edit
 * pushes (`journalFieldClocksForEdit`); `merges` records a concurrent pair's
 * merge (`mergeJournalFields`). Every expected value is the real output of the
 * functions desktop runs. The Rust core runs the file in
 * `crates/memry-core/tests/journal_merge_vectors.rs`.
 *
 * Determinism: D1. Every function here is pure.
 */
import type { JournalFields } from '../../../sync-client/src/journal-merge.ts'
import {
  journalFieldClocksForEdit,
  mergeJournalFields
} from '../../../sync-client/src/journal-merge.ts'
import { meta } from './shared'

type Clock = Record<string, number>

const BASE: JournalFields = {
  tags: ['lm-jtag'],
  properties: { mood: 'good', energy: 7 },
  clock: { X: 1 }
}

/** What a writer that knows §6.12 pushes after editing `base` into `next`. */
function edit(
  base: JournalFields | null,
  next: { tags: string[]; properties: Record<string, unknown>; clock: Clock }
): JournalFields {
  return { ...next, ...journalFieldClocksForEdit(base, next) }
}

const A = edit(BASE, { ...withTags(['lm-jtag', 't-a']), clock: { X: 1, A: 1 } })
const B = edit(BASE, { ...withTags(['lm-jtag', 't-b']), clock: { X: 1, B: 1 } })
const IOS = edit(BASE, { ...withTags([]), clock: { X: 1, I: 1 } })
const CLI = edit(BASE, {
  tags: ['lm-jtag'],
  properties: { mood: 'good', energy: 7, p3c: 'c-val' },
  clock: { X: 1, C: 1 }
})

function withTags(tags: string[]): { tags: string[]; properties: Record<string, unknown> } {
  return { tags, properties: { mood: 'good', energy: 7 } }
}

/** The merged row a device pushes after a merge (§6.5.2 P3). */
function pushed(local: JournalFields, remote: JournalFields): JournalFields {
  const merged = mergeJournalFields(local, remote)
  const clock: Clock = { ...local.clock }
  for (const [device, tick] of Object.entries(remote.clock ?? {})) {
    clock[device] = Math.max(clock[device] ?? 0, tick)
  }
  return {
    tags: merged.tags,
    properties: merged.properties,
    clock,
    fieldClocks: merged.fieldClocks,
    fieldClocksAt: clock
  }
}

const A_AFTER_CLI = pushed(A, CLI)

/** The reviewer's repro (REVIEW-5529): a legacy day holding one tag and one property. */
const LEGACY_DAY_FIELDS = { tags: ['T'], properties: { p: 1 } }
const LEGACY_DAY: JournalFields = { ...LEGACY_DAY_FIELDS, clock: { X: 1 } }
const STAMPED_LEGACY_DAY = edit(null, { ...LEGACY_DAY_FIELDS, clock: { X: 1 } })
const B_AFTER_A = pushed(B, A_AFTER_CLI)

interface EditSpec {
  name: string
  pins: string
  base: JournalFields | null
  next: { tags: string[]; properties: Record<string, unknown>; clock: Clock }
}

const EDITS: EditSpec[] = [
  {
    name: 'legacy-base-add-tag',
    pins: '§6.12.2: an unclocked base seeds every unit at its clock; the added tag takes the new clock',
    base: BASE,
    next: { ...withTags(['lm-jtag', 't-a']), clock: { X: 1, A: 1 } }
  },
  {
    name: 'remove-tag-leaves-tombstone',
    pins: '§6.12.2: a removed tag keeps a clocked unit, the tombstone',
    base: BASE,
    next: { ...withTags([]), clock: { X: 1, I: 1 } }
  },
  {
    name: 'trusted-base-change-property',
    pins: '§6.12.2: unchanged units keep their clocks',
    base: A,
    next: {
      tags: ['lm-jtag', 't-a'],
      properties: { mood: 'tired', energy: 7 },
      clock: { X: 1, A: 2 }
    }
  },
  {
    name: 'recase-is-a-write',
    pins: '§6.12.2: a new spelling of the same tag key is a write to that unit',
    base: { tags: ['Work'], properties: {}, clock: { A: 1 } },
    next: { tags: ['work'], properties: {}, clock: { A: 2 } }
  },
  {
    name: 'no-base',
    pins: '§6.12.2: with no synced base every unit is seeded at the edit clock',
    base: null,
    next: { tags: ['a'], properties: { k: 1 }, clock: { A: 3 } }
  }
]

interface MergeSpec {
  name: string
  pins: string
  local: JournalFields
  remote: JournalFields
}

const MERGES: MergeSpec[] = [
  {
    name: 'issue-5508-a-pulls-cli',
    pins: '#5508: an added tag and a concurrently set property both survive',
    local: A,
    remote: CLI
  },
  {
    name: 'issue-5508-b-pulls-a-merged',
    pins: '#5508: a second concurrent add merges into the set',
    local: B,
    remote: A_AFTER_CLI
  },
  {
    name: 'issue-5508-ios-pulls-b-merged',
    pins: '#5508: the iOS removal of lm-jtag wins over the untouched unit; all four edits survive',
    local: IOS,
    remote: B_AFTER_A
  },
  {
    name: 'removal-beats-stale-readd',
    pins: '§6.12.3: a peer still holding the tag at an older unit clock does not resurrect it',
    local: IOS,
    remote: edit(BASE, {
      tags: ['lm-jtag'],
      properties: { mood: 'good', energy: 8 },
      clock: { X: 1, B: 2 }
    })
  },
  {
    name: 'concurrent-add-and-remove-tie-remote-wins',
    pins: '§6.3 rule 5 per unit: equal totals, remote wins',
    local: edit(
      { tags: ['x'], properties: {}, clock: { X: 1 } },
      { tags: [], properties: {}, clock: { X: 1, A: 1 } }
    ),
    remote: edit(
      { tags: ['x'], properties: {}, clock: { X: 1 } },
      { tags: ['X'], properties: {}, clock: { X: 1, B: 1 } }
    )
  },
  {
    name: 'offline-tie-local-wins',
    pins: '§6.3 rule 5: the asymmetric _offline key-presence test runs per unit',
    local: {
      tags: [],
      properties: { k: 'local' },
      clock: { A: 1, _offline: 1 },
      fieldClocks: { 'properties.k': { A: 1, _offline: 1 } },
      fieldClocksAt: { A: 1, _offline: 1 }
    },
    remote: {
      tags: [],
      properties: { k: 'remote' },
      clock: { B: 2 },
      fieldClocks: { 'properties.k': { B: 2 } },
      fieldClocksAt: { B: 2 }
    }
  },
  {
    name: 'case-variant-keeps-local-spelling',
    pins: '§1.9.1 step 6: one unit per tag key, the spelling already here is kept',
    local: edit(
      { tags: [], properties: {}, clock: { X: 1 } },
      { tags: ['Work'], properties: {}, clock: { X: 1, A: 1 } }
    ),
    remote: edit(
      { tags: [], properties: {}, clock: { X: 1 } },
      { tags: ['work', 'home'], properties: {}, clock: { X: 1, B: 2 } }
    )
  },
  {
    name: 'old-build-remote-is-whole-record',
    pins: '§6.12.1: an older build ticked clock past fieldClocksAt; every unit in the union is read at its clock, so t-a, absent from it, is removed: today’s rule',
    local: A,
    remote: {
      tags: ['lm-jtag', 'old'],
      properties: { mood: 'good' },
      clock: { X: 1, C: 1, O: 1 },
      fieldClocks: CLI.fieldClocks,
      fieldClocksAt: CLI.fieldClocksAt
    }
  },
  {
    name: 'legacy-remote-without-field-clocks',
    pins: '§6.12.1: a payload with no fieldClocks names its units at its clock',
    local: A,
    remote: { tags: ['lm-jtag'], properties: { mood: 'good', energy: 9 }, clock: { X: 1, O: 3 } }
  },
  {
    name: 'old-build-removes-tag-and-property',
    pins: '§6.12.1: an older build removed a tag and a property; a body-only local edit does not resurrect them',
    local: edit(LEGACY_DAY, { ...LEGACY_DAY_FIELDS, clock: { X: 1, N: 1 } }),
    remote: {
      tags: [],
      properties: {},
      clock: { X: 1, O: 1 },
      fieldClocks: STAMPED_LEGACY_DAY.fieldClocks,
      fieldClocksAt: STAMPED_LEGACY_DAY.fieldClocksAt
    }
  },
  {
    name: 'legacy-remote-removes-tag-and-property',
    pins: '§6.12.1: a payload with no fieldClocks that lacks a unit removes it at its clock',
    local: edit(LEGACY_DAY, { ...LEGACY_DAY_FIELDS, clock: { X: 1, N: 1 } }),
    remote: { tags: [], properties: {}, clock: { X: 1, O: 1 } }
  },
  {
    name: 'local-dominates-every-unit-requeues',
    pins: '§6.5.2 P3: a local unit ahead of the remote re-queues',
    local: edit(A, {
      tags: ['lm-jtag', 't-a'],
      properties: { mood: 'tired', energy: 7 },
      clock: { X: 1, A: 2 }
    }),
    remote: edit(BASE, {
      tags: ['lm-jtag'],
      properties: { mood: 'good', energy: 7, z: true },
      clock: { X: 1, Z: 1 }
    })
  },
  {
    name: 'null-property-is-a-value',
    pins: '§13.4 inside properties: null is a value, absence is a removal',
    local: edit(
      { tags: [], properties: { k: 1 }, clock: { X: 1 } },
      { tags: [], properties: {}, clock: { X: 1, A: 1 } }
    ),
    remote: edit(
      { tags: [], properties: { k: 1 }, clock: { X: 1 } },
      { tags: [], properties: { k: null }, clock: { X: 1, B: 1, C: 1 } }
    )
  }
]

export function buildJournalMerge(): Record<string, unknown> {
  const edits = EDITS.map((spec) => ({
    ...spec,
    expected: journalFieldClocksForEdit(structuredClone(spec.base), structuredClone(spec.next))
  }))
  const merges = MERGES.map((spec) => ({
    ...spec,
    expected: mergeJournalFields(structuredClone(spec.local), structuredClone(spec.remote))
  }))
  return {
    meta: meta({
      class: 'journal-merge',
      chapter: 'docs/protocol/06-vector-clocks-and-field-merge.md',
      implementation: 'packages/sync-client/src/journal-merge.ts',
      caseCount: edits.length + merges.length
    }),
    edits,
    merges
  }
}
