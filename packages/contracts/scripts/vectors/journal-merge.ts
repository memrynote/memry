/**
 * Class: journal field merge (`journal-merge.json`), chapter 06 §6.12.
 *
 * A journal's `tags` merge as a set and its `properties` per key, each unit
 * under its own clock (#5508). `edits` records the unit clocks a local edit
 * pushes (`journalFieldClocksForEdit`); `wholesales` records the unit clocks a
 * device keeps with a record applied whole (`journalFieldClocksForWholesale`);
 * `merges` records a concurrent pair's merge (`mergeJournalFields`). Every
 * expected value is the real output of the
 * functions desktop runs. The Rust core runs the file in
 * `crates/memry-core/tests/journal_merge_vectors.rs`.
 *
 * Determinism: D1. Every function here is pure.
 */
import type { JournalFields } from '../../../sync-client/src/journal-merge.ts'
import {
  journalFieldClocksForEdit,
  journalFieldClocksForWholesale,
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

/** The merged row a device stores, and pushes when it re-queues (§6.5.2 P3). */
function pushed(local: JournalFields, remote: JournalFields, device: string): JournalFields {
  const { requeue: _requeue, ...merged } = mergeJournalFields(local, remote, device)
  return merged
}

/** A device's fields after it applied `remote` whole (§6.12.1). */
function appliedWhole(remote: JournalFields): JournalFields {
  return { ...remote, ...journalFieldClocksForWholesale(remote) }
}

const A_AFTER_CLI = pushed(A, CLI, 'A')

/** The reviewer's repro (REVIEW-5529): a legacy day holding one tag and one property. */
const LEGACY_DAY_FIELDS = { tags: ['T'], properties: { p: 1 } }
const LEGACY_DAY: JournalFields = { ...LEGACY_DAY_FIELDS, clock: { X: 1 } }
const STAMPED_LEGACY_DAY = edit(LEGACY_DAY, { ...LEGACY_DAY_FIELDS, clock: { X: 1 } })
const B_AFTER_A = pushed(B, A_AFTER_CLI, 'B')

/**
 * #5572: an older build removed `gone` from the legacy day at {X:1,O:1}. A new
 * build applies that record whole and adds a tag; a device that never pulled
 * the record still holds `gone` and concurrently set `q`.
 */
const GONE_DAY: JournalFields = { tags: ['gone'], properties: { p: 1 }, clock: { X: 1 } }
const OLD_BUILD_REMOVES_GONE: JournalFields = {
  tags: [],
  properties: { p: 1 },
  clock: { X: 1, O: 1 }
}
const STALE = edit(appliedWhole(GONE_DAY), {
  tags: ['gone'],
  properties: { p: 1, q: 1 },
  clock: { X: 1, C: 1 }
})
const RELAY = edit(appliedWhole(OLD_BUILD_REMOVES_GONE), {
  tags: ['added'],
  properties: { p: 1 },
  clock: { X: 1, O: 1, D: 1 }
})

/** An older build's record whose clock carries two body-only saves (VERIFY-5529). */
const TWO_SAVES_DAY: JournalFields = { ...LEGACY_DAY_FIELDS, clock: { X: 1, N: 2 } }

/**
 * `fieldFloors` (#5508 (a)): D applied an older build's record at {X:1,D:1}
 * whole, then set k. E, an older build, removed d at {X:1,E:1}. The floors are
 * concurrent, so neither claims d: E's removal stands, and its unit floor is
 * E's alone, not the record floor that also covers D's copy of d.
 */
const FLOOR_LOCAL = edit(appliedWhole({ tags: ['d'], properties: {}, clock: { X: 1, D: 1 } }), {
  tags: ['d'],
  properties: { k: 1 },
  clock: { X: 1, D: 2 }
})
const FLOOR_REMOTE: JournalFields = { tags: [], properties: {}, clock: { X: 1, E: 1 } }
const FLOORED = pushed(FLOOR_LOCAL, FLOOR_REMOTE, 'D')
/** An older build keeps `fieldFloors` it does not know verbatim and ticks `clock`. */
const FLOORED_OLD_ECHO: JournalFields = {
  ...FLOORED,
  tags: ['old'],
  clock: { ...FLOORED.clock, O: 1 }
}
/** An older build that dropped `fieldFloors` and ticked `clock`. */
const { fieldFloors: _dropped, ...FLOORED_STRIPPED } = {
  ...FLOORED,
  clock: { ...FLOORED.clock, O: 1 }
}
/** A new build's edit on top of the floored record. */
const AFTER_FLOORED = edit(FLOORED, {
  tags: ['e'],
  properties: { k: 1 },
  clock: { ...FLOORED.clock, D: (FLOORED.clock?.D ?? 0) + 1 }
})

interface EditSpec {
  name: string
  pins: string
  base: JournalFields | null
  next: { tags: string[]; properties: Record<string, unknown>; clock: Clock }
}

const EDITS: EditSpec[] = [
  {
    name: 'legacy-base-add-tag',
    pins: '§6.12.2: an unclocked base clocks no unit and its clock is the floor; the added tag takes the new clock',
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
    name: 'trusted-base-carries-its-floor',
    pins: '§6.12.2: an edit from a base applied whole keeps the base floor (#5572)',
    base: appliedWhole(OLD_BUILD_REMOVES_GONE),
    next: { tags: ['added'], properties: { p: 1 }, clock: { X: 1, O: 1, D: 1 } }
  },
  {
    name: 'no-base',
    pins: '§6.12.2: with no synced base an edit carries no unit clocks and is read whole at its clock (VERIFY-5529)',
    base: null,
    next: { tags: ['a'], properties: { k: 1 }, clock: { A: 3 } }
  },
  {
    name: 'edit-keeps-unit-floors-it-did-not-clock',
    pins: '§6.12.2: an edit keeps the base fieldFloors of every unit it did not change',
    base: FLOORED,
    next: { tags: [], properties: { k: 2 }, clock: { ...FLOORED.clock, D: 9 } }
  },
  {
    name: 'edit-drops-the-unit-floor-it-clocks',
    pins: '§6.12.2: a unit the edit clocks carries its write clock, not its unit floor',
    base: FLOORED,
    next: { tags: ['d'], properties: { k: 1 }, clock: { ...FLOORED.clock, D: 9 } }
  }
]

interface WholesaleSpec {
  name: string
  pins: string
  remote: JournalFields
}

const WHOLESALES: WholesaleSpec[] = [
  {
    name: 'untrusted-remote-is-its-floor',
    pins: '§6.12.1: an older build’s record clocks no unit, and its clock is the floor that carries its removals (#5572)',
    remote: OLD_BUILD_REMOVES_GONE
  },
  {
    name: 'stale-stamp-is-dropped',
    pins: '§6.12.1: unit clocks an older build kept past their stamp are not writes',
    remote: {
      tags: ['lm-jtag', 'old'],
      properties: { mood: 'good' },
      clock: { X: 1, C: 1, O: 1 },
      fieldClocks: CLI.fieldClocks,
      fieldClocksAt: CLI.fieldClocksAt
    }
  },
  {
    name: 'trusted-remote-keeps-its-own',
    pins: '§6.12.1: a trusted remote is kept as it arrived',
    remote: A
  },
  {
    name: 'trusted-remote-keeps-its-field-floors',
    pins: '§6.12.1: a trusted remote with fieldFloors is kept as it arrived',
    remote: FLOORED
  },
  {
    name: 'older-build-echo-of-field-floors-is-whole',
    pins: '§6.12.1: an older build kept fieldFloors verbatim but ticked clock, so the record is untrusted and its clock is the floor',
    remote: FLOORED_OLD_ECHO
  }
]

interface MergeSpec {
  name: string
  pins: string
  /** The merging device's clock id; `L` unless the case needs another. */
  device?: string
  local: JournalFields
  remote: JournalFields
}

const MERGES: MergeSpec[] = [
  {
    name: 'field-floors-concurrent-floors',
    pins: '§6.12.3: neither concurrent floor claims d, so the remote removal stands under its own unit floor, and k re-queues',
    device: 'D',
    local: FLOOR_LOCAL,
    remote: FLOOR_REMOTE
  },
  {
    name: 'new-peer-reads-field-floors',
    pins: '§6.12.1: a trusted remote reads its fieldFloors entry for a floored unit, fieldClocksFloor for the rest',
    device: 'E',
    local: edit(appliedWhole(FLOOR_REMOTE), {
      tags: ['d'],
      properties: {},
      clock: { X: 1, E: 2 }
    }),
    remote: FLOORED
  },
  {
    name: 'floored-record-pulls-new-edit',
    pins: '§6.12.3: a merge of a floored record and a newer edit drops no unit floor the edit did not clock',
    device: 'D',
    local: FLOORED,
    remote: AFTER_FLOORED
  },
  {
    name: 'older-build-echo-of-field-floors-is-whole',
    pins: '§6.12.1: an older build that kept fieldFloors and ticked clock is read whole at its clock, today’s rule',
    device: 'D',
    local: AFTER_FLOORED,
    remote: FLOORED_OLD_ECHO
  },
  {
    name: 'older-build-dropped-field-floors-is-whole',
    pins: '§6.12.1: an older build that dropped fieldFloors and ticked clock is read whole at its clock, today’s rule',
    device: 'D',
    local: AFTER_FLOORED,
    remote: FLOORED_STRIPPED
  },
  {
    name: 'pre-field-floors-peer-record',
    pins: '§6.12.1: a trusted record from a build before fieldFloors reads fieldClocksFloor for every unclocked unit',
    device: 'D',
    local: FLOORED,
    remote: {
      ...FLOOR_LOCAL,
      tags: ['d', 'x'],
      clock: { X: 1, D: 2, F: 1 },
      fieldClocks: { ...FLOOR_LOCAL.fieldClocks, 'tags.x': { X: 1, D: 2, F: 1 } },
      fieldClocksAt: { X: 1, D: 2, F: 1 }
    }
  },
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
    name: 'offline-tie-greater-value-wins',
    pins: '§6.12.3: a unit tie on ticks goes to the greater canonical value, so both sides agree; §6.3 rule 5’s _offline test does not apply per unit',
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
  // VERIFY-5529: a day last synced by an older build has no base, so the local
  // side is untrusted; body-only saves ticked its clock past the shared one.
  ...[1, 2, 3].map((saves) => ({
    name: `no-base-${saves}-saves-old-build-removes`,
    pins: `§6.12.1: an untrusted local side proves no unit clock; ${saves} body-only save(s) do not outrank an older build’s concurrent removal`,
    local: edit(null, { ...LEGACY_DAY_FIELDS, clock: { X: 1, N: saves } }),
    remote: { tags: [], properties: {}, clock: { X: 1, O: 1 } }
  })),
  {
    name: 'issue-5572-relay',
    pins: '#5572: the relay’s floor removes the tag the older build removed; q, a write concurrent with that record, survives',
    local: STALE,
    remote: RELAY
  },
  {
    name: 'issue-5572-relay-pulls-stale-copy',
    pins: '§6.12.3: the same pair the other way round: the local floor removes the stale copy and re-queues',
    local: RELAY,
    remote: STALE
  },
  {
    name: 'older-builds-applied-whole-then-concurrent-removal',
    pins: '§6.12.1: a record applied whole clocks no unit, so its body-only ticks do not outrank a concurrent older build’s removal',
    local: appliedWhole(TWO_SAVES_DAY),
    remote: { tags: [], properties: {}, clock: { X: 1, O: 1 } }
  },
  {
    name: 'untrusted-base-edit-then-concurrent-removal',
    pins: '§6.12.2: an edit from an untrusted base clocks only what it changed, so the base’s ticks do not outrank a concurrent removal',
    local: edit(TWO_SAVES_DAY, { ...LEGACY_DAY_FIELDS, clock: { X: 1, N: 3 } }),
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
  const wholesales = WHOLESALES.map((spec) => ({
    ...spec,
    expected: journalFieldClocksForWholesale(structuredClone(spec.remote))
  }))
  const merges = MERGES.map(({ device = 'L', ...spec }) => ({
    ...spec,
    device,
    expected: mergeJournalFields(structuredClone(spec.local), structuredClone(spec.remote), device)
  }))
  return {
    meta: meta({
      class: 'journal-merge',
      chapter: 'docs/protocol/06-vector-clocks-and-field-merge.md',
      implementation: 'packages/sync-client/src/journal-merge.ts',
      caseCount: edits.length + wholesales.length + merges.length
    }),
    edits,
    wholesales,
    merges
  }
}
