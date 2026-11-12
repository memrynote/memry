/**
 * A block handle in a portal window dragged out onto the host note moves the
 * portal there. BlockNote's move between editors must not delete the source
 * block from the window, which is the source note.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-pdf', () => ({
  Document: () => null,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: { workerSrc: '' } }
}))
vi.mock('@/lib/url-metadata', () => ({
  fetchLinkPreview: vi.fn().mockResolvedValue({ domain: '', title: '', favicon: '' })
}))

import type { BlockNoteEditor } from '@blocknote/core'
import { SideMenuExtension } from '@blocknote/core/extensions'
import type { EditorView } from '@tiptap/pm/view'
import { mountTestEditor, para, unmountTestEditors } from './portal-test-editor'
import { attachPortalWindowDragOut, moveBlockToDrop } from './portal-window-drag-out'

const detach: Array<() => void> = []
afterEach(() => {
  detach.splice(0).forEach((cleanup) => cleanup())
  unmountTestEditors()
  vi.useRealTimers()
})

const rect = (top: number, bottom: number): DOMRect =>
  ({ left: 0, right: 800, top, bottom, width: 800, height: bottom - top, x: 0, y: top }) as DOMRect

/** jsdom has no layout: give an editor's block group (what the hit-tests measure) a box. */
function placeEditor(view: EditorView, top: number, bottom: number): void {
  view.dom.querySelector<HTMLElement>('.bn-block-group')!.getBoundingClientRect = () =>
    rect(top, bottom)
}

const texts = (editor: BlockNoteEditor): string[] =>
  editor.document.map((block) =>
    Array.isArray(block.content)
      ? block.content.map((run) => ('text' in run ? run.text : '')).join('')
      : block.type
  )

function mount() {
  const host = mountTestEditor([
    { type: 'heading', content: 'Heading A' },
    { id: 'portal', type: 'codeBlock', props: { language: 'memry-portal' }, content: '{}' },
    { type: 'heading', content: 'Heading B' },
    para('Under B')
  ])
  placeEditor(host.view, 0, 400)

  // The window: an editor on the source note, inside the host's portal frame.
  const frame = document.createElement('div')
  frame.className = 'portal-window'
  document.body.append(frame)
  const source = mountTestEditor([para('RNA copies DNA ^rna1')])
  let mountEl: HTMLElement = source.view.dom
  while (mountEl.parentElement !== document.body) mountEl = mountEl.parentElement!
  frame.append(mountEl)
  placeEditor(source.view, 40, 80)
  const handle = document.createElement('div')
  handle.className = 'bn-side-menu'
  frame.append(handle)

  detach.push(
    attachPortalWindowDragOut(frame, (drop) => moveBlockToDrop(host.view, 'portal', drop))
  )
  return { host, source, handle }
}

/** What the browser and BlockNote do for a handle drag from the window to `point`. */
function dragOut(
  source: ReturnType<typeof mountTestEditor>,
  handle: HTMLElement,
  dropOn: HTMLElement,
  point: { clientX: number; clientY: number }
): void {
  const data = new Map<string, string>()
  const dataTransfer = {
    types: [] as string[],
    setData: (type: string, value: string) => {
      data.set(type, value)
      dataTransfer.types = [...data.keys()]
    },
    getData: (type: string) => data.get(type) ?? '',
    clearData: () => data.clear(),
    setDragImage: () => undefined,
    effectAllowed: 'move'
  }
  const fire = (target: HTMLElement, type: string): void => {
    const event = Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
      ...point,
      dataTransfer
    })
    target.dispatchEvent(event)
  }
  source.editor
    .getExtension(SideMenuExtension)!
    .blockDragStart(
      { dataTransfer: dataTransfer as unknown as DataTransfer, clientY: 60 },
      source.editor.document[0]
    )
  fire(handle, 'dragstart')
  fire(dropOn, 'drop')
  fire(handle, 'dragend')
}

describe('dragging a block out of a portal window', () => {
  it('moves the portal under the heading it is dropped at and leaves the source block alone', () => {
    vi.useFakeTimers()
    const { host, source, handle } = mount()
    const [headingA, , headingB, underB] = host.editor.document.map((block) => block.id)
    // The end of "Under B": inside the paragraph, before its three closing tokens.
    const endOfUnderB = host.view.state.doc.content.size - 3
    host.view.posAtCoords = () => ({ pos: endOfUnderB, inside: -1 })

    dragOut(source, handle, host.view.dom, { clientX: 100, clientY: 300 })
    vi.runAllTimers()

    expect(texts(source.editor)).toEqual(['RNA copies DNA ^rna1'])
    expect(host.editor.document.map((block) => block.id)).toEqual([
      headingA,
      headingB,
      underB,
      'portal'
    ])
    expect(host.editor.getBlock('portal')).toMatchObject({
      props: { language: 'memry-portal' },
      content: [{ text: '{}' }]
    })
  })

  it('leaves a drop inside the window to BlockNote', () => {
    vi.useFakeTimers()
    const { host, source, handle } = mount()
    const hostBefore = texts(host.editor)

    dragOut(source, handle, source.view.dom, { clientX: 100, clientY: 60 })
    vi.runAllTimers()

    expect(texts(host.editor)).toEqual(hostBefore)
  })
})
