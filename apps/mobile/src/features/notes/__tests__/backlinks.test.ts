import { describe, expect, it } from 'vitest'

import type { VaultDb } from '@/db/index'
import { extractMentions, readBacklinks } from '../backlinks'

describe('extractMentions', () => {
  it('finds every mention in one body', () => {
    const body = 'see [[Alpha]] and later [[Alpha]] again'
    const mentions = extractMentions(body, 'Alpha')
    expect(mentions).toHaveLength(2)
  })

  it('matches the alias and heading forms', () => {
    const body = '[[Alpha|the first]] then [[Alpha#Setup]] then [[Alpha#Setup|jump]]'
    expect(
      extractMentions(body, 'Alpha').map((m) => m.snippet.slice(m.linkStart, m.linkEnd))
    ).toEqual(['[[Alpha|the first]]', '[[Alpha#Setup]]', '[[Alpha#Setup|jump]]'])
  })

  it('matches the title case-insensitively', () => {
    expect(extractMentions('see [[alpha]]', 'Alpha')).toHaveLength(1)
  })

  it('does not match a title that merely starts the same', () => {
    expect(extractMentions('see [[Alpha Other]] and [[Alphabet]]', 'Alpha')).toHaveLength(0)
  })

  it('reports a 1-based line number', () => {
    const body = 'one\ntwo\nthree [[Alpha]]'
    expect(extractMentions(body, 'Alpha')[0].line).toBe(3)
  })

  it('points linkStart/linkEnd at the match inside the snippet', () => {
    const body = `${'x'.repeat(200)} [[Alpha]] ${'y'.repeat(200)}`
    const [mention] = extractMentions(body, 'Alpha')
    expect(mention.snippet.slice(mention.linkStart, mention.linkEnd)).toBe('[[Alpha]]')
  })

  it('adds ellipses only on the side it truncated', () => {
    const long = 'z'.repeat(200)
    const [head] = extractMentions(`[[Alpha]] ${long}`, 'Alpha')
    expect(head.snippet.startsWith('[[Alpha]]')).toBe(true)
    expect(head.snippet.endsWith('...')).toBe(true)

    const [tail] = extractMentions(`${long} [[Alpha]]`, 'Alpha')
    expect(tail.snippet.startsWith('...')).toBe(true)
    expect(tail.snippet.endsWith('[[Alpha]]')).toBe(true)

    const [both] = extractMentions('short [[Alpha]] tail', 'Alpha')
    expect(both.snippet).toBe('short [[Alpha]] tail')
  })

  it('collapses newlines inside the snippet', () => {
    expect(extractMentions('one\n\ntwo [[Alpha]]', 'Alpha')[0].snippet).toBe('one two [[Alpha]]')
  })
})

interface SourceFixture {
  id: string
  title: string
  folderPath: string
  updated_at: number
  markdown: string
}

function fakeDb(target: string | null, sources: SourceFixture[], missing = 0): VaultDb {
  return {
    getFirstAsync: (sql: string) =>
      Promise.resolve(
        sql.includes('count(*)')
          ? { count: missing }
          : target === null
            ? null
            : { payload: JSON.stringify({ title: target }) }
      ),
    getAllAsync: () =>
      Promise.resolve(
        sources.map((source) => ({
          id: source.id,
          payload: JSON.stringify({ title: source.title, folderPath: source.folderPath }),
          updated_at: source.updated_at,
          markdown: source.markdown
        }))
      )
  } as unknown as VaultDb
}

describe('readBacklinks', () => {
  it('sorts by recency, then title, and totals the references', async () => {
    const db = fakeDb(
      'Alpha',
      [
        { id: 'b', title: 'Beta', folderPath: '', updated_at: 5, markdown: '[[Alpha]] [[Alpha]]' },
        { id: 'c', title: 'Cee', folderPath: 'work', updated_at: 9, markdown: '[[Alpha]]' },
        { id: 'a', title: 'Aye', folderPath: '', updated_at: 9, markdown: '[[Alpha|x]]' },
        { id: 'd', title: 'Dee', folderPath: '', updated_at: 1, markdown: 'no links here' }
      ],
      3
    )

    const result = await readBacklinks(db, 'target')

    expect(result.backlinks.map((b) => b.sourceId)).toEqual(['a', 'c', 'b'])
    expect(result.totalReferences).toBe(4)
    expect(result.missingBodies).toBe(3)
  })

  it('returns nothing when the target note has no title', async () => {
    const result = await readBacklinks(fakeDb(null, []), 'target')
    expect(result).toEqual({ backlinks: [], totalReferences: 0, missingBodies: 0 })
  })
})
