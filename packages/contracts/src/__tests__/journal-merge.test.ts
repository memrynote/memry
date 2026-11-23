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
  mergeJournalFields,
  type JournalFields
} from '../../../sync-client/src/journal-merge.ts'
import type { VectorClock } from '../sync-api'
import { loadVectorFile } from './vector-loader'

type Next = JournalFields & { clock: VectorClock }

const vectors = loadVectorFile<{
  meta: { caseCount: number }
  edits: Array<{ name: string; base: JournalFields | null; next: Next; expected: unknown }>
  merges: Array<{ name: string; local: JournalFields; remote: JournalFields; expected: unknown }>
}>('journal-merge.json')

describe('journal-merge vectors', () => {
  it('carries the recorded case count', () => {
    expect(vectors.edits.length + vectors.merges.length).toBe(vectors.meta.caseCount)
  })

  it.each(vectors.edits.map((c) => [c.name, c] as const))('edit %s', (_name, c) => {
    expect(journalFieldClocksForEdit(structuredClone(c.base), structuredClone(c.next))).toEqual(
      c.expected
    )
  })

  it.each(vectors.merges.map((c) => [c.name, c] as const))('merge %s', (_name, c) => {
    const local = structuredClone(c.local)
    const remote = structuredClone(c.remote)
    expect(mergeJournalFields(local, remote)).toEqual(c.expected)
    // The merge reads its inputs and never writes them.
    expect(local).toEqual(c.local)
    expect(remote).toEqual(c.remote)
  })
})
