/**
 * BlockNote's side menu asks which editor is closest to the mouse. Inside a
 * portal window, the host's block group contains the window's, so both are at
 * distance 0 and the innermost one has to win.
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { EditorView } from '@tiptap/pm/view'
import { innermostEditorWins } from './portal-window-side-menu'

const rect = (left: number, top: number, right: number, bottom: number): DOMRect =>
  ({ left, top, right, bottom, width: right - left, height: bottom - top }) as DOMRect

function editorEl(bounds: DOMRect): HTMLElement {
  const editor = document.createElement('div')
  editor.className = 'bn-editor'
  const group = document.createElement('div')
  group.className = 'bn-block-group'
  group.getBoundingClientRect = () => bounds
  editor.append(group)
  return editor
}

afterEach(() => {
  document.body.replaceChildren()
})

type Hit = (c: { clientX: number; clientY: number }) => { element: Element } | null

function mountNested() {
  const host = editorEl(rect(0, 0, 800, 600))
  const nested = editorEl(rect(100, 100, 700, 300))
  host.querySelector('.bn-block-group')!.append(nested)
  document.body.append(host)
  const sideMenu: { findClosestEditorElement: Hit } = {
    findClosestEditorElement: () => ({ element: host })
  }
  innermostEditorWins({ root: document, pluginViews: [sideMenu] } as unknown as EditorView)
  return { host, nested, hit: sideMenu.findClosestEditorElement }
}

describe('side menu hit-test in a portal window', () => {
  it('picks the nested editor when the mouse is over it', () => {
    const { nested, hit } = mountNested()
    expect(hit({ clientX: 300, clientY: 200 })?.element).toBe(nested)
  })

  it('keeps the host when the mouse is in the host but outside the window', () => {
    const { host, hit } = mountNested()
    expect(hit({ clientX: 50, clientY: 500 })?.element).toBe(host)
  })
})
