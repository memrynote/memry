import { Schema } from '@tiptap/pm/model'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'
import { describe, expect, it } from 'vitest'
import { createWikiLinkCardPlugin, SOLE_LINK_ATTRIBUTE } from './wiki-link-card-plugin'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] },
    heading: { group: 'block', content: 'inline*', toDOM: () => ['h1', 0] },
    wikiLink: {
      group: 'inline',
      inline: true,
      atom: true,
      attrs: { target: { default: '' }, size: { default: 'none' }, preview: { default: false } },
      toDOM: () => ['span']
    },
    text: { group: 'inline' }
  }
})

function decorated(...blocks: ProseMirrorNode[]) {
  const plugin = createWikiLinkCardPlugin()
  const state = EditorState.create({ doc: schema.node('doc', null, blocks), plugins: [plugin] })
  const set = plugin.getState(state)!
  return set.find().map((decoration) => ({
    from: decoration.from,
    attrs: (decoration as unknown as { type: { attrs: Record<string, string> } }).type.attrs
  }))
}

const link = (attrs: Record<string, unknown>) =>
  schema.node('wikiLink', { target: 'Dune', ...attrs })
const paragraph = (...children: ProseMirrorNode[]) => schema.node('paragraph', null, children)

describe('createWikiLinkCardPlugin', () => {
  it('marks a link alone in its paragraph that asks for a row or a card', () => {
    expect(decorated(paragraph(link({ size: 'small' })))).toEqual([
      { from: 1, attrs: { [SOLE_LINK_ATTRIBUTE]: 'small' } }
    ])
    expect(decorated(paragraph(link({ size: 'medium' })))[0].attrs[SOLE_LINK_ATTRIBUTE]).toBe(
      'medium'
    )
  })

  it('marks a chip that shows a preview', () => {
    expect(decorated(paragraph(link({ preview: true })))[0].attrs[SOLE_LINK_ATTRIBUTE]).toBe('none')
  })

  it('leaves a link with the default settings undecorated', () => {
    expect(decorated(paragraph(link({})))).toEqual([])
  })

  it('leaves a link inside running text a chip, whatever its settings', () => {
    expect(
      decorated(
        paragraph(schema.text('See '), link({ size: 'medium', preview: true })),
        paragraph(link({ size: 'small' }), schema.text(' later'))
      )
    ).toEqual([])
  })

  it('leaves a link outside a paragraph a chip', () => {
    expect(decorated(schema.node('heading', null, [link({ size: 'small' })]))).toEqual([])
  })

  it('decorates each such link in a document of several', () => {
    const marked = decorated(
      paragraph(link({ size: 'small' })),
      paragraph(schema.text('plain')),
      paragraph(link({ size: 'medium' }))
    )

    expect(marked.map((m) => m.attrs[SOLE_LINK_ATTRIBUTE])).toEqual(['small', 'medium'])
  })
})
