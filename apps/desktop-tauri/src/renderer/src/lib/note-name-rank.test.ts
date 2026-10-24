import { describe, expect, it } from 'vitest'
import { isExactMatch, linkTargetFor, rankNoteNames, sharedTitles } from './note-name-rank'

const ai = {
  id: 'n1',
  title: 'Artificial Intelligence',
  path: 'Artificial Intelligence.md',
  aliases: ['AI', 'Yapay Zeka']
}
const reading = { id: 'n2', title: 'Reading list', path: 'Reading list.md', aliases: [] }
const aiTitled = { id: 'n3', title: 'AI', path: 'Work/AI.md', aliases: [] }

function ranked(query: string, notes = [ai, reading]) {
  return rankNoteNames(query, notes).map(({ note, name }) => [note.id, name])
}

describe('rankNoteNames', () => {
  it('returns every note as a title match for an empty query', () => {
    expect(ranked('  ')).toEqual([
      ['n1', null],
      ['n2', null]
    ])
  })

  it('matches a note by an other name, once, with the name that matched', () => {
    expect(ranked('yapay')).toEqual([['n1', 'Yapay Zeka']])
  })

  it('puts an exact name first, case and spacing folded', () => {
    expect(ranked(' ai ')).toEqual([
      ['n1', 'AI'],
      ['n2', null]
    ])
  })

  it('ranks an exact title above an exact name', () => {
    expect(ranked('AI', [ai, aiTitled])).toEqual([
      ['n3', null],
      ['n1', 'AI']
    ])
  })

  it('prefers the title when the title and a name both match', () => {
    expect(ranked('artif')).toEqual([['n1', null]])
  })
})

describe('isExactMatch', () => {
  it('reads the matched name, else the title', () => {
    expect(isExactMatch('yapay zeka', { note: ai, name: 'Yapay Zeka' })).toBe(true)
    expect(isExactMatch('yapay', { note: ai, name: 'Yapay Zeka' })).toBe(false)
    expect(isExactMatch('READING LIST', { note: reading, name: null })).toBe(true)
  })
})

describe('linkTargetFor', () => {
  it('writes the title, or the path stem when another note shares the title', () => {
    const shared = sharedTitles([aiTitled, { ...aiTitled, id: 'n4', path: 'ai.md' }, reading])
    expect(linkTargetFor(aiTitled, shared)).toBe('Work/AI')
    expect(linkTargetFor({ ...aiTitled, path: 'ai.md' }, shared)).toBe('/ai')
    expect(linkTargetFor(reading, shared)).toBe('Reading list')
  })
})
