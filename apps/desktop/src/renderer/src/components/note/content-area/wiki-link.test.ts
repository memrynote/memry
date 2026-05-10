import { describe, expect, it } from 'vitest'

import { WikiLink, createWikiLinkInlineContent, parseWikiLinkText } from './wiki-link'

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
})
