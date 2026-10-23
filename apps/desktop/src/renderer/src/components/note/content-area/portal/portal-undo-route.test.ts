/**
 * After a fence edit from the portal's controls, Cmd+Z with the caret still in
 * the window undoes that edit (the host's history), and typing in the window
 * keeps its own undo.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { TextSelection, type Plugin } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { yUndoPluginKey } from 'y-prosemirror'
import { parsePortalDefinition } from '@memry/shared/portal-block'

vi.mock('react-pdf', () => ({
  Document: () => null,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: { workerSrc: '' } }
}))
vi.mock('@/lib/url-metadata', () => ({
  fetchLinkPreview: vi.fn().mockResolvedValue({ domain: '', title: '', favicon: '' })
}))
vi.mock('./portal-api', () => ({
  stampPortalAnchor: vi.fn().mockResolvedValue({ success: true, anchor: 'new111' })
}))

import { registerEditorPlugin } from '../register-editor-plugin'
import { commitPortalPlan, createPortalActions } from './portal-actions'
import { portalBlockText, portalBlockInput } from './portal-definition'
import type { PortalPlan } from './portal-plans'
import type { PortalHandle } from './portal-slots'
import { para, mountTestEditor, unmountTestEditors } from './portal-test-editor'
import { createPortalUndoRoutePlugin } from './portal-undo-route'
import { getPortalWindowState } from './portal-window-plugin'
import { registerPortalWindow } from './portal-window-registry'
import { mountPortalWindow } from './portal-window-test-editor'

const FENCE = { v: 1, note: 'src', blocks: ['chd1'] }

afterEach(unmountTestEditors)

/** Close the host's current undo step, as a pause in typing does. */
function pause(view: EditorView): void {
  const undo = yUndoPluginKey.getState(view.state) as { undoManager: { stopCapturing(): void } }
  undo.undoManager.stopCapturing()
}

function press(view: EditorView, key: string, shiftKey = false): void {
  const event = new KeyboardEvent('keydown', { key, metaKey: true, shiftKey, cancelable: true })
  view.someProp('handleKeyDown', (handle) => handle(view, event))
}

function pressKey(view: EditorView, key: string, init: KeyboardEventInit = {}): void {
  view.dom.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  )
}

function setup() {
  const host = mountTestEditor([para('before')])
  pause(host.view)
  const fenceText = JSON.stringify(FENCE, null, 2)
  host.editor.insertBlocks(
    [portalBlockInput(parsedOf(fenceText))],
    host.editor.document[0],
    'after'
  )
  const portalId = host.editor.document[1].id
  pause(host.view)

  const win = mountPortalWindow(
    [para('Parent ^par1', [para('Child ^chd1')])],
    { kind: 'blocks', note: 'src', blocks: ['chd1'], open: {} },
    // What the window does by itself (placing a new block) writes through the same commit.
    { onPlan: (plan) => commitPortalPlan(read(), plan) }
  )
  registerEditorPlugin(win.editor, createPortalUndoRoutePlugin(), (p: Plugin, ps: Plugin[]) => [
    p,
    ...ps
  ])
  registerPortalWindow(
    { blockId: portalId, instanceId: 'i1' },
    { view: win.view, sourceNoteId: 'src' }
  )

  function read(): PortalHandle {
    const parsed = parsePortalDefinition(fenceOf())
    if (!parsed.ok) throw new Error('fence unreadable')
    return {
      blockId: portalId,
      instanceId: 'i1',
      editor: host.editor as unknown as PortalHandle['editor'],
      definition: parsed.definition,
      sourceNoteId: 'src',
      hostNoteId: undefined
    }
  }
  function fenceOf(): string {
    return portalBlockText(host.editor.getBlock(portalId)?.content)
  }
  return { host, win, read, actions: createPortalActions(read), fenceOf }
}

function caretAtEndOf(view: EditorView, text: string): void {
  view.state.doc.descendants((node, pos) => {
    if (node.isTextblock && node.textContent === text) {
      const at = pos + 1 + text.replace(/ \^[a-z0-9-]+$/, '').length
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)))
    }
  })
}

function parsedOf(text: string) {
  const parsed = parsePortalDefinition(text)
  if (!parsed.ok) throw new Error('bad fence')
  return parsed.definition
}

describe('undo from the portal window', () => {
  it('Cmd+Z after a path-crumb click restores the old fence, Cmd+Shift+Z writes it again', async () => {
    const { win, actions, fenceOf } = setup()
    const before = JSON.parse(fenceOf())
    const parent = getPortalWindowState(win.view)!.ancestors[0]

    expect(await actions.includeParent(parent.blockId)).toBe(true)
    const included = JSON.parse(fenceOf())
    expect(included.blocks).toEqual(['par1'])

    press(win.view, 'z')
    expect(JSON.parse(fenceOf())).toEqual(before)

    press(win.view, 'z', true)
    expect(JSON.parse(fenceOf())).toEqual(included)
  })

  it('leaves Cmd+Z alone once the user types in the window', async () => {
    const { win, actions, fenceOf } = setup()
    const parent = getPortalWindowState(win.view)!.ancestors[0]
    await actions.includeParent(parent.blockId)
    const included = fenceOf()

    win.view.dispatch(win.view.state.tr.insertText('x', win.view.state.doc.content.size - 2))
    press(win.view, 'z')

    expect(fenceOf()).toBe(included)
  })

  it('does not take Cmd+Z from the window after the window placed a new block itself', async () => {
    const { win, fenceOf } = setup()
    caretAtEndOf(win.view, 'Child ^chd1')

    pressKey(win.view, 'Enter')
    win.view.dispatch(win.view.state.tr.insertText('x'))
    await vi.waitFor(() => {
      expect(JSON.parse(fenceOf()).blocks).toEqual(['chd1', 'new111'])
    })
    const placed = fenceOf()

    press(win.view, 'z')

    expect(fenceOf()).toBe(placed)
  })

  it('Cmd+Z undoes the typing in the window after the window wrote the fence by itself', async () => {
    const { win, read, fenceOf } = setup()
    caretAtEndOf(win.view, 'Child ^chd1')
    pause(win.view)
    win.view.dispatch(win.view.state.tr.insertText('x'))
    expect(win.view.state.doc.textContent).toContain('Childx')

    const target = { kind: 'blocks' as const, note: 'src', blocks: ['chd1', 'zzz999'], open: {} }
    const plan: PortalPlan = { definition: { ...read().definition, target }, resolve: () => plan }
    await commitPortalPlan(read(), plan)
    const written = fenceOf()
    expect(JSON.parse(written).blocks).toEqual(['chd1', 'zzz999'])

    pressKey(win.view, 'z', { ctrlKey: true })

    expect(win.view.state.doc.textContent).not.toContain('Childx')
    expect(fenceOf()).toBe(written)
  })
})
