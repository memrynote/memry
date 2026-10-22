import { describe, expect, it } from 'vitest'
import { portalContentsMarkdown, portalLinkText } from './portal-copy'

const block = (text: string, depth: number) => ({
  blockId: text,
  anchor: null,
  text,
  depth,
  pos: 0
})

describe('portalContentsMarkdown', () => {
  it('writes the visible slice as an outline, nesting from the first root', () => {
    expect(
      portalContentsMarkdown([block('DNA', 2), block('purines', 3), block('Purines ^pur1', 2)])
    ).toBe('- DNA\n  - purines\n- Purines')
  })

  it('is empty for an empty slice', () => {
    expect(portalContentsMarkdown([])).toBe('')
  })
})

describe('portalLinkText', () => {
  it('links the first root block, or the whole note', () => {
    expect(
      portalLinkText('Lecture 1', { kind: 'blocks', note: 'n', blocks: ['abcd', 'efgh'], open: {} })
    ).toBe('[[Lecture 1#^abcd]]')
    expect(portalLinkText('Lecture 1', { kind: 'note', note: 'n' })).toBe('[[Lecture 1]]')
  })
})
