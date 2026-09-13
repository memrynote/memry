/**
 * Class: field merge (`field-merge.json`), 30 cases in three groups.
 *
 * The class FR-002 names. The generator's job is to ENUMERATE cases and record
 * the real output of `mergeFields`, never to predict it: a generator that
 * asserted what it thought the answer should be would encode the author's
 * belief rather than the implementation's behaviour.
 *
 * Determinism: D1. Every function here is pure.
 *
 * Chapter: docs/protocol/06-vector-clocks-and-field-merge.md.
 */
import {
  PROJECT_SYNCABLE_FIELDS,
  TASK_SYNCABLE_FIELDS,
  mergeFields
} from '../../../sync-client/src/field-merge.ts'
import { rebindOfflineClockData } from '../../../sync-client/src/offline-clock.ts'
import { compare, increment, merge } from '../../../sync-client/src/vector-clock.ts'
import type { FieldClocks, VectorClock } from '../../src/sync-api'
import { meta } from './shared'

const A = 'device-a'
const B = 'device-b'
const C = 'device-c'
const OFF = '_offline'

type ListName = 'TASK' | 'PROJECT'

const LIST: Record<ListName, readonly string[]> = {
  TASK: TASK_SYNCABLE_FIELDS,
  PROJECT: PROJECT_SYNCABLE_FIELDS
}

interface MergeSpec {
  name: string
  syncableFields: ListName
  localData: Record<string, unknown>
  remoteData: Record<string, unknown>
  localFieldClocks: FieldClocks
  remoteFieldClocks: FieldClocks
  pins: string
}

/** One-field task cases keep the table readable; the field list order is pinned separately. */
const t = (
  name: string,
  local: unknown,
  remote: unknown,
  lfc: VectorClock,
  rfc: VectorClock,
  pins: string
): MergeSpec => ({
  name,
  syncableFields: 'TASK',
  localData: { title: local },
  remoteData: { title: remote },
  localFieldClocks: { title: lfc },
  remoteFieldClocks: { title: rfc },
  pins
})

const MERGE_SPECS: MergeSpec[] = [
  t(
    'remote-total-greater',
    'local',
    'remote',
    { [A]: 2, [B]: 1 },
    { [C]: 5 },
    'rule 1: the larger tick sum wins outright'
  ),
  t('local-total-greater', 'local', 'remote', { [A]: 4 }, { [B]: 1 }, 'rule 2'),
  t(
    'totals-equal-values-equal',
    'same',
    'same',
    { [A]: 3, [B]: 1 },
    { [A]: 3, [B]: 1 },
    'rule 4 default, no conflict because the values match'
  ),
  t(
    'totals-equal-values-differ-no-offline',
    'local',
    'remote',
    { [A]: 1 },
    { [B]: 1 },
    'rule 4: REMOTE wins a plain tie'
  ),
  t(
    'totals-equal-local-has-offline',
    'local',
    'remote',
    { [A]: 1, [OFF]: 1 },
    { [B]: 2 },
    'rule 3: the side carrying _offline wins'
  ),
  t(
    'totals-equal-remote-has-offline',
    'local',
    'remote',
    { [B]: 2 },
    { [A]: 1, [OFF]: 1 },
    'THE ASYMMETRY: remote already wins by rule 4, so this looks identical to the plain tie. Named separately because it is the case an implementer assumes is symmetric'
  ),
  t(
    'totals-equal-both-have-offline',
    'local',
    'remote',
    { [A]: 1, [OFF]: 1 },
    { [B]: 1, [OFF]: 1 },
    'rule 3 requires _offline ABSENT on the remote side, so it does not fire'
  ),
  t(
    'totals-equal-local-offline-but-values-equal',
    'same',
    'same',
    { [A]: 1, [OFF]: 1 },
    { [B]: 2 },
    'rule 3 also requires the values to differ'
  ),
  t(
    'totals-equal-local-offline-zero-tick',
    'local',
    'remote',
    { [A]: 2, [OFF]: 0 },
    { [B]: 2 },
    'KEY PRESENCE, not tick value: {_offline: 0} still wins the tie'
  ),
  t(
    'clock-total-beats-causality',
    'local',
    'remote',
    { [A]: 5 },
    { [B]: 2, [C]: 2 },
    'local total 5 beats remote total 4 though the clocks are concurrent. This is the case that shows clockTotal is not a causal rule'
  ),
  t(
    'concurrent-equal-totals-values-differ',
    'local',
    'remote',
    { [A]: 1 },
    { [B]: 1 },
    'the ONLY shape that reports a conflict: equal totals, concurrent, values differ'
  ),
  t(
    'concurrent-unequal-totals-values-differ',
    'local',
    'remote',
    { [A]: 3 },
    { [B]: 1, [C]: 1 },
    'concurrent but SILENTLY resolved: hadConflicts stays false and an edit is lost with nothing surfaced'
  ),
  {
    name: 'missing-local-field-clock',
    syncableFields: 'TASK',
    localData: { title: 'local' },
    remoteData: { title: 'remote' },
    localFieldClocks: {},
    remoteFieldClocks: { title: { [A]: 1 } },
    pins: 'an absent field clock reads as {}, total 0'
  },
  {
    name: 'missing-both-field-clocks',
    syncableFields: 'TASK',
    localData: { title: 'local' },
    remoteData: { title: 'remote' },
    localFieldClocks: {},
    remoteFieldClocks: {},
    pins: 'both {}, so a tie, so remote'
  },
  {
    name: 'field-absent-from-syncable-list',
    syncableFields: 'TASK',
    localData: { title: 'local', notSyncable: 'kept locally' },
    remoteData: { title: 'remote', notSyncable: 'ignored' },
    localFieldClocks: { title: { [A]: 1 } },
    remoteFieldClocks: { title: { [A]: 2 } },
    pins: 'a field not in the list is not merged at all and does not appear in `merged`'
  },
  t(
    'null-versus-undefined',
    null,
    undefined,
    { [A]: 1 },
    { [B]: 1 },
    'null and undefined MUST count as differing'
  ),
  {
    name: 'object-values-same-content-different-key-order',
    syncableFields: 'TASK',
    localData: { repeatConfig: { a: 1, b: 2 } },
    remoteData: { repeatConfig: { b: 2, a: 1 } },
    localFieldClocks: { repeatConfig: { [A]: 1 } },
    remoteFieldClocks: { repeatConfig: { [B]: 1 } },
    pins: 'THE SINGLE LIKELIEST DIVERGENCE. Recorded as the implementation behaves today (JSON.stringify, key-order sensitive); the canonical comparison decision (#2185) makes these EQUAL, and this case is what measures that change'
  },
  t(
    'number-formatting',
    1,
    1.0,
    { [A]: 1 },
    { [B]: 1 },
    '1 and 1.0 stringify identically, so they do not differ'
  ),
  t(
    'float-accumulation',
    0.1 + 0.2,
    0.3,
    { [A]: 1 },
    { [B]: 1 },
    '0.1 + 0.2 !== 0.3, so these DO differ'
  ),
  {
    name: 'project-fields',
    syncableFields: 'PROJECT',
    localData: { name: 'Local project', color: '#ff0000' },
    remoteData: { name: 'Remote project', color: '#ff0000' },
    localFieldClocks: { name: { [A]: 2 }, color: { [A]: 1 } },
    remoteFieldClocks: { name: { [B]: 1 }, color: { [A]: 1 } },
    pins: 'the second field list, and a multi-field merge where the two fields take different branches'
  }
]

interface ClockSpec {
  name: string
  op: 'compare' | 'merge' | 'increment'
  a: VectorClock
  b?: VectorClock
  deviceId?: string
  pins: string
}

const CLOCK_SPECS: ClockSpec[] = [
  { name: 'equal', op: 'compare', a: { [A]: 1 }, b: { [A]: 1 }, pins: 'identical clocks' },
  { name: 'before', op: 'compare', a: { [A]: 1 }, b: { [A]: 2 }, pins: 'a happened-before b' },
  { name: 'after', op: 'compare', a: { [A]: 2 }, b: { [A]: 1 }, pins: 'a dominates b' },
  { name: 'concurrent', op: 'compare', a: { [A]: 1 }, b: { [B]: 1 }, pins: 'disjoint keys' },
  {
    name: 'concurrent-detected-early',
    op: 'compare',
    a: { [A]: 2, [B]: 1 },
    b: { [A]: 1, [B]: 2 },
    pins: 'both directions seen, so the loop short-circuits'
  },
  {
    name: 'merge-commutativity-ab',
    op: 'merge',
    a: { [A]: 2, [B]: 1 },
    b: { [B]: 3, [C]: 1 },
    pins: 'pointwise maximum'
  },
  {
    name: 'increment-from-absent',
    op: 'increment',
    a: {},
    deviceId: A,
    pins: 'a missing key reads as 0, so the first tick is 1'
  },
  {
    name: 'offline-compared-against-plain',
    op: 'compare',
    a: { [A]: 1, [OFF]: 1 },
    b: { [A]: 1 },
    pins: '_offline gets NO special treatment in the algebra: it is an ordinary key, so a is after b'
  }
]

interface RebindSpec {
  name: string
  clock: VectorClock | null
  fieldClocks: FieldClocks | null
  target: string
  pins: string
}

const REBIND_SPECS: RebindSpec[] = [
  {
    name: 'offline-only clock',
    clock: { [OFF]: 3 },
    fieldClocks: { title: { [OFF]: 3 } },
    target: A,
    pins: 'the key is deleted and its ticks move to the target device'
  },
  {
    name: 'offline plus the target already present',
    clock: { [OFF]: 2, [A]: 5 },
    fieldClocks: { title: { [OFF]: 2, [A]: 5 } },
    target: A,
    pins: 'the tick counts ADD, they do not max'
  },
  {
    name: 'no offline key',
    clock: { [A]: 1 },
    fieldClocks: { title: { [A]: 1 } },
    target: A,
    pins: 'unchanged'
  },
  {
    name: 'only some fields carry offline',
    clock: { [OFF]: 1, [A]: 1 },
    fieldClocks: { title: { [OFF]: 1 }, priority: { [A]: 2 } },
    target: A,
    pins: 'per-field, and a zero-tick key is left in place'
  }
]

export function buildFieldMerge(): Record<string, unknown> {
  const mergeCases = MERGE_SPECS.map((spec) => ({
    name: spec.name,
    pins: spec.pins,
    syncableFields: spec.syncableFields,
    localData: spec.localData,
    remoteData: spec.remoteData,
    localFieldClocks: spec.localFieldClocks,
    remoteFieldClocks: spec.remoteFieldClocks,
    expected: mergeFields(
      spec.localData,
      spec.remoteData,
      spec.localFieldClocks,
      spec.remoteFieldClocks,
      LIST[spec.syncableFields]
    )
  }))

  const clockAlgebra = CLOCK_SPECS.map((spec) => ({
    name: spec.name,
    pins: spec.pins,
    op: spec.op,
    a: spec.a,
    b: spec.b ?? null,
    deviceId: spec.deviceId ?? null,
    expected:
      spec.op === 'compare'
        ? compare(spec.a, spec.b!)
        : spec.op === 'merge'
          ? { forward: merge(spec.a, spec.b!), reversed: merge(spec.b!, spec.a) }
          : increment(spec.a, spec.deviceId!)
  }))

  const offlineRebind = REBIND_SPECS.map((spec) => ({
    name: spec.name,
    pins: spec.pins,
    clock: spec.clock,
    fieldClocks: spec.fieldClocks,
    targetDeviceId: spec.target,
    expected: rebindOfflineClockData(
      spec.clock,
      spec.fieldClocks,
      spec.target,
      TASK_SYNCABLE_FIELDS
    )
  }))

  return {
    meta: meta({
      class: 'field-merge',
      chapter: 'docs/protocol/06-vector-clocks-and-field-merge.md',
      implementation: 'packages/sync-client/src/field-merge.ts',
      offlineDeviceId: OFF,
      // Carried so a second implementation can assert it has the same lists in
      // the same ORDER: conflictedFields is consumed in field-list order.
      TASK_SYNCABLE_FIELDS: [...TASK_SYNCABLE_FIELDS],
      PROJECT_SYNCABLE_FIELDS: [...PROJECT_SYNCABLE_FIELDS],
      valueEqualityToday: 'JSON.stringify, key-order sensitive',
      valueEqualityDecided: 'recursive key sort; null distinct from absent (#2185)',
      caseCount: mergeCases.length + clockAlgebra.length + offlineRebind.length
    }),
    cases: mergeCases,
    clockAlgebra,
    offlineRebind
  }
}
