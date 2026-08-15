import { describe, expect, it } from 'vitest'

import {
  WikiLink,
  createWikiLinkInlineContent,
  hasWikiLinkMarks,
  parseWikiLinkText
} from './wiki-link'

describe('wiki-link inline content spec', () => {
  it('parses wiki text and creates inline content payloads', () => {
    expect(parseWikiLinkText(' [[Daily Note|Today]] ')).toEqual({
      target: 'Daily Note',
      alias: 'Today'
    })
    expect(parseWikiLinkText('[[Project]]')).toEqual({ target: 'Project', alias: '' })
    expect(parseWikiLinkText('[[ |Alias]]')).toBeNull()
    expect(parseWikiLinkText('not a link')).toBeNull()
    expect(createWikiLinkInlineContent('Roadmap', '')).toEqual({
      type: 'wikiLink',
      props: { target: 'Roadmap', alias: '' }
    })
  })

  it('renders, parses, and serializes wiki-link DOM nodes', () => {
    const render = (WikiLink as any).implementation.render({
      props: { target: 'Daily Note', alias: 'Today' }
    })
    expect(render.dom.textContent).toBe('Today')
    expect(render.dom).toHaveAttribute('data-wiki-link', '')
    expect(render.dom).toHaveAttribute('data-target', 'Daily Note')
    expect(render.dom).toHaveAttribute('data-alias', 'Today')
    expect(render.dom).toHaveAttribute('contenteditable', 'false')

    const dataElement = document.createElement('span')
    dataElement.setAttribute('data-wiki-link', '')
    dataElement.setAttribute('data-target', ' Project ')
    dataElement.setAttribute('data-alias', ' Plan ')
    expect((WikiLink as any).implementation.parse(dataElement)).toEqual({
      target: 'Project',
      alias: 'Plan'
    })

    const textElement = document.createElement('span')
    textElement.textContent = '[[Project]]'
    expect((WikiLink as any).implementation.parse(textElement)).toEqual({
      target: 'Project',
      alias: ''
    })

    dataElement.setAttribute('data-target', '')
    dataElement.textContent = 'plain'
    expect((WikiLink as any).implementation.parse(dataElement)).toBeUndefined()

    const externalWithAlias = (WikiLink as any).implementation.toExternalHTML({
      props: { target: 'Daily Note', alias: 'Today' }
    })
    expect(externalWithAlias.dom.textContent).toBe('[[Daily Note|Today]]')
    const externalWithoutAlias = (WikiLink as any).implementation.toExternalHTML({
      props: { target: 'Daily Note', alias: 'Daily Note' }
    })
    expect(externalWithoutAlias.dom.textContent).toBe('[[Daily Note]]')
  })

  // #1439 — the marks live in the node's props, and both halves of the spec
  // have to emit them. `render` is not decoration here: BlockNote serializes
  // inline content inside a TABLE through `render`, not `toExternalHTML`.
  describe('marks carried in props', () => {
    const external = (props: Record<string, unknown>): HTMLElement =>
      (WikiLink as any).implementation.toExternalHTML({ props }).dom

    // The unmarked shape is the byte-stability guard: a bare span holding the
    // text, exactly as before the props existed.
    it('emits a bare span when nothing is marked', () => {
      expect(external({ target: 'A', alias: '' }).outerHTML).toBe('<span>[[A]]</span>')
      expect(
        external({
          target: 'A',
          alias: '',
          bold: false,
          italic: false,
          underline: false,
          strike: false,
          code: false,
          textColor: 'default',
          backgroundColor: 'default'
        }).outerHTML
      ).toBe('<span>[[A]]</span>')
    })

    it.each([
      [{ bold: true }, '<span><strong>[[A]]</strong></span>'],
      [{ italic: true }, '<span><em>[[A]]</em></span>'],
      [{ strike: true }, '<span><s>[[A]]</s></span>'],
      [{ code: true }, '<span><code>[[A]]</code></span>'],
      [{ underline: true }, '<span><u>[[A]]</u></span>'],
      // Outer-to-inner in BlockNote's own mark order, which is what makes the
      // markdown match a styled text run byte for byte.
      [
        { bold: true, italic: true, underline: true, strike: true, code: true },
        '<span><strong><em><u><s><code>[[A]]</code></s></u></em></strong></span>'
      ]
    ])('wraps %j', (marks, expected) => {
      expect(external({ target: 'A', alias: '', ...marks }).outerHTML).toBe(expected)
    })

    it('keeps the chip attributes and applies the marks inside it', () => {
      const dom = (WikiLink as any).implementation.render({
        props: { target: 'A', alias: 'b', bold: true, code: true, textColor: 'red' }
      }).dom

      // The chip stays the outer element — the editor keys click handling and
      // the hover card off these attributes.
      expect(dom).toHaveAttribute('data-wiki-link', '')
      expect(dom).toHaveAttribute('data-target', 'A')
      expect(dom).toHaveAttribute('contenteditable', 'false')
      // BlockNote's stylesheet colours it off this attribute.
      expect(dom).toHaveAttribute('data-text-color', 'red')
      expect(dom.textContent).toBe('b')
      expect(dom.innerHTML).toBe('<strong><code>b</code></strong>')
    })

    it('sets no colour attributes when the link is not coloured', () => {
      const dom = (WikiLink as any).implementation.render({
        props: { target: 'A', alias: '', textColor: 'default', backgroundColor: 'default' }
      }).dom
      expect(dom).not.toHaveAttribute('data-text-color')
      expect(dom).not.toHaveAttribute('data-background-color')
    })

    it('reads marks off a styles object, ignoring defaults', () => {
      expect(createWikiLinkInlineContent('A', '', { bold: true, textColor: 'default' })).toEqual({
        type: 'wikiLink',
        props: { target: 'A', alias: '', bold: true }
      })
      expect(createWikiLinkInlineContent('A', '', {})).toEqual({
        type: 'wikiLink',
        props: { target: 'A', alias: '' }
      })
    })

    // The narrowing reads this, so it has to agree with `wikiLinkMarkProps`
    // exactly: a run whose marks are all at their defaults promotes as before.
    it.each([
      [{ bold: true }, true],
      [{ strike: true }, true],
      [{ underline: true }, true],
      [{ textColor: 'red' }, true],
      [{ backgroundColor: 'blue' }, true],
      [{}, false],
      [{ bold: false, italic: false }, false],
      [{ textColor: 'default', backgroundColor: 'default' }, false]
    ])('hasWikiLinkMarks(%j) is %s', (styles, expected) => {
      expect(hasWikiLinkMarks(styles)).toBe(expected)
      expect(hasWikiLinkMarks(undefined)).toBe(false)
    })
  })
})
