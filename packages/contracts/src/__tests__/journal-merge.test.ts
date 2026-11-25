/**
 * Verifier for `journal-merge.json` (#5508).
 *
 * Chapter 06 §6.12: journal `tags` merge as a set and `properties` per key,
 * each unit under its own clock. The committed JSON is the input; the
 * production functions desktop runs are recomputed against it. The Rust core
 * runs the same file in `crates/memry-core/tests/journal_merge_vectors.rs`.
 */
import { describe, expect, it } from 'vitest'

import {
  journalFieldClocksForEdit,
  journalFieldClocksForWholesale,
  mergeJournalFields,
  type JournalFields
} from '../../../sync-client/src/journal-merge.ts'
import type { VectorClock } from '../sync-api'
import { loadVectorFile } from './vector-loader'

type Next = JournalFields & { clock: VectorClock }

interface Vectors {
  meta: { caseCount: number }
  edits: Array<{ name: string; base: JournalFields | null; next: Next; expected: unknown }>
  wholesales?: Array<{ name: string; remote: JournalFields; expected: unknown }>
  merges: Array<{
    name: string
    device: string
    local: JournalFields
    remote: JournalFields
    expected: unknown
  }>
}

const vectors = loadVectorFile<Vectors>('journal-merge.json')
// The fleet simulator's calls (#5508): the histories a mixed fleet produces.
const sim = loadVectorFile<Vectors>('journal-merge-sim.json')

describe.each([
  ['journal-merge.json', vectors],
  ['journal-merge-sim.json', sim]
] as const)('%s', (_file, file) => {
  it('carries the recorded case count', () => {
    const wholesales = file.wholesales?.length ?? 0
    expect(file.edits.length + wholesales + file.merges.length).toBe(file.meta.caseCount)
  })

  it.each(file.edits.map((c) => [c.name, c] as const))('edit %s', (_name, c) => {
    expect(journalFieldClocksForEdit(structuredClone(c.base), structuredClone(c.next))).toEqual(
      c.expected
    )
  })

  it.each((file.wholesales ?? []).map((c) => [c.name, c] as const))('wholesale %s', (_name, c) => {
    expect(journalFieldClocksForWholesale(structuredClone(c.remote))).toEqual(c.expected)
  })

  it.each(file.merges.map((c) => [c.name, c] as const))('merge %s', (_name, c) => {
    const local = structuredClone(c.local)
    const remote = structuredClone(c.remote)
    expect(mergeJournalFields(local, remote, c.device)).toEqual(c.expected)
    // The merge reads its inputs and never writes them.
    expect(local).toEqual(c.local)
    expect(remote).toEqual(c.remote)
  })
})
