/** Verifier for `tag-fold.json` (chapter 13 §13.7.8). */
import { describe, expect, it } from 'vitest'

import { foldTag, tagKey } from '@memry/shared/tag-fold'
import { loadVectorFile } from './vector-loader'

interface Case {
  name: string
  input: { tag: string; equal: string[]; distinct: string[] }
  expected: { fold: string; key: string }
}

const vectors = loadVectorFile<{ meta: { caseCount: number }; cases: Case[] }>('tag-fold.json')

describe('tag-fold vectors', () => {
  it('carries the recorded case count', () => {
    expect(vectors.cases).toHaveLength(vectors.meta.caseCount)
  })

  it.each(vectors.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const { tag, equal, distinct } = c.input
    expect(foldTag(tag)).toBe(c.expected.fold)
    expect(tagKey(tag)).toBe(c.expected.key)
    expect(foldTag(c.expected.fold)).toBe(c.expected.fold)
    expect(foldTag(tag.toLowerCase())).toBe(c.expected.fold)
    for (const other of equal) expect(foldTag(other), other).toBe(c.expected.fold)
    for (const other of distinct) expect(foldTag(other), other).not.toBe(c.expected.fold)
  })
})
