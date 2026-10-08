import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BlockNoteEditor,
  BlockNoteSchema,
  defaultBlockSpecs,
  defaultInlineContentSpecs
} from '@blocknote/core'
import { TextSelection } from '@tiptap/pm/state'
import { buildBlockClipboard } from './block-clipboard'
import { HtmlComment } from './html-comment'
import { checkboxLineMarkdown } from './markdown-utils'

/* eslint-disable @typescript-eslint/no-explicit-any */

const COMMENT = '<!-- [[Alpha]] -->'

const schema = BlockNoteSchema.create({
  blockSpecs: defaultBlockSpecs,
  inlineContentSpecs: { ...defaultInlineContentSpecs, htmlComment: HtmlComment }
})

const paragraph = {
  id: 'line',
  type: 'paragraph',
  content: [
    { type: 'text', text: 'Line ', styles: {} },
    { type: 'htmlComment', props: { source: COMMENT } },
    { type: 'text', text: ' end.', styles: {} }
  ]
}

class FakeDataTransfer {
  private readonly store = new Map<string, string>()
  readonly files: unknown[] = []

  clearData(): void {
    this.store.clear()
  }

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

// ProseMirror's paste path builds a ClipboardEvent, which jsdom lacks.
beforeEach(() => {
  if ((globalThis as any).ClipboardEvent) return
  class StubClipboardEvent extends Event {
    clipboardData = new FakeDataTransfer()
  }
  ;(globalThis as any).ClipboardEvent = StubClipboardEvent
})

const mounted: Array<{ editor: BlockNoteEditor<any, any, any>; el: HTMLElement }> = []

afterEach(() => {
  for (const { editor, el } of mounted.splice(0)) {
    editor.unmount()
    el.remove()
  }
})

function mountEditor(initialContent?: unknown[]): BlockNoteEditor<any, any, any> {
  const editor = BlockNoteEditor.create({
    schema,
    ...(initialContent ? { initialContent: initialContent as any } : {})
  })
  const el = document.createElement('div')
  document.body.appendChild(el)
  editor.mount(el)
  mounted.push({ editor, el })
  return editor
}

function dispatchClipboard(
  editor: BlockNoteEditor<any, any, any>,
  type: 'copy' | 'paste',
  transfer: FakeDataTransfer
): void {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: transfer })
  ;(editor as any).prosemirrorView.dom.dispatchEvent(event)
}

function pasteInto(editor: BlockNoteEditor<any, any, any>, transfer: FakeDataTransfer): void {
  const view = (editor as any).prosemirrorView
  view.dispatch(view.state.tr.setSelection(TextSelection.atStart(view.state.doc)))
  dispatchClipboard(editor, 'paste', transfer)
}

function commentSources(editor: BlockNoteEditor<any, any, any>): string[] {
  return editor.document.flatMap((block: any) =>
    (block.content ?? [])
      .filter((run: any) => run.type === 'htmlComment')
      .map((run: any) => run.props.source)
  )
}

describe('copying a paragraph that holds an HTML comment', () => {
  it('puts no token on the block menu copy and pastes the comment back', async () => {
    const source = mountEditor([paragraph])
    const target = mountEditor()

    const data = await buildBlockClipboard(source, ['line'])
    if (!data) throw new Error('nothing was copied')

    expect(data.html).not.toContain('MEMRYCMT')
    expect(data.html).toContain('Line ')
    expect(data.markdown).toBe(`Line ${COMMENT} end.`)

    const transfer = new FakeDataTransfer()
    transfer.setData('blocknote/html', data.blocknoteHTML)
    transfer.setData('text/html', data.html)
    transfer.setData('text/plain', data.markdown)
    pasteInto(target, transfer)

    expect(commentSources(target)).toEqual([COMMENT])
  })

  it('puts no token on a text selection copy and pastes the comment back', () => {
    const source = mountEditor([paragraph])
    const target = mountEditor()
    const view = (source as any).prosemirrorView
    const start = TextSelection.atStart(view.state.doc).from
    const end = start + 'Line '.length + 1 + ' end.'.length
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, start, end)))

    const transfer = new FakeDataTransfer()
    dispatchClipboard(source, 'copy', transfer)

    expect(transfer.getData('text/html')).toContain('Line ')
    expect(transfer.getData('text/html')).not.toContain('MEMRYCMT')
    expect(transfer.getData('text/plain')).toBe('Line  end.\n')

    pasteInto(target, transfer)

    expect(commentSources(target)).toEqual([COMMENT])
  })

  it('keeps the comment in the line a checkbox turned into a task writes', () => {
    const editor = mountEditor([paragraph])

    expect(checkboxLineMarkdown(editor, paragraph)).toBe(`Line ${COMMENT} end.`)
  })
})
