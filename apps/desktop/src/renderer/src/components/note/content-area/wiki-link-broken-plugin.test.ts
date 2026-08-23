/**
 * The broken-set → decoration half of #1716, driven through a real ProseMirror
 * state. The IPC half (batch resolve, note events) lives in
 * `use-wiki-link-broken.test.tsx`.
 */

import { Schema } from '@tiptap/pm/model'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'
import type { Transaction } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { describe, expect, it } from 'vitest'
import {
  WIKI_LINK_BROKEN_PLUGIN_KEY,
  collectWikiLinkTargets,
  createWikiLinkBrokenPlugin,
  setBrokenWikiTargets
} from './wiki-link-broken-plugin'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] },
    wikiLink: {
      group: 'inline',
      inline: true,
      atom: true,
      attrs: { target: { default: '' }, alias: { default: '' } },
      toDOM: () => ['span']
    },
    text: { group: 'inline' }
  }
})

function chip(target: string): ProseMirrorNode {
  return schema.node('wikiLink', { target })
}

function stateWith(nodes: ProseMirrorNode[]): EditorState {
  const doc = schema.node('doc', null, [schema.node('paragraph', null, nodes)])
  return EditorState.create({ doc, plugins: [createWikiLinkBrokenPlugin()] })
}

/** A stand-in for `EditorView` carrying only what `setBrokenWikiTargets` touches. */
function viewOf(state: EditorState): EditorView & { state: EditorState } {
  const view = {
    state,
    dispatch(tr: Transaction) {
      view.state = view.state.apply(tr)
    }
  }
  return view as unknown as EditorView & { state: EditorState }
}

function brokenTargetsOf(state: EditorState): string[] {
  const decorations = WIKI_LINK_BROKEN_PLUGIN_KEY.getState(state)?.decorations
  if (!decorations) return []
  return decorations.find().map((decoration) => {
    const node = state.doc.nodeAt(decoration.from)
    return typeof node?.attrs.target === 'string' ? node.attrs.target : ''
  })
}

describe('collectWikiLinkTargets', () => {
  it('dedupes targets and skips empty ones', () => {
    const state = stateWith([chip('Ghost'), schema.text(' and '), chip('Ghost'), chip('')])
    expect(collectWikiLinkTargets(state.doc)).toEqual(['Ghost'])
  })
})

describe('createWikiLinkBrokenPlugin', () => {
  it('marks the unresolved target and leaves the resolved one alone', () => {
    const view = viewOf(stateWith([chip('Ghost'), schema.text(' vs '), chip('Real Note')]))

    setBrokenWikiTargets(view, new Set(['ghost']))

    expect(brokenTargetsOf(view.state)).toEqual(['Ghost'])
  })

  it('clears the class when a fresh set no longer names the target', () => {
    const view = viewOf(stateWith([chip('Ghost')]))
    setBrokenWikiTargets(view, new Set(['ghost']))

    setBrokenWikiTargets(view, new Set())

    expect(brokenTargetsOf(view.state)).toEqual([])
  })

  it('styles a link typed after the resolve pass against the known set', () => {
    const view = viewOf(stateWith([chip('Ghost')]))
    setBrokenWikiTargets(view, new Set(['ghost']))

    const insertAt = view.state.doc.content.size - 1
    view.dispatch(view.state.tr.insert(insertAt, chip('Ghost')))

    expect(brokenTargetsOf(view.state)).toEqual(['Ghost', 'Ghost'])
  })
})
