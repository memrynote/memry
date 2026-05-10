import { describe, expect, it } from 'vitest'
import {
  extractHeadings,
  normalizeInlineContent,
  normalizeMarkdownHardBreaks,
  normalizeTableContent,
  normalizeWikiLinks,
  splitTextWithWikiLinks,
  splitWikiLinkQuery
} from './wiki-link-utils'

describe('wiki-link utils', () => {
  it('extracts nested headings with text content and positions', () => {
    const headings = extractHeadings([
      {
        id: 'h1',
        type: 'heading',
        props: { level: 2 },
        content: [{ type: 'text', text: 'Plan' }],
        children: [
          {
            id: 'h2',
            type: 'heading',
            props: { level: 3 },
            content: ['Next']
          }
        ]
      },
      { id: 'p1', type: 'paragraph', content: 'Body' }
    ] as any)

    expect(headings).toEqual([
      { id: 'h1', text: 'Plan', level: 2, position: 0 },
      { id: 'h2', text: 'Next', level: 3, position: 40 }
    ])
  })

  it('splits wiki link queries and inline text segments', () => {
    expect(splitWikiLinkQuery('Target | Alias')).toEqual({ search: 'Target', alias: 'Alias' })

    const plain = splitTextWithWikiLinks('No links', { bold: true })
    expect(plain.didChange).toBe(false)
    expect(plain.segments).toEqual([{ type: 'text', text: 'No links', styles: { bold: true } }])

    const linked = splitTextWithWikiLinks('Read [[Daily Note|today]] now')
    expect(linked.didChange).toBe(true)
    expect(linked.segments).toEqual([
      'Read ',
      { type: 'wikiLink', props: { target: 'Daily Note', alias: 'today' } },
      ' now'
    ])
  })

  it('normalizes strings, text objects, table cells, and nested blocks', () => {
    expect(normalizeInlineContent('[[Project]]').content).toEqual([
      { type: 'wikiLink', props: { target: 'Project', alias: '' } }
    ])

    const inline = normalizeInlineContent([
      { type: 'text', text: 'See [[Roadmap]]', styles: { italic: true } },
      { type: 'wikiLink', props: { target: 'Existing', alias: '' } }
    ])
    expect(inline.didChange).toBe(true)
    expect(inline.content).toEqual([
      { type: 'text', text: 'See ', styles: { italic: true } },
      { type: 'wikiLink', props: { target: 'Roadmap', alias: '' } },
      { type: 'wikiLink', props: { target: 'Existing', alias: '' } }
    ])

    const table = normalizeTableContent({
      rows: [{ cells: [[{ type: 'text', text: '[[Cell]]' }], { type: 'tableCell', content: 'x' }] }]
    })
    expect(table.didChange).toBe(true)
    expect(table.content.rows[0].cells[0][0]).toEqual({
      type: 'wikiLink',
      props: { target: 'Cell', alias: '' }
    })

    const blocks = normalizeWikiLinks([
      { id: 'code', type: 'codeBlock', content: '[[ignored]]' },
      {
        id: 'parent',
        type: 'paragraph',
        content: 'Parent',
        children: [{ id: 'child', type: 'paragraph', content: '[[Child]]' }]
      }
    ] as any)
    expect(blocks.didChange).toBe(true)
    expect((blocks.blocks[0] as any).content).toBe('[[ignored]]')
    expect((blocks.blocks[1] as any).children[0].content).toEqual([
      { type: 'wikiLink', props: { target: 'Child', alias: '' } }
    ])
  })

  it('normalizes markdown hard breaks outside fenced code blocks', () => {
    expect(normalizeMarkdownHardBreaks('one\\\ntwo')).toBe('one\ntwo')
    expect(normalizeMarkdownHardBreaks('```\\\ncode\\\n```')).toBe('```\\\ncode\\\n```')
    expect(normalizeMarkdownHardBreaks('keep\\\\\nnext')).toBe('keep\\\\\nnext')
  })
})
