/**
 * Per-link display settings (#2845): which link may carry them, and how a change
 * reaches the document. Driven through a real ProseMirror state, because the
 * rule is about the document's shape, not about a helper's arguments.
 */

import { Schema } from '@tiptap/pm/model'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'
import type { Transaction } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { describe, expect, it } from 'vitest'
import { isSoleWikiLinkAt, setWikiLinkDisplayAt, wikiLinkDisplayAt } from './wiki-link-display'

const displaySchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] },
    heading: { group: 'block', content: 'inline*', toDOM: () => ['h1', 0] },
    wikiLink: {
      group: 'inline',
      inline: true,
      atom: true,
      attrs: {
        target: { default: '' },
        alias: { default: '' },
        bold: { default: false },
        size: { default: 'none' },
        cover: { default: false },
        preview: { default: false }
      },
      toDOM: () => ['span']
    },
    text: { group: 'inline' }
  }
})

function link(attrs: Record<string, unknown> = { target: 'Dune' }): ProseMirrorNode {
  return displaySchema.node('wikiLink', attrs)
}

function docOf(...blocks: ProseMirrorNode[]): ProseMirrorNode {
  return displaySchema.node('doc', null, blocks)
}

function paragraph(...children: ProseMirrorNode[]): ProseMirrorNode {
  return displaySchema.node('paragraph', null, children)
}

function viewOf(doc: ProseMirrorNode) {
  const view = {
    state: EditorState.create({ doc }),
    dispatched: [] as Transaction[],
    dispatch(tr: Transaction) {
      view.dispatched.push(tr)
      view.state = view.state.apply(tr)
    }
  }
  return view
}

describe('isSoleWikiLinkAt', () => {
  it('is true for a link that is the whole of its paragraph', () => {
    expect(isSoleWikiLinkAt(docOf(paragraph(link())), 1)).toBe(true)
  })

  it('is false inside running text, before or after it', () => {
    const text = displaySchema.text('See ')
    expect(isSoleWikiLinkAt(docOf(paragraph(text, link())), 5)).toBe(false)
    expect(isSoleWikiLinkAt(docOf(paragraph(link(), displaySchema.text(' later'))), 1)).toBe(false)
  })

  it('is true when only whitespace sits beside the link, as after inserting one with [[', () => {
    // The `[[` picker inserts the link followed by a space, so a link the user
    // has just added is `[link, " "]` until the note is reopened.
    const space = displaySchema.text(' ')
    expect(isSoleWikiLinkAt(docOf(paragraph(link(), space)), 1)).toBe(true)
    expect(isSoleWikiLinkAt(docOf(paragraph(space, link())), 2)).toBe(true)
  })

  it('is false when the paragraph holds two links', () => {
    expect(isSoleWikiLinkAt(docOf(paragraph(link(), link({ target: 'Arrakis' }))), 1)).toBe(false)
  })

  it('is false outside a paragraph, which is where the marker is not written', () => {
    expect(isSoleWikiLinkAt(docOf(displaySchema.node('heading', null, [link()])), 1)).toBe(false)
  })
})

describe('wikiLinkDisplayAt', () => {
  it('reads the settings of a sole link, with defaults for a link from an older build', () => {
    expect(wikiLinkDisplayAt(docOf(paragraph(link())), 1)).toEqual({
      size: 'none',
      cover: false,
      preview: false
    })
    expect(
      wikiLinkDisplayAt(docOf(paragraph(link({ target: 'A', size: 'medium', cover: true }))), 1)
    ).toEqual({ size: 'medium', cover: true, preview: false })
  })

  it('is null for a link inside running text, which hides the menu items', () => {
    const doc = docOf(paragraph(displaySchema.text('See '), link()))
    expect(wikiLinkDisplayAt(doc, 5)).toBeNull()
  })
})

describe('setWikiLinkDisplayAt', () => {
  it('writes the new props on the node and keeps its target, alias and marks', () => {
    const view = viewOf(docOf(paragraph(link({ target: 'Dune', alias: 'the sequel', bold: true }))))

    expect(setWikiLinkDisplayAt(view as unknown as EditorView, 1, 'Dune', { size: 'small' })).toBe(
      true
    )

    expect(view.state.doc.nodeAt(1)?.attrs).toMatchObject({
      target: 'Dune',
      alias: 'the sequel',
      bold: true,
      size: 'small',
      cover: false,
      preview: false
    })
  })

  it('changes one setting without disturbing the others', () => {
    const view = viewOf(docOf(paragraph(link({ target: 'Dune', size: 'medium', cover: true }))))

    setWikiLinkDisplayAt(view as unknown as EditorView, 1, 'Dune', { preview: true })

    expect(view.state.doc.nodeAt(1)?.attrs).toMatchObject({
      size: 'medium',
      cover: true,
      preview: true
    })
  })

  it('refuses a link inside running text', () => {
    const view = viewOf(docOf(paragraph(displaySchema.text('See '), link())))

    expect(setWikiLinkDisplayAt(view as unknown as EditorView, 5, 'Dune', { size: 'small' })).toBe(
      false
    )
    expect(view.dispatched).toHaveLength(0)
  })

  it('refuses when the node under the position is no longer the link the menu opened on', () => {
    const view = viewOf(docOf(paragraph(link({ target: 'Other' }))))

    expect(setWikiLinkDisplayAt(view as unknown as EditorView, 1, 'Dune', { size: 'small' })).toBe(
      false
    )
    expect(view.dispatched).toHaveLength(0)
  })
})
