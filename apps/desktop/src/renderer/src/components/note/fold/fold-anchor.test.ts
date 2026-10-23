import { describe, expect, it } from 'vitest'
import { layers, paragraph } from './fold-fixtures'
import { findParagraphBlock, paragraphPosition } from './fold-anchor'

describe('findParagraphBlock', () => {
  const blocks = [
    'Where we are',
    'The team plan was the one we argued about most.',
    'Next: write the changelog entry.'
  ]

  it('matches a block by its text, ignoring whitespace differences', () => {
    expect(findParagraphBlock(blocks, 'The team plan  was the one we argued about most.')).toBe(1)
  })

  it('matches by shared prefix when the editor text carries extra markup text', () => {
    expect(
      findParagraphBlock(
        ['The team plan was the one we argued about most. [1]'],
        'The team plan was the one we argued about most.'
      )
    ).toBe(0)
  })

  it('finds nothing for text the note no longer has', () => {
    expect(findParagraphBlock(blocks, 'A paragraph that was deleted since.')).toBe(-1)
    expect(findParagraphBlock(blocks, '')).toBe(-1)
  })
})

describe('findParagraphBlock: text the editor renders differently', () => {
  it('ignores markdown and wiki-link markup, quotes and case', () => {
    const blocks = ['Intro', 'See [[Roadmap|the roadmap]] and **bold** text, it’s “fine”.']
    expect(findParagraphBlock(blocks, 'See the roadmap and bold text, it\'s "fine".')).toBe(1)
    expect(
      findParagraphBlock(['- A list item with `code` in it'], 'a list item with code in it')
    ).toBe(0)
  })

  it('matches by the end when the editor adds text in front', () => {
    expect(
      findParagraphBlock(
        ['Note: the team plan was the one we argued about most.'],
        'Heads up. The team plan was the one we argued about most.'
      )
    ).toBe(0)
  })

  it('matches a block that holds the whole paragraph among other text', () => {
    expect(
      findParagraphBlock(
        ['Intro', 'Lead-in words. The pricing page needs a rewrite before launch. Trailing words.'],
        'The pricing page needs a rewrite before launch.'
      )
    ).toBe(1)
  })

  it('never matches an empty block', () => {
    expect(findParagraphBlock(['', '  ', 'Real text lives here, honestly.'], '')).toBe(-1)
  })
})

describe('findParagraphBlock: position fallback', () => {
  const blocks = ['Title', '', 'Edited beyond recognition now.', 'Another paragraph of the note.']

  it('picks the block at the same place when the counts agree', () => {
    expect(
      findParagraphBlock(blocks, 'Original wording that is gone.', { index: 1, count: 3 })
    ).toBe(2)
  })

  it('scales the place when the block counts differ', () => {
    expect(
      findParagraphBlock(blocks, 'Original wording that is gone.', { index: 2, count: 6 })
    ).toBe(2)
  })

  it("prefers the duplicate nearest the paragraph's place", () => {
    const same = [
      'Repeated line of text in the note.',
      'Something between them here.',
      'Repeated line of text in the note.'
    ]
    expect(
      findParagraphBlock(same, 'Repeated line of text in the note.', { index: 2, count: 3 })
    ).toBe(2)
    expect(
      findParagraphBlock(same, 'Repeated line of text in the note.', { index: 0, count: 3 })
    ).toBe(0)
  })

  it('still finds nothing without a position', () => {
    expect(findParagraphBlock(blocks, 'Original wording that is gone.')).toBe(-1)
  })
})

describe('paragraphPosition', () => {
  it('counts headings and non-empty paragraphs in reading order', () => {
    const note = layers()
    // s1 heading, p1, p2, then s2 (no heading): p3.
    expect(paragraphPosition(note, 'p1')).toEqual({ index: 1, count: 4 })
    expect(paragraphPosition(note, 'p3')).toEqual({ index: 3, count: 4 })
    expect(paragraphPosition(note, 'nope')).toBeUndefined()
  })

  it('skips empty paragraphs', () => {
    const note = layers()
    note.sections[0].paragraphs.splice(1, 0, paragraph({ hash: 'blank', text: ' ' }))
    expect(paragraphPosition(note, 'p2')).toEqual({ index: 2, count: 4 })
  })
})
