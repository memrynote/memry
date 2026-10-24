import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BlockNoteEditor } from '@blocknote/core'
import { parsePortalDefinition } from '@memry/shared/portal-block'
import { handleEditorPaste } from '../table-cell-paste'
import { blockDefinition, portalFenceMarkdown } from './portal-insert'

// "Copy as portal" puts a memry-portal fence on the clipboard as plain text;
// pasting it must land as a portal block through the editor's real paste path.

/* oxlint-disable typescript/no-explicit-any */

class FakeDataTransfer {
  private readonly store = new Map<string, string>()
  readonly files: unknown[] = []
  setData(type: string, value: string): void {
    this.store.set(type, value)
  }
  getData(type: string): string {
    return this.store.get(type) ?? ''
  }
  get types(): string[] {
    return [...this.store.keys()]
  }
}

beforeEach(() => {
  if ((globalThis as any).ClipboardEvent) return
  class StubClipboardEvent extends Event {
    clipboardData = new FakeDataTransfer()
  }
  ;(globalThis as any).ClipboardEvent = StubClipboardEvent
})

const mounted: Array<{ editor: BlockNoteEditor; el: HTMLElement }> = []

afterEach(() => {
  for (const { editor, el } of mounted.splice(0)) {
    editor.unmount()
    el.remove()
  }
})

describe('pasting a "Copy as portal" fence', () => {
  it('inserts a memry-portal block with the copied definition', () => {
    const editor = BlockNoteEditor.create({
      pasteHandler: handleEditorPaste,
      initialContent: [{ type: 'paragraph', content: '' }]
    })
    const el = document.createElement('div')
    document.body.appendChild(el)
    editor.mount(el)
    mounted.push({ editor, el })

    const definition = blockDefinition('note-1', 'chl-7f2a')
    const data = new FakeDataTransfer()
    data.setData('text/plain', portalFenceMarkdown(definition))
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: data })
    ;(editor as any).prosemirrorView.dom.dispatchEvent(event)

    const portal = (editor.document as any[]).find(
      (block) => block.type === 'codeBlock' && block.props.language === 'memry-portal'
    )
    expect(portal).toBeDefined()
    const text = portal.content.map((run: { text: string }) => run.text).join('')
    const parsed = parsePortalDefinition(text)
    expect(parsed.ok && parsed.definition.target).toEqual(definition.target)
  })
})
