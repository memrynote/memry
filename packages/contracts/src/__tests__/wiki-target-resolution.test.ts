/** Verifier for `wiki-target-resolution.json` (chapter 12 §12.3). */
import { describe, expect, it } from 'vitest'

import {
  nameKey,
  normalizeAliases,
  pickWikiTarget,
  type WikiMatchKind,
  type WikiNameCandidate
} from '@memry/shared/note-names'
import { loadVectorFile } from './vector-loader'

interface Vectors {
  meta: { caseCount: number }
  nameKeys: Array<{ name: string; input: string; expected: string | null }>
  aliasLists: Array<{ name: string; title: string; aliases: string[]; expected: string[] }>
  notes: WikiNameCandidate[]
  resolution: Array<{
    name: string
    query: string
    expected: { noteId: string; matchedBy: WikiMatchKind } | null
  }>
}

const vectors = loadVectorFile<Vectors>('wiki-target-resolution.json')

describe('wiki-target-resolution vectors', () => {
  it('carries the recorded case count', () => {
    const { nameKeys, aliasLists, resolution } = vectors
    expect(nameKeys.length + aliasLists.length + resolution.length).toBe(vectors.meta.caseCount)
  })

  it.each(vectors.nameKeys.map((c) => [c.name, c] as const))('nameKey %s', (_name, c) => {
    expect(nameKey(c.input)).toBe(c.expected)
  })

  it.each(vectors.aliasLists.map((c) => [c.name, c] as const))('aliases %s', (_name, c) => {
    expect(normalizeAliases(c.title, c.aliases)).toEqual(c.expected)
  })

  it.each(vectors.resolution.map((c) => [c.name, c] as const))('resolve %s', (_name, c) => {
    const match = pickWikiTarget(c.query, vectors.notes)
    expect(match && { noteId: match.noteId, matchedBy: match.matchedBy }).toEqual(c.expected)
  })
})
