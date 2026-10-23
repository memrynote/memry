import { describe, expect, it } from 'vitest'
import { findOccurrences, occurrenceSnippet } from './search-text'

describe('findOccurrences', () => {
  it('lists every hit in document order, several per line', () => {
    const md = '# Kedi\n\nKedi ve kedi.\n\nBaşka bir satır.\n\nSon kedi.'
    const { hits } = findOccurrences(md, 'kedi')
    expect(hits.map((h) => [h.line, h.start])).toEqual([
      [0, 0],
      [1, 0],
      [1, 8],
      [3, 4]
    ])
  })

  it('counts a hit inside a code block, which the editor renders and the find bar matches', () => {
    const md = 'kedi\n\n```js\nconst kedi = 1\n```\n'
    expect(findOccurrences(md, 'kedi').hits).toHaveLength(2)
  })

  it('does not count markdown syntax or the code fence language', () => {
    const md = '**kedi** [[Kedi]] [x](http://kedi.example)\n\n```kedi\nx\n```'
    const { hits, lines } = findOccurrences(md, 'kedi')
    expect(lines[hits[0].line]).toBe('kedi Kedi x')
    expect(hits).toHaveLength(2)
  })

  it('returns no hits for a blank query', () => {
    expect(findOccurrences('kedi', '  ').hits).toEqual([])
  })
})

describe('occurrenceSnippet', () => {
  it('splits a long line around the hit and marks the cut ends', () => {
    const line = `${'a'.repeat(50)} kedi ${'b'.repeat(100)}`
    const snippet = occurrenceSnippet([line], { line: 0, start: 51 }, 'kedi')
    expect(snippet.match).toBe('kedi')
    expect(snippet.before.startsWith('…')).toBe(true)
    expect(snippet.after.endsWith('…')).toBe(true)
  })

  it('keeps a short line whole', () => {
    expect(occurrenceSnippet(['bir kedi var'], { line: 0, start: 4 }, 'kedi')).toEqual({
      before: 'bir ',
      match: 'kedi',
      after: ' var'
    })
  })
})
