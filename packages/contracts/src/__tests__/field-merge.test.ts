/**
 * Verifier for `field-merge.json` (T071).
 *
 * FR-002 requires two implementations to produce the same winner AND the same
 * conflict set, so both halves are asserted. An implementation that gets every
 * winner right and reports conflicts more eagerly fails here, correctly.
 *
 * `conflictedFields` is compared as an ORDERED array, because the order is the
 * order of the syncable-field list and the activity log consumes it in that
 * order.
 */
import { describe, expect, it } from 'vitest'

import {
  PROJECT_SYNCABLE_FIELDS,
  TASK_SYNCABLE_FIELDS,
  mergeFields
} from '../../../sync-client/src/field-merge.ts'
import { rebindOfflineClockData } from '../../../sync-client/src/offline-clock.ts'
import { compare, increment, merge } from '../../../sync-client/src/vector-clock.ts'
import { OFFLINE_CLOCK_DEVICE_ID } from '../sync-api'
import { loadVectorFile } from './vector-loader'

type Clocks = Record<string, Record<string, number>>

const vectors = loadVectorFile<{
  meta: {
    caseCount: number
    offlineDeviceId: string
    TASK_SYNCABLE_FIELDS: string[]
    PROJECT_SYNCABLE_FIELDS: string[]
  }
  cases: Array<{
    name: string
    pins: string
    syncableFields: 'TASK' | 'PROJECT'
    localData: Record<string, unknown>
    remoteData: Record<string, unknown>
    localFieldClocks: Clocks
    remoteFieldClocks: Clocks
    expected: {
      merged: Record<string, unknown>
      mergedFieldClocks: Clocks
      hadConflicts: boolean
      conflictedFields: string[]
      conflicts: unknown[]
    }
  }>
  clockAlgebra: Array<{
    name: string
    pins: string
    op: 'compare' | 'merge' | 'increment'
    a: Record<string, number>
    b: Record<string, number> | null
    deviceId: string | null
    expected: unknown
  }>
  offlineRebind: Array<{
    name: string
    pins: string
    clock: Record<string, number> | null
    fieldClocks: Clocks | null
    targetDeviceId: string
    expected: { clock: Record<string, number>; fieldClocks: Clocks }
  }>
}>('field-merge.json')

const LIST = { TASK: TASK_SYNCABLE_FIELDS, PROJECT: PROJECT_SYNCABLE_FIELDS } as const

describe('field-merge vectors', () => {
  it('carries the recorded case count', () => {
    expect(vectors.cases.length + vectors.clockAlgebra.length + vectors.offlineRebind.length).toBe(
      vectors.meta.caseCount
    )
  })

  it('the recorded field lists match production, in order', () => {
    expect(vectors.meta.TASK_SYNCABLE_FIELDS).toEqual([...TASK_SYNCABLE_FIELDS])
    expect(vectors.meta.PROJECT_SYNCABLE_FIELDS).toEqual([...PROJECT_SYNCABLE_FIELDS])
    expect(vectors.meta.offlineDeviceId).toBe(OFFLINE_CLOCK_DEVICE_ID)
  })

  for (const entry of vectors.cases) {
    it(entry.name, () => {
      const result = mergeFields(
        entry.localData,
        entry.remoteData,
        entry.localFieldClocks,
        entry.remoteFieldClocks,
        LIST[entry.syncableFields]
      )

      // Winner AND conflict set, both halves of FR-002.
      expect(result.merged, entry.pins).toEqual(entry.expected.merged)
      expect(result.mergedFieldClocks).toEqual(entry.expected.mergedFieldClocks)
      expect(result.hadConflicts).toBe(entry.expected.hadConflicts)
      expect(result.conflictedFields).toEqual(entry.expected.conflictedFields)
      expect(result.conflicts).toEqual(entry.expected.conflicts)
    })
  }

  it('the asymmetric tie-break is REALLY asymmetric', () => {
    // If a change ever made rule 3 symmetric these two cases would agree, and
    // the pair would stop testing anything.
    const localHas = vectors.cases.find((c) => c.name === 'totals-equal-local-has-offline')!
    const remoteHas = vectors.cases.find((c) => c.name === 'totals-equal-remote-has-offline')!
    expect(localHas.expected.merged.title).toBe(localHas.localData.title)
    expect(remoteHas.expected.merged.title).toBe(remoteHas.remoteData.title)
  })

  it('a concurrent pair with unequal totals is resolved WITHOUT being reported', () => {
    const silent = vectors.cases.find((c) => c.name === 'concurrent-unequal-totals-values-differ')!
    expect(silent.expected.hadConflicts, 'the lost-edit case, frozen deliberately').toBe(false)
    expect(silent.expected.conflictedFields).toEqual([])
  })

  it('the tick sum overrides causality', () => {
    const entry = vectors.cases.find((c) => c.name === 'clock-total-beats-causality')!
    expect(compare(entry.localFieldClocks.title, entry.remoteFieldClocks.title)).toBe('concurrent')
    expect(entry.expected.merged.title, 'the larger sum wins a concurrent pair').toBe(
      entry.localData.title
    )
  })

  for (const entry of vectors.clockAlgebra) {
    it(`clockAlgebra: ${entry.name}`, () => {
      if (entry.op === 'compare') {
        expect(compare(entry.a, entry.b!), entry.pins).toBe(entry.expected)
      } else if (entry.op === 'merge') {
        const expected = entry.expected as {
          forward: Record<string, number>
          reversed: Record<string, number>
        }
        expect(merge(entry.a, entry.b!)).toEqual(expected.forward)
        expect(merge(entry.b!, entry.a), 'merge MUST be commutative').toEqual(expected.reversed)
        expect(expected.forward).toEqual(expected.reversed)
      } else {
        expect(increment(entry.a, entry.deviceId!), entry.pins).toEqual(entry.expected)
      }
    })
  }

  for (const entry of vectors.offlineRebind) {
    it(`offlineRebind: ${entry.name}`, () => {
      const result = rebindOfflineClockData(
        entry.clock,
        entry.fieldClocks,
        entry.targetDeviceId,
        TASK_SYNCABLE_FIELDS
      )
      expect(result, entry.pins).toEqual(entry.expected)
    })
  }

  it('rebinding ADDS ticks rather than taking a maximum', () => {
    const entry = vectors.offlineRebind.find(
      (c) => c.name === 'offline plus the target already present'
    )!
    const offline = entry.clock![OFFLINE_CLOCK_DEVICE_ID]
    const existing = entry.clock![entry.targetDeviceId]
    expect(entry.expected.clock[entry.targetDeviceId]).toBe(offline + existing)
    expect(OFFLINE_CLOCK_DEVICE_ID in entry.expected.clock).toBe(false)
  })
})
