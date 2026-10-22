/**
 * The display settings of a link (#2845) survive every path that rebuilds the
 * node: un-promoting it to `[[…]]` text for editing and promoting it back,
 * picking another target while it is open, and the open-time normalizer.
 *
 * A setting dropped here is not a cosmetic loss. The settings live only on the
 * node, and the vault file's `<!-- link-card:… -->` line is rewritten from it,
 * so a rebuild that forgets them deletes the line on the next write-back.
 */

import { Schema } from '@tiptap/pm/model'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import type { Transaction } from '@tiptap/pm/state'
import { describe, expect, it } from 'vitest'
import type { Block } from '@blocknote/core'
import { createWikiLinkEditPlugin, replaceActiveRunWithWikiLink } from './wiki-link-edit-plugin'
import { normalizeWikiLinks } from './wiki-link-utils'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] },
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
  },
  marks: { bold: { toDOM: () => ['strong', 0] } }
})

const CARD = { size: 'medium', cover: true, preview: true } as const

function stateWith(attrs: Record<string, unknown>): EditorState {
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, [schema.node('wikiLink', attrs)])
  ])
  const state = EditorState.create({ doc, plugins: [createWikiLinkEditPlugin()] })
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, 2)))
}

function viewOf(state: EditorState) {
  const view = {
    state,
    dispatch(tr: Transaction) {
      view.state = view.state.apply(tr)
    }
  }
  return view
}

function backspace(state: EditorState): EditorState {
  const plugin = createWikiLinkEditPlugin()
  const view = viewOf(state)
  plugin.props.handleKeyDown!.call(
    plugin,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    view as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { key: 'Backspace', shiftKey: false, metaKey: false, ctrlKey: false, altKey: false } as any
  )
  return view.state
}

function leaveRun(state: EditorState): EditorState {
  return state.apply(
    state.tr.setSelection(TextSelection.create(state.doc, state.doc.content.size - 1))
  )
}

function linkTo(state: EditorState, target: string): ProseMirrorNode | null {
  let found: ProseMirrorNode | null = null
  state.doc.descendants((node) => {
    if (!found && node.type.name === 'wikiLink' && node.attrs.target === target) found = node
  })
  return found
}

describe('un-promoting a link for editing', () => {
  it('gives the chip back with its size, cover and preview', () => {
    const opened = backspace(stateWith({ target: 'Dune', ...CARD }))
    expect(linkTo(opened, 'Dune')).toBeNull()

    expect(linkTo(leaveRun(opened), 'Dune')?.attrs).toMatchObject(CARD)
  })

  it('keeps them through a heading typed into the target, beside an alias', () => {
    const opened = backspace(stateWith({ target: 'Dune', alias: 'the sequel', ...CARD }))
    const typed = opened.apply(opened.tr.insertText('#Arrakis', opened.selection.from))

    expect(linkTo(leaveRun(typed), 'Dune#Arrakis')?.attrs).toMatchObject({
      alias: 'the sequel',
      ...CARD
    })
  })

  it('keeps them alongside the marks the chip carried', () => {
    const opened = backspace(stateWith({ target: 'Dune', bold: true, size: 'small' }))

    expect(linkTo(leaveRun(opened), 'Dune')?.attrs).toMatchObject({ bold: true, size: 'small' })
  })

  it('gives back a plain chip for a link that had no settings', () => {
    const closed = leaveRun(backspace(stateWith({ target: 'Dune' })))

    expect(linkTo(closed, 'Dune')?.attrs).toMatchObject({
      size: 'none',
      cover: false,
      preview: false
    })
  })

  it('does not hand a later link the settings of one edited before it', () => {
    const first = leaveRun(backspace(stateWith({ target: 'Dune', ...CARD })))
    const end = first.doc.content.size
    const withOther = first.apply(
      first.tr.insert(
        end,
        schema.node('paragraph', null, [schema.node('wikiLink', { target: 'Other' })])
      )
    )
    const caret = withOther.doc.content.size - 1
    const opened = backspace(
      withOther.apply(withOther.tr.setSelection(TextSelection.create(withOther.doc, caret)))
    )

    expect(linkTo(leaveRun(opened), 'Other')?.attrs).toMatchObject({
      size: 'none',
      cover: false,
      preview: false
    })
  })
})

describe('picking another target while a link is open', () => {
  it('keeps the settings of the link being edited', () => {
    const view = viewOf(backspace(stateWith({ target: 'Dune', ...CARD })))

    expect(
      replaceActiveRunWithWikiLink({ _tiptapEditor: { view } } as never, { target: 'Arrakis' })
    ).toBe(true)

    expect(linkTo(view.state, 'Arrakis')?.attrs).toMatchObject(CARD)
  })

  it('lets a pick that names its own settings win', () => {
    const view = viewOf(backspace(stateWith({ target: 'Dune', ...CARD })))

    replaceActiveRunWithWikiLink({ _tiptapEditor: { view } } as never, {
      target: 'Arrakis',
      size: 'small'
    })

    expect(linkTo(view.state, 'Arrakis')?.attrs).toMatchObject({ size: 'small', cover: true })
  })
})

describe('the open-time normalizer', () => {
  const link = { type: 'wikiLink', props: { target: 'Dune', alias: '', ...CARD } }

  it('leaves a link that already is a node, settings and all, untouched', () => {
    const blocks = [
      { id: 'a', type: 'paragraph', props: {}, content: [link], children: [] }
    ] as unknown as Block[]

    const result = normalizeWikiLinks(blocks)

    expect(result.didChange).toBe(false)
    expect(result.blocks[0].content).toEqual([link])
  })

  it('promotes text beside a configured link without touching the configured one', () => {
    const blocks = [
      {
        id: 'a',
        type: 'paragraph',
        props: {},
        content: [link, { type: 'text', text: ' and [[Arrakis]]', styles: {} }],
        children: []
      }
    ] as unknown as Block[]

    const content = normalizeWikiLinks(blocks).blocks[0].content as Array<{
      type: string
      props?: Record<string, unknown>
    }>

    expect(content[0]).toEqual(link)
    expect(content[2]).toMatchObject({ type: 'wikiLink', props: { target: 'Arrakis' } })
    expect(content[2].props).not.toHaveProperty('size')
  })
})
