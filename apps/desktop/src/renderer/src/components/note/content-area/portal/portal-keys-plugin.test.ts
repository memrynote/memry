import { afterEach, describe, expect, it, vi } from 'vitest'
import { NodeSelection, TextSelection } from '@tiptap/pm/state'
import type { PartialBlock } from '@blocknote/core'
import { renderHook } from '@testing-library/react'

vi.mock('react-pdf', () => ({
  Document: () => null,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: { workerSrc: '' } }
}))
vi.mock('@/lib/url-metadata', () => ({
  fetchLinkPreview: vi.fn().mockResolvedValue({ domain: '', title: '', favicon: '' })
}))

import { registerEditorPlugin } from '../register-editor-plugin'
import {
  createPortalKeysPlugin,
  portalKeysPluginKey,
  portalSelectionPast,
  prependPlugin,
  usePortalKeysPlugin
} from './portal-keys-plugin'
import { PORTAL_EXIT_EVENT, PORTAL_SELECT_EVENT } from './portal-boundary-plugin'
import { mountTestEditor, para, unmountTestEditors } from './portal-test-editor'

afterEach(unmountTestEditors)

const portal = (): PartialBlock =>
  ({
    type: 'codeBlock',
    props: { language: 'memry-portal' },
    content: '{"note":"src"}'
  }) as PartialBlock

/** The caret at the start (or end) of the block with this text. */
function caretIn(
  view: ReturnType<typeof mountTestEditor>['view'],
  text: string,
  at: 'start' | 'end'
) {
  let target = -1
  view.state.doc.descendants((node, pos) => {
    if (node.isTextblock && node.textContent === text)
      target = at === 'start' ? pos + 1 : pos + node.nodeSize - 1
  })
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, target)))
}

describe('portal keys', () => {
  it('selects the portal before the caret instead of merging into its definition', () => {
    const { editor, view } = mountTestEditor([para('above'), portal(), para('below')])
    registerEditorPlugin(editor, createPortalKeysPlugin(editor), prependPlugin)
    caretIn(view, 'below', 'start')

    view.dom.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })
    )

    expect(view.state.selection).toBeInstanceOf(NodeSelection)
    expect((view.state.selection as NodeSelection).node.firstChild?.attrs.language).toBe(
      'memry-portal'
    )
    expect(editor.document.map((b) => b.type)).toEqual(['paragraph', 'codeBlock', 'paragraph'])
  })

  it('finds the portal past the caret in both directions, and nothing else', () => {
    const { view } = mountTestEditor([para('above'), portal(), para('below'), para('last')])

    caretIn(view, 'above', 'end')
    expect(portalSelectionPast(view.state, 1)).toBeInstanceOf(NodeSelection)
    caretIn(view, 'below', 'start')
    expect(portalSelectionPast(view.state, -1)).toBeInstanceOf(NodeSelection)
    caretIn(view, 'last', 'start')
    expect(portalSelectionPast(view.state, -1)).toBeNull()
  })
})

function selectPortal(view: ReturnType<typeof mountTestEditor>['view']): void {
  let at = -1
  view.state.doc.descendants((node, pos) => {
    if (node.type.name === 'blockContainer' && node.firstChild?.attrs.language === 'memry-portal')
      at = pos
  })
  view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, at)))
}

/** True while the portal, not a caret in its hidden JSON, is the selection. */
const portalSelected = (view: ReturnType<typeof mountTestEditor>['view']): boolean => {
  const { selection } = view.state
  return (
    selection instanceof NodeSelection &&
    selection.node.firstChild?.attrs.language === 'memry-portal'
  )
}

const types = (editor: ReturnType<typeof mountTestEditor>['editor']): string[] =>
  editor.document.map((b) => `${b.type}${b.children.length ? `+${b.children.length}` : ''}`)

describe('a selected portal moves as one block', () => {
  it('indents under the previous block on Tab and outdents on Shift+Tab', () => {
    const { editor, view } = mountTestEditor([para('above'), portal(), para('below')])
    registerEditorPlugin(editor, createPortalKeysPlugin(editor), prependPlugin)
    selectPortal(view)

    view.dom.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    )
    expect(types(editor)).toEqual(['paragraph+1', 'paragraph'])
    expect(editor.document[0].children[0].type).toBe('codeBlock')
    expect(portalSelected(view)).toBe(true)

    selectPortal(view)
    view.dom.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })
    )
    expect(types(editor)).toEqual(['paragraph', 'codeBlock', 'paragraph'])
    expect(portalSelected(view)).toBe(true)
  })

  it('moves up and down with Shift-Mod-Arrow, definition intact', () => {
    const { editor, view } = mountTestEditor([para('above'), portal(), para('below')])
    registerEditorPlugin(editor, createPortalKeysPlugin(editor), prependPlugin)
    selectPortal(view)

    editor.moveBlocksDown()
    expect(types(editor)).toEqual(['paragraph', 'paragraph', 'codeBlock'])
    expect(portalSelected(view)).toBe(true)
    selectPortal(view)
    editor.moveBlocksUp()
    editor.moveBlocksUp()
    expect(types(editor)).toEqual(['codeBlock', 'paragraph', 'paragraph'])
    expect(portalSelected(view)).toBe(true)
    expect(JSON.stringify(editor.document[0].content)).toContain('src')
  })
})

describe('events from a window', () => {
  const windowIn = (view: ReturnType<typeof mountTestEditor>['view']): HTMLElement => {
    const el = document.createElement('div')
    el.setAttribute('data-portal-window', '')
    // The portal's block is the one whose content the test renderer leaves empty.
    const container = [...view.dom.querySelectorAll('[data-node-type="blockContainer"]')].find(
      (n) => !n.querySelector('.bn-block-content')
    )!
    container.appendChild(el)
    return el
  }

  it('select puts a NodeSelection on the portal', () => {
    const { editor, view } = mountTestEditor([para('above'), portal(), para('below')])
    registerEditorPlugin(editor, createPortalKeysPlugin(editor), prependPlugin)

    windowIn(view).dispatchEvent(new CustomEvent(PORTAL_SELECT_EVENT, { bubbles: true }))

    expect(view.state.selection).toBeInstanceOf(NodeSelection)
  })

  it('exit moves the caret to the block after the portal, or before it', () => {
    const { editor, view } = mountTestEditor([para('above'), portal(), para('below')])
    registerEditorPlugin(editor, createPortalKeysPlugin(editor), prependPlugin)

    windowIn(view).dispatchEvent(
      new CustomEvent(PORTAL_EXIT_EVENT, { bubbles: true, detail: { direction: 'after' } })
    )
    expect(view.state.selection.$head.parent.textContent).toBe('below')

    windowIn(view).dispatchEvent(
      new CustomEvent(PORTAL_EXIT_EVENT, { bubbles: true, detail: { direction: 'before' } })
    )
    expect(view.state.selection.$head.parent.textContent).toBe('above')
  })

  it('exit after a portal that is the last block opens a line below it', () => {
    const { editor, view } = mountTestEditor([para('above'), portal()])
    registerEditorPlugin(editor, createPortalKeysPlugin(editor), prependPlugin)

    windowIn(view).dispatchEvent(
      new CustomEvent(PORTAL_EXIT_EVENT, { bubbles: true, detail: { direction: 'after' } })
    )

    expect(types(editor)).toEqual(['paragraph', 'codeBlock', 'paragraph'])
    expect(view.state.selection.$head.parent.textContent).toBe('')
  })
})

describe('the keys plugin across a portal remount', () => {
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5))

  it('stays attached when the only portal unmounts and mounts again at once, and detaches when none returns', async () => {
    const { editor, view } = mountTestEditor([para('above'), portal()])
    const attachedNow = (): boolean => portalKeysPluginKey.get(view.state) !== undefined

    const first = renderHook(() => {
      usePortalKeysPlugin(editor)
    })
    expect(attachedNow()).toBe(true)

    first.unmount()
    const second = renderHook(() => {
      usePortalKeysPlugin(editor)
    })
    await tick()
    expect(attachedNow()).toBe(true)

    second.unmount()
    await tick()
    expect(attachedNow()).toBe(false)
  })
})
