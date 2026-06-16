import { describe, it, expect } from 'vitest'
import { convertBlocks, scrubMarkup } from './convert-blocks.ts'
import type { RoamBlock } from './types.ts'

describe('scrubMarkup', () => {
  it('converts {{[[TODO]]}} and {{TODO}} to "[ ] "', () => {
    expect(scrubMarkup('{{[[TODO]]}} buy milk')).toBe('[ ] buy milk')
    expect(scrubMarkup('{{TODO}} buy milk')).toBe('[ ] buy milk')
  })

  it('converts {{[[DONE]]}} and {{DONE}} to "[x] "', () => {
    expect(scrubMarkup('{{[[DONE]]}} shipped')).toBe('[x] shipped')
    expect(scrubMarkup('{{DONE}} shipped')).toBe('[x] shipped')
  })

  it('converts __italic__ to *italic*', () => {
    expect(scrubMarkup('this is __emphasis__ here')).toBe('this is *emphasis* here')
  })

  it('converts ^^highlight^^ to ==highlight==', () => {
    expect(scrubMarkup('a ^^marked^^ word')).toBe('a ==marked== word')
  })

  it('drops unknown templates: POMO, word-count, table', () => {
    expect(scrubMarkup('start {{[[POMO]]}} end')).toBe('start  end')
    expect(scrubMarkup('count {{word-count}} here')).toBe('count  here')
    expect(scrubMarkup('see {{[[table]]}} below')).toBe('see  below')
  })

  it('preserves ((uid)) block refs for phase 3', () => {
    expect(scrubMarkup('ref to ((abc123)) here')).toBe('ref to ((abc123)) here')
  })

  it('normalizes embeds to {{embed:((uid))}} and keeps them for phase 3', () => {
    expect(scrubMarkup('{{embed: ((xyz))}}')).toBe('{{embed:((xyz))}}')
    expect(scrubMarkup('{{[[embed]]: ((xyz))}}')).toBe('{{embed:((xyz))}}')
  })

  it('keeps page aliases [label]([[page]]) intact', () => {
    expect(scrubMarkup('[home]([[Home Page]])')).toBe('[home]([[Home Page]])')
  })
})

describe('convertBlocks', () => {
  it('renders nested blocks as indented bullets (2 spaces per depth)', () => {
    const blocks: RoamBlock[] = [
      {
        uid: 'a',
        string: 'top',
        children: [{ uid: 'b', string: 'child', children: [{ uid: 'c', string: 'grandchild' }] }]
      }
    ]
    expect(convertBlocks(blocks)).toBe('- top\n  - child\n    - grandchild')
  })

  it('renders heading levels as markdown headings on the bullet text', () => {
    const blocks: RoamBlock[] = [
      { uid: 'h1', string: 'Title', heading: 1 },
      { uid: 'h2', string: 'Sub', heading: 2 },
      { uid: 'h3', string: 'Subsub', heading: 3 }
    ]
    expect(convertBlocks(blocks)).toBe('- # Title\n- ## Sub\n- ### Subsub')
  })

  it('applies the scrub to each bullet', () => {
    const blocks: RoamBlock[] = [{ uid: 'x', string: '{{[[TODO]]}} __do__ ^^it^^' }]
    expect(convertBlocks(blocks)).toBe('- [ ] *do* ==it==')
  })

  it('returns empty string for no blocks', () => {
    expect(convertBlocks([])).toBe('')
  })
})
