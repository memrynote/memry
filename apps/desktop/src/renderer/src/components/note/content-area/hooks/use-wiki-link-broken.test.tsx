/**
 * The IPC half of #1716: one batch resolve on mount, note-half-first candidate
 * order, and the `notes:created` re-resolve that restyles an open editor.
 */

import { Schema } from '@tiptap/pm/model'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'
import type { Transaction } from '@tiptap/pm/state'
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WIKI_LINK_BROKEN_PLUGIN_KEY, createWikiLinkBrokenPlugin } from '../wiki-link-broken-plugin'

const mocks = vi.hoisted(() => ({
  resolveTitles: vi.fn<(titles: string[]) => Promise<Record<string, unknown>>>(),
  createdCallbacks: [] as Array<() => void>,
  renamedCallbacks: [] as Array<() => void>,
  deletedCallbacks: [] as Array<() => void>
}))

vi.mock('@/services/notes-service', () => ({
  notesService: { resolveTitles: mocks.resolveTitles },
  onNoteCreated: (callback: () => void) => {
    mocks.createdCallbacks.push(callback)
    return () => {}
  },
  onNoteRenamed: (callback: () => void) => {
    mocks.renamedCallbacks.push(callback)
    return () => {}
  },
  onNoteDeleted: (callback: () => void) => {
    mocks.deletedCallbacks.push(callback)
    return () => {}
  }
}))

import { useWikiLinkBroken } from './use-wiki-link-broken'

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

function editorWith(targets: string[]) {
  const doc = schema.node('doc', null, [
    schema.node(
      'paragraph',
      null,
      targets.map((target) => schema.node('wikiLink', { target }))
    )
  ])
  const view = {
    state: EditorState.create({ doc, plugins: [createWikiLinkBrokenPlugin()] }),
    dispatch(tr: Transaction) {
      view.state = view.state.apply(tr)
    }
  }
  return {
    _tiptapEditor: {
      view,
      // Real tiptap sets `editorView` to the same view while mounted and nulls
      // it on unmount; `view` alone is a Proxy that lies. The hook reads
      // `editorView` to tell a live view from a torn-down one.
      editorView: view,
      on: vi.fn(),
      off: vi.fn(),
      // The hook's plugin-registration effect no-ops through these; the plugin
      // is already in the state above so meta dispatches land on it.
      registerPlugin: vi.fn(),
      unregisterPlugin: vi.fn()
    }
  }
}

function brokenTargetsOf(state: EditorState): string[] {
  const decorations = WIKI_LINK_BROKEN_PLUGIN_KEY.getState(state)?.decorations
  if (!decorations) return []
  return decorations.find().map((decoration) => {
    const node = (state.doc as ProseMirrorNode).nodeAt(decoration.from)
    return typeof node?.attrs.target === 'string' ? node.attrs.target : ''
  })
}

async function flushResolve(): Promise<void> {
  await vi.advanceTimersByTimeAsync(500)
}

describe('useWikiLinkBroken', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.resolveTitles.mockReset()
    mocks.createdCallbacks.length = 0
    mocks.renamedCallbacks.length = 0
    mocks.deletedCallbacks.length = 0
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves the mount targets in one batch and marks only the miss', async () => {
    mocks.resolveTitles.mockResolvedValue({
      'Real Note': { id: 'nte_real', path: 'Real Note.md' },
      Ghost: null
    })
    const editor = editorWith(['Real Note', 'Ghost'])

    renderHook(() => useWikiLinkBroken(editor))
    await flushResolve()

    expect(mocks.resolveTitles).toHaveBeenCalledTimes(1)
    expect(mocks.resolveTitles).toHaveBeenCalledWith(['Real Note', 'Ghost'])
    expect(brokenTargetsOf(editor._tiptapEditor.view.state)).toEqual(['Ghost'])
  })

  it('reads Note#Heading through its note half and never marks [[#Heading]]', async () => {
    mocks.resolveTitles.mockResolvedValue({
      'Sprint Plan': { id: 'nte_sprint', path: 'Sprint Plan.md' },
      'Sprint Plan#Goals': null,
      Gone: null,
      'Gone#Intro': null
    })
    const editor = editorWith(['Sprint Plan#Goals', 'Gone#Intro', '#Local Heading'])

    renderHook(() => useWikiLinkBroken(editor))
    await flushResolve()

    expect(brokenTargetsOf(editor._tiptapEditor.view.state)).toEqual(['Gone#Intro'])
  })

  it('re-resolves on notes:created and unmarks the link without a reload', async () => {
    mocks.resolveTitles.mockResolvedValue({ Ghost: null })
    const editor = editorWith(['Ghost'])

    renderHook(() => useWikiLinkBroken(editor))
    await flushResolve()
    expect(brokenTargetsOf(editor._tiptapEditor.view.state)).toEqual(['Ghost'])

    mocks.resolveTitles.mockResolvedValue({ Ghost: { id: 'nte_new', path: 'Ghost.md' } })
    mocks.createdCallbacks.forEach((callback) => callback())
    await flushResolve()

    expect(mocks.resolveTitles).toHaveBeenCalledTimes(2)
    expect(brokenTargetsOf(editor._tiptapEditor.view.state)).toEqual([])
  })
})
