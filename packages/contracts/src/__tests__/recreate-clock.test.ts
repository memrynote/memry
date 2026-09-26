/**
 * Verifier for `recreate-clock.json` (#2409).
 *
 * Chapter 06 §6.1: a write that (re)creates an id ticks from
 * `merge(local, tombstone)`. The committed JSON is the input; the production
 * `recreateBaseClock` and the mint on top of it are recomputed against it. The
 * Rust core runs the same file in `crates/memry-core/tests/recreate_clock_vectors.rs`.
 */
import { describe, expect, it } from 'vitest'

import { incrementClock, recreateBaseClock } from '../../../sync-core/src/record-sync.ts'
import type { VectorClock } from '../sync-api'
import { loadVectorFile } from './vector-loader'

const vectors = loadVectorFile<{
  meta: { caseCount: number }
  cases: Array<{
    name: string
    current: VectorClock | null
    tombstone: VectorClock | null
    operation: 'create' | 'update'
    device: string
    expected: { base: VectorClock; next: VectorClock }
  }>
}>('recreate-clock.json')

describe('recreate-clock vectors', () => {
  it('carries the recorded case count', () => {
    expect(vectors.cases.length).toBe(vectors.meta.caseCount)
  })

  it.each(vectors.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const current = structuredClone(c.current)
    const tombstone = structuredClone(c.tombstone)

    const base = recreateBaseClock(current, tombstone, c.operation)
    expect(base).toEqual(c.expected.base)
    expect(incrementClock(base, c.device)).toEqual(c.expected.next)
    // The rule reads its inputs and never writes them.
    expect(current).toEqual(c.current)
    expect(tombstone).toEqual(c.tombstone)
  })
})
