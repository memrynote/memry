import { describe, expect, it } from 'vitest'
import {
  extractHeadings,
  normalizeInlineContent,
  normalizeMarkdownHardBreaks,
  normalizeTableContent,
  normalizeWikiLinks,
  parseWikiLinkQuery,
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

  describe('parseWikiLinkQuery', () => {
    it('reads the note, heading and alias halves', () => {
      expect(parseWikiLinkQuery('Toplantı#Kararlar|notlar')).toEqual({
        search: 'Toplantı#Kararlar',
        note: 'Toplantı',
        heading: 'Kararlar',
        alias: 'notlar'
      })
    })

    it('reports no heading at all when no # was typed', () => {
      expect(parseWikiLinkQuery('Toplantı')).toEqual({
        search: 'Toplantı',
        note: 'Toplantı',
        heading: null,
        alias: ''
      })
    })

    it('reports an empty heading the moment # is typed', () => {
      expect(parseWikiLinkQuery('Toplantı#')).toEqual({
        search: 'Toplantı#',
        note: 'Toplantı',
        heading: '',
        alias: ''
      })
    })

    it('keeps the raw search so a # inside a title can still be looked up', () => {
      expect(parseWikiLinkQuery('Sprint #4')).toEqual({
        search: 'Sprint #4',
        note: 'Sprint',
        heading: '4',
        alias: ''
      })
    })

    it('takes the last segment of a nested heading path', () => {
      expect(parseWikiLinkQuery('Note#One#Two')).toMatchObject({
        note: 'Note',
        heading: 'Two'
      })
    })
  })

  describe('the caret block is exempt from promotion', () => {
    const blocks = () =>
      [
        { id: 'editing', type: 'paragraph', content: 'Read [[Daily Note]] now' },
        { id: 'other', type: 'paragraph', content: 'Also [[Roadmap]]' }
      ] as any

    it('promotes every block when no block is skipped', () => {
      const result = normalizeWikiLinks(blocks())
      expect(result.didChange).toBe(true)
      expect(JSON.stringify(result.blocks)).not.toContain('[[')
    })

    it('leaves the skipped block as raw text and still promotes the others', () => {
      const result = normalizeWikiLinks(blocks(), { skipBlockId: 'editing' })

      expect(result.didChange).toBe(true)
      expect(result.blocks[0].content).toBe('Read [[Daily Note]] now')
      expect(result.blocks[1].content).toEqual([
        'Also ',
        { type: 'wikiLink', props: { target: 'Roadmap', alias: '' } }
      ])
    })

    it('reports no change at all when the skipped block holds the only link', () => {
      const result = normalizeWikiLinks(
        [{ id: 'editing', type: 'paragraph', content: 'Read [[Daily Note]] now' }] as any,
        { skipBlockId: 'editing' }
      )

      expect(result.didChange).toBe(false)
    })

    it('still promotes a child block nested under the skipped one', () => {
      const result = normalizeWikiLinks(
        [
          {
            id: 'editing',
            type: 'paragraph',
            content: '[[Daily Note]]',
            children: [{ id: 'child', type: 'paragraph', content: '[[Roadmap]]' }]
          }
        ] as any,
        { skipBlockId: 'editing' }
      )

      expect(result.blocks[0].content).toBe('[[Daily Note]]')
      expect(result.blocks[0].children?.[0].content).toEqual([
        { type: 'wikiLink', props: { target: 'Roadmap', alias: '' } }
      ])
    })
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
      { type: 'text', text: 'See [[Roadmap]]', styles: {} },
      { type: 'wikiLink', props: { target: 'Existing', alias: '' } }
    ])
    expect(inline.didChange).toBe(true)
    expect(inline.content).toEqual([
      { type: 'text', text: 'See ', styles: {} },
      { type: 'wikiLink', props: { target: 'Roadmap', alias: '' } },
      { type: 'wikiLink', props: { target: 'Existing', alias: '' } }
    ])

    // The same run with a mark on it is left alone (#1439): the link is not the
    // whole styled run, and splitting it emits markdown GFM cannot parse.
    const marked = normalizeInlineContent([
      { type: 'text', text: 'See [[Roadmap]]', styles: { italic: true } }
    ])
    expect(marked.didChange).toBe(false)
    expect(marked.content).toEqual([
      { type: 'text', text: 'See [[Roadmap]]', styles: { italic: true } }
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

  // #1439. Promotion runs on every change, so this fires on mere open: before
  // the marks moved into the node's props, `**[[A]]**` became `[[A]]` on disk
  // the first time anyone looked at the note.
  describe('promotion carries the run’s marks into the node', () => {
    const promote = (styles: Record<string, unknown>): unknown =>
      (splitTextWithWikiLinks('[[A]]', styles as any).segments[0] as any).props

    it.each([
      [{ bold: true }, { bold: true }],
      [{ italic: true }, { italic: true }],
      [{ strike: true }, { strike: true }],
      [{ code: true }, { code: true }],
      [{ underline: true }, { underline: true }],
      [{ textColor: 'red' }, { textColor: 'red' }],
      [{ backgroundColor: 'blue' }, { backgroundColor: 'blue' }],
      [
        { bold: true, italic: true, strike: true, code: true },
        { bold: true, italic: true, strike: true, code: true }
      ]
    ])('carries %j', (styles, expected) => {
      expect(promote(styles)).toEqual({ target: 'A', alias: '', ...expected })
    })

    // Defaults are omitted rather than written out, so an unstyled link is the
    // same two-key object it has always been — the shape every already-synced
    // document holds.
    it.each([
      [{}],
      [{ bold: false }],
      [{ textColor: 'default' }],
      [{ backgroundColor: 'default' }]
    ])('writes no mark props for %j', (styles) => {
      expect(promote(styles)).toEqual({ target: 'A', alias: '' })
    })

    it('carries marks through an aliased link that is the whole run', () => {
      const { segments, didChange } = splitTextWithWikiLinks('[[A|b]]', { bold: true } as any)
      expect(didChange).toBe(true)
      expect(segments).toEqual([
        { type: 'wikiLink', props: { target: 'A', alias: 'b', bold: true } }
      ])
    })
  })

  /**
   * The narrowing (#1439). A marked run promotes ONLY when the link is the
   * whole of it. Splitting a marked run puts the node's own `<s>`/`<strong>`
   * wrapper next to the run's, BlockNote cannot merge marks across an element
   * boundary, and the file grows by four characters on every single open —
   * `~~Cancelled: [[Meeting]]~~` went 26→30→34→38→42→46 and never converged.
   *
   * Declining costs a link chip inside a marked sentence. It buys the user's
   * bytes, which is the trade this issue settled on.
   */
  describe('a marked run that is more than the link does not promote at all', () => {
    it.each([
      ['text before the link', 'Cancelled: [[Meeting]]'],
      ['text after the link', '[[Meeting]] cancelled'],
      ['text on both sides', 'See [[Roadmap]] for details'],
      ['two links in one run', '[[A]] and [[B]]'],
      ['a trailing space inside the run', '[[A]] '],
      ['a leading space inside the run', ' [[A]]']
    ])('%s', (_name, text) => {
      for (const styles of [
        { bold: true },
        { italic: true },
        { strike: true },
        { code: true },
        { underline: true },
        { textColor: 'red' },
        { backgroundColor: 'blue' }
      ]) {
        const result = splitTextWithWikiLinks(text, styles as any)
        expect(result.didChange).toBe(false)
        expect(result.segments).toEqual([{ type: 'text', text, styles }])
      }
    })

    // Without marks there is nothing to lose, so the same shapes promote
    // exactly as they always have. This is the line the narrowing must not
    // cross: every unmarked wiki link in every vault takes this path.
    it('an UNMARKED run still promotes everywhere it used to', () => {
      const result = splitTextWithWikiLinks('See [[Roadmap]] for details', { bold: false } as any)
      expect(result.didChange).toBe(true)
      expect(result.segments).toEqual([
        { type: 'text', text: 'See ', styles: { bold: false } },
        { type: 'wikiLink', props: { target: 'Roadmap', alias: '' } },
        { type: 'text', text: ' for details', styles: { bold: false } }
      ])
    })

    it('normalizeWikiLinks leaves a whole block alone when the only link is inside a marked phrase', () => {
      const blocks = normalizeWikiLinks([
        {
          id: 'p1',
          type: 'paragraph',
          content: [{ type: 'text', text: 'Cancelled: [[Meeting]]', styles: { strike: true } }]
        }
      ] as any)
      expect(blocks.didChange).toBe(false)
    })
  })

  it('normalizes markdown hard breaks outside fenced code blocks', () => {
    expect(normalizeMarkdownHardBreaks('one\\\ntwo')).toBe('one\ntwo')
    expect(normalizeMarkdownHardBreaks('```\\\ncode\\\n```')).toBe('```\\\ncode\\\n```')
    expect(normalizeMarkdownHardBreaks('keep\\\\\nnext')).toBe('keep\\\\\nnext')
  })
})
