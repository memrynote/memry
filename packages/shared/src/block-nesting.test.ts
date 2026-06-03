import { describe, expect, it } from 'vitest'
import {
  createBlockNestingMarker,
  restoreBlockNesting,
  splitMarkdownByBlockNestingMarkers
} from './block-nesting'

describe('block nesting helpers', () => {
  it('splits markdown by hidden nesting markers', () => {
    const markdown = [
      'Parent',
      '',
      createBlockNestingMarker(1),
      'Child',
      '',
      createBlockNestingMarker(0),
      'Sibling'
    ].join('\n')

    expect(splitMarkdownByBlockNestingMarkers(markdown)).toEqual([
      { level: 0, text: 'Parent' },
      { level: 1, text: 'Child' },
      { level: 0, text: 'Sibling' }
    ])
  })

  it('ignores marker-looking text inside code fences', () => {
    const markdown = [
      '```html',
      '<!-- memry:block-nesting-level=1 -->',
      '```',
      '',
      createBlockNestingMarker(1),
      'Child'
    ].join('\n')

    expect(splitMarkdownByBlockNestingMarkers(markdown)).toEqual([
      { level: 0, text: '```html\n<!-- memry:block-nesting-level=1 -->\n```' },
      { level: 1, text: 'Child' }
    ])
  })

  it('rebuilds nested block children from flat blocks and levels', () => {
    const blocks = [
      { id: 'parent', children: [] },
      { id: 'child', children: [] },
      { id: 'sibling', children: [] }
    ]

    expect(restoreBlockNesting(blocks, [0, 1, 0])).toEqual([
      { id: 'parent', children: [{ id: 'child', children: [] }] },
      { id: 'sibling', children: [] }
    ])
  })
})
