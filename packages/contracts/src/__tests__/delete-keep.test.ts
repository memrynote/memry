/**
 * Verifier for `delete-keep.json` (#3029).
 *
 * Chapter 05 §5.8, client behavior: a pulled note or journal delete first keeps
 * local text the deleter cannot have seen. The committed JSON is the input; the
 * production `keepsUnseenText` is recomputed against it. The Rust core runs the
 * same file in `crates/memry-core/tests/delete_keep_vectors.rs`.
 */
import { describe, expect, it } from 'vitest'

import {
  DELETE_KEEP_SKEW_MS,
  deletedAtMs,
  keepsUnseenText,
  type UnseenTextFacts
} from '../../../sync-client/src/delete-keep.ts'
import { loadVectorFile } from './vector-loader'

const vectors = loadVectorFile<{
  meta: { caseCount: number }
  skewMs: number
  cases: Array<{
    name: string
    facts: UnseenTextFacts
    expected: { keep: boolean; deletedAtMs: number | null }
  }>
}>('delete-keep.json')

describe('delete-keep vectors', () => {
  it('carries the recorded case count and slack', () => {
    expect(vectors.cases.length).toBe(vectors.meta.caseCount)
    expect(vectors.skewMs).toBe(DELETE_KEEP_SKEW_MS)
  })

  it.each(vectors.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(keepsUnseenText(c.facts)).toBe(c.expected.keep)
    expect(c.facts.deletedAt === null ? null : deletedAtMs(c.facts.deletedAt)).toBe(
      c.expected.deletedAtMs
    )
  })
})
