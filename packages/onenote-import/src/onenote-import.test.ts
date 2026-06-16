import { describe, it, expect } from 'vitest'
import { mapTree } from './map-tree.ts'
import { preparePageHtml } from './prepare-page-html.ts'
import { extractDataImages, extensionForMime } from './extract-images.ts'
import type { OneNoteNotebook, OneNotePage, OneNoteSection } from './types.ts'

describe('mapTree', () => {
  const notebooks: OneNoteNotebook[] = [
    { id: 'nb1', displayName: 'My Notebook' },
    { id: 'nb2', displayName: 'Work' }
  ]
  const sections: OneNoteSection[] = [
    { id: 's1', displayName: 'Ideas', notebookId: 'nb1' },
    { id: 's2', displayName: 'Meeting Notes', notebookId: 'nb2' }
  ]

  it('maps each page to OneNote/<notebook>/<section> with title + created', () => {
    const pages: OneNotePage[] = [
      { id: 'p1', title: 'First Page', sectionId: 's1', createdDateTime: '2024-03-05T10:00:00Z' },
      { id: 'p2', title: 'Sprint', sectionId: 's2' }
    ]
    const plans = mapTree(notebooks, sections, pages)
    expect(plans).toEqual([
      {
        pageId: 'p1',
        title: 'First Page',
        folder: 'OneNote/My Notebook/Ideas',
        created: '2024-03-05T10:00:00Z'
      },
      { pageId: 'p2', title: 'Sprint', folder: 'OneNote/Work/Meeting Notes' }
    ])
  })

  it('drops pages whose section or notebook is missing', () => {
    const pages: OneNotePage[] = [
      { id: 'p1', title: 'Orphan', sectionId: 'missing' },
      { id: 'p2', title: 'Keep', sectionId: 's1' }
    ]
    const plans = mapTree(notebooks, sections, pages)
    expect(plans.map((p) => p.pageId)).toEqual(['p2'])
  })

  it('falls back to Untitled for blank titles and folder names', () => {
    const plans = mapTree(
      [{ id: 'nb', displayName: '   ' }],
      [{ id: 's', displayName: '', notebookId: 'nb' }],
      [{ id: 'p', title: '  ', sectionId: 's' }]
    )
    expect(plans).toEqual([{ pageId: 'p', title: 'Untitled', folder: 'OneNote/Untitled/Untitled' }])
  })
})

describe('preparePageHtml', () => {
  it('expands self-closing object/iframe tags', () => {
    const { html } = preparePageHtml('<p>a<object data-attachment="x.pdf" data="..."/></p>')
    expect(html).toContain('<object data-attachment="x.pdf" data="..."></object>')
    expect(html).not.toMatch(/<object[^>]*\/>/)
  })

  it('removes empty paragraphs and blank-line filler', () => {
    const { html } = preparePageHtml('<p>keep</p><p>&nbsp;</p>\n  \n<p><br/></p>')
    expect(html).toContain('<p>keep</p>')
    expect(html).not.toContain('&nbsp;')
    expect(html).not.toMatch(/<p>(\s|<br\/?>)*<\/p>/)
  })

  it('promotes a monospace-styled paragraph to a pre/code block', () => {
    const { html } = preparePageHtml('<p style="font-family:Consolas">const x = 1</p>')
    expect(html).toBe('<pre><code>const x = 1</code></pre>')
  })

  it('wraps a bare <pre> in <code>', () => {
    const { html } = preparePageHtml('<pre>plain code</pre>')
    expect(html).toBe('<pre><code>plain code</code></pre>')
  })

  it('leaves a <pre><code> block untouched', () => {
    const input = '<pre><code>already</code></pre>'
    expect(preparePageHtml(input).html).toBe(input)
  })
})

describe('extractDataImages', () => {
  it('lifts data-URI images out and leaves a placeholder src', () => {
    const html =
      '<p><img alt="pic" src="data:image/png;base64,AAAB" width="10"></p>' +
      '<img src="data:image/jpeg;base64,ZZZ">'
    const result = extractDataImages(html)

    expect(result.images).toEqual([
      { placeholder: 'onenote-img-0', base64: 'AAAB', mime: 'image/png' },
      { placeholder: 'onenote-img-1', base64: 'ZZZ', mime: 'image/jpeg' }
    ])
    expect(result.html).toContain('src="onenote-img-0"')
    expect(result.html).toContain('alt="pic"')
    expect(result.html).toContain('width="10"')
    expect(result.html).not.toContain('data:image')
  })

  it('leaves http/relative image srcs untouched', () => {
    const html = '<img src="https://example.com/a.png"><img src="image1.png">'
    const result = extractDataImages(html)
    expect(result.images).toEqual([])
    expect(result.html).toBe(html)
  })

  it('maps mime types to extensions', () => {
    expect(extensionForMime('image/png')).toBe('png')
    expect(extensionForMime('image/jpeg')).toBe('jpg')
    expect(extensionForMime('image/svg+xml')).toBe('svg')
    expect(extensionForMime('image/gif')).toBe('gif')
  })
})
