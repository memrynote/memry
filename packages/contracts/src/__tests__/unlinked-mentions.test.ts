/** Verifier for `unlinked-mentions.json` (chapter 12 §12.7.3). */
import { describe, expect, it } from 'vitest'

import {
  findPlainMentions,
  findUnlinkedMentions,
  linkUnlinkedMention,
  type PlainMention
} from '@memry/shared/unlinked-mentions'
import { loadVectorFile } from './vector-loader'

interface Vectors {
  meta: { caseCount: number }
  cases: Array<{ name: string; text: string; names: string[]; expected: string[] }>
  markdown: Array<{
    name: string
    markdown: string
    names: string[]
    title: string
    ordinal: number
    expected: PlainMention[]
    linked: string | null
  }>
}

const vectors = loadVectorFile<Vectors>('unlinked-mentions.json')

describe('unlinked-mentions vectors', () => {
  it('carries the recorded case count', () => {
    expect(vectors.cases.length + vectors.markdown.length).toBe(vectors.meta.caseCount)
  })

  it.each(vectors.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(findPlainMentions(c.text, c.names).map((mention) => mention.text)).toEqual(c.expected)
  })

  it.each(vectors.markdown.map((c) => [c.name, c] as const))('markdown: %s', (_name, c) => {
    expect(findUnlinkedMentions(c.markdown, c.names)).toEqual(c.expected)
    expect(linkUnlinkedMention(c.markdown, c.names, c.ordinal, c.title)).toBe(c.linked)
  })
})
