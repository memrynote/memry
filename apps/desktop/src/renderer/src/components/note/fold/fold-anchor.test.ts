import { describe, expect, it } from 'vitest'
import { findParagraphBlock } from './fold-anchor'

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
