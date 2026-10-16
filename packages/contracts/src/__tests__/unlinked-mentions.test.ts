/** Verifier for `unlinked-mentions.json` (chapter 12 §12.7.3). */
import { describe, expect, it } from 'vitest'

import { findPlainMentions } from '@memry/shared/unlinked-mentions'
import { loadVectorFile } from './vector-loader'

interface Vectors {
  meta: { caseCount: number }
  cases: Array<{ name: string; text: string; names: string[]; expected: string[] }>
}

const vectors = loadVectorFile<Vectors>('unlinked-mentions.json')

describe('unlinked-mentions vectors', () => {
  it('carries the recorded case count', () => {
    expect(vectors.cases.length).toBe(vectors.meta.caseCount)
  })

  it.each(vectors.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(findPlainMentions(c.text, c.names).map((mention) => mention.text)).toEqual(c.expected)
  })
})
