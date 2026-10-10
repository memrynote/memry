/** Verifier for `tag-schema-refs.json` (chapter 13 §13.7.7.2). */
import { describe, expect, it } from 'vitest'

import { rewriteSchemaReference } from '../tag-schema'
import { loadVectorFile } from './vector-loader'

interface Case {
  name: string
  input: { schema: Record<string, unknown>; from: string; to: string | null }
  expected: { schema: Record<string, unknown> | null }
}

const vectors = loadVectorFile<{ meta: { caseCount: number }; cases: Case[] }>(
  'tag-schema-refs.json'
)

describe('tag-schema-refs vectors', () => {
  it('carries the recorded case count', () => {
    expect(vectors.cases).toHaveLength(vectors.meta.caseCount)
  })

  it.each(vectors.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const before = structuredClone(c.input.schema)
    expect(rewriteSchemaReference(c.input.schema, c.input.from, c.input.to)).toEqual(
      c.expected.schema
    )
    expect(c.input.schema).toEqual(before)
  })
})
