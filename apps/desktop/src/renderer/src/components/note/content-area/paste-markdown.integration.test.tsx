import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { BlockNoteEditor, type PartialBlock } from '@blocknote/core'
import { BlockNoteView } from '@blocknote/shadcn'
import { cleanup, render } from '@testing-library/react'
import { TextSelection } from '@tiptap/pm/state'

// Markdown pasted as plain text (an answer copied from Claude, a README) has to
// land as the blocks the vault converter builds from the same bytes: callouts,
// `$$` math, toggles, YouTube lines and Mermaid fences, not a quote reading
// `[!note]` and paragraphs reading `$$`. These run a real mounted editor with
// the app's own schema and a real clipboard payload through the paste handler,
// rendered in a BlockNoteView as the app renders it: inserting the app's React
// blocks needs the view's element renderer.

// The file block's PDF preview pulls pdf.js, which touches `DOMMatrix` at
// import time; the real schema imports it. Nothing here renders it.
vi.mock('react-pdf', () => ({
  Document: () => null,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: { workerSrc: '' } }
}))

// A diagram block's view draws its preview through Mermaid, which measures
// text with `SVGElement.getBBox`, and jsdom has none. The block itself is real.
vi.mock('mermaid', () => ({
  default: {
    initialize: () => undefined,
    parse: () => Promise.resolve(true),
    render: () => Promise.resolve({ svg: '<svg/>' })
  }
}))

// Nothing here asserts on UI; the block views' async state updates would
// otherwise each warn about act() (see roundtrip-conformance.test.ts).
beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false
})

import { editorSchema } from './editor-schema'
import { parseMarkdownPreservingBlanks } from './markdown-utils'
import { handleEditorPaste } from './table-cell-paste'

/* oxlint-disable typescript/no-explicit-any */

// jsdom ships neither, and BlockNote's paste path constructs both.
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

afterEach(() => {
  cleanup()
})

function mountEditor(
  initialContent: PartialBlock<any, any, any>[]
): BlockNoteEditor<any, any, any> {
  const editor = BlockNoteEditor.create({
    schema: editorSchema,
    pasteHandler: handleEditorPaste,
    initialContent
  } as never) as BlockNoteEditor<any, any, any>
  render(<BlockNoteView editor={editor} />)
  return editor
}

function view(editor: BlockNoteEditor<any, any, any>): any {
  return (editor as any).prosemirrorView
}

/** Puts the caret `offset` characters into the first text node reading `needle`. */
function placeCaretIn(editor: BlockNoteEditor<any, any, any>, needle: string, offset: number) {
  let at: number | null = null
  view(editor).state.doc.descendants((node: any, pos: number) => {
    if (at === null && node.isText && node.text === needle) at = pos + offset
  })
  if (at === null) throw new Error(`no text node reads "${needle}"`)
  const v = view(editor)
  v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, at)))
}

function paste(editor: BlockNoteEditor<any, any, any>, clipboard: Record<string, string>): void {
  const data = new FakeDataTransfer()
  for (const [type, value] of Object.entries(clipboard)) data.setData(type, value)
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: data })
  view(editor).dom.dispatchEvent(event)
}

function text(block: any): string {
  if (!Array.isArray(block?.content)) return ''
  return block.content.map((inline: any) => inline.text ?? '').join('')
}

/** `[type, text]` per top-level block, with the props a reader would check. */
function outline(blocks: any[]): Array<[string, string]> {
  return blocks.map((block) => {
    if (block.type === 'callout') return [block.type, `${block.props.type}: ${text(block)}`]
    if (block.type === 'mathBlock') return [block.type, block.props.latex]
    if (block.type === 'youtubeEmbed') return [block.type, block.props.videoId]
    if (block.type === 'image') return [block.type, block.props.url]
    if (block.type === 'toggleListItem') {
      return [block.type, `${text(block)} > ${block.children.map(text).join(' | ')}`]
    }
    return [block.type, text(block)]
  })
}

/** Waits for the paste to land: parsing the markdown is asynchronous. */
async function settled(editor: BlockNoteEditor<any, any, any>, before: string): Promise<void> {
  await vi.waitFor(
    () => {
      expect(JSON.stringify(editor.document)).not.toBe(before)
    },
    { timeout: 5000 }
  )
}

const CLAUDE_ANSWER = [
  '## Plan',
  '',
  'Intro with **bold** text.',
  '',
  '| Name | Value |',
  '| --- | --- |',
  '| alpha | 1 |',
  '',
  '> [!note]',
  '> A callout body line.',
  '',
  '$$',
  'E = mc^2',
  '$$',
  '',
  '<details data-memry-toggle>',
  '<summary>Toggle summary</summary>',
  '',
  'Hidden toggle body.',
  '',
  '</details>',
  '',
  '![A cat](https://example.com/cat.png)',
  '',
  '![](https://www.youtube.com/watch?v=dQw4w9WgXcQ)',
  '',
  '```mermaid',
  'graph TD',
  '    A[Start] --> B[End]',
  '```',
  '',
  '- list one',
  '- list two'
].join('\n')

describe('pasting markdown as plain text', () => {
  it('builds the blocks the vault converter builds from the same markdown', async () => {
    const editor = mountEditor([{ type: 'paragraph' }])
    const before = JSON.stringify(editor.document)

    paste(editor, { 'text/plain': CLAUDE_ANSWER })
    await settled(editor, before)

    const converted = await parseMarkdownPreservingBlanks(editor, CLAUDE_ANSWER)
    expect(outline(editor.document)).toEqual(outline(converted))
    expect(outline(editor.document)).toEqual([
      ['heading', 'Plan'],
      ['paragraph', 'Intro with bold text.'],
      ['table', ''],
      ['callout', 'note: A callout body line.'],
      ['mathBlock', 'E = mc^2'],
      ['toggleListItem', 'Toggle summary > Hidden toggle body.'],
      ['image', 'https://example.com/cat.png'],
      ['youtubeEmbed', 'dQw4w9WgXcQ'],
      ['diagram', 'graph TD\n    A[Start] --> B[End]'],
      ['bulletListItem', 'list one'],
      ['bulletListItem', 'list two']
    ])
  })

  it('reads Windows line endings the same way', async () => {
    const editor = mountEditor([{ type: 'paragraph' }])
    const before = JSON.stringify(editor.document)

    paste(editor, { 'text/plain': '> [!tip]\r\n> Keep it short.\r\n\r\n$$\r\nx^2\r\n$$\r\n' })
    await settled(editor, before)

    expect(outline(editor.document)).toEqual([
      ['callout', 'tip: Keep it short.'],
      ['mathBlock', 'x^2']
    ])
  })

  it('splits the paragraph holding the caret around the pasted blocks', async () => {
    const editor = mountEditor([{ type: 'paragraph', content: 'before after' }])
    placeCaretIn(editor, 'before after', 'before '.length)
    const before = JSON.stringify(editor.document)

    paste(editor, { 'text/plain': '> [!warning]\n> Mind the gap.\n\nend' })
    await settled(editor, before)

    expect(outline(editor.document)).toEqual([
      ['paragraph', 'before '],
      ['callout', 'warning: Mind the gap.'],
      ['paragraph', 'end'],
      ['paragraph', 'after']
    ])
  })

  it('puts a block pasted at the end of a paragraph after it', async () => {
    const editor = mountEditor([{ type: 'paragraph', content: 'first' }])
    placeCaretIn(editor, 'first', 'first'.length)
    const before = JSON.stringify(editor.document)

    paste(editor, { 'text/plain': '$$\nx^2\n$$\n\nlast' })
    await settled(editor, before)

    expect(outline(editor.document)).toEqual([
      ['paragraph', 'first'],
      ['mathBlock', 'x^2'],
      ['paragraph', 'last']
    ])
  })

  it('joins a leading paragraph to the text before the caret', async () => {
    const editor = mountEditor([{ type: 'paragraph', content: 'before after' }])
    placeCaretIn(editor, 'before after', 'before '.length)
    const before = JSON.stringify(editor.document)

    paste(editor, { 'text/plain': 'intro\n\n> [!tip]\n> Body.' })
    await settled(editor, before)

    expect(outline(editor.document)).toEqual([
      ['paragraph', 'before intro'],
      ['callout', 'tip: Body.'],
      ['paragraph', 'after']
    ])
  })

  it('keeps a pasted sentence inline in the paragraph holding the caret', async () => {
    const editor = mountEditor([{ type: 'paragraph', content: 'before  after' }])
    placeCaretIn(editor, 'before  after', 'before '.length)
    const before = JSON.stringify(editor.document)

    paste(editor, { 'text/plain': 'a **bold** word' })
    await settled(editor, before)

    expect(outline(editor.document)).toEqual([['paragraph', 'before a bold word after']])
  })

  it('takes back the whole paste in one undo step', async () => {
    const editor = mountEditor([{ type: 'paragraph', content: 'keep me' }])
    placeCaretIn(editor, 'keep me', 'keep me'.length)
    const before = JSON.stringify(editor.document)

    paste(editor, { 'text/plain': CLAUDE_ANSWER })
    await settled(editor, before)

    editor.undo()
    expect(outline(editor.document)).toEqual([['paragraph', 'keep me']])
  })

  it('keeps markdown literal inside a code block', async () => {
    const editor = mountEditor([{ type: 'codeBlock', content: 'x' } as any])
    placeCaretIn(editor, 'x', 1)
    const before = JSON.stringify(editor.document)

    paste(editor, { 'text/plain': '\n> [!note]\n> body' })
    await settled(editor, before)

    expect(outline(editor.document)).toEqual([['codeBlock', 'x\n> [!note]\n> body']])
  })

  it('keeps the HTML of a web page whose plain text is not markdown', async () => {
    const editor = mountEditor([{ type: 'paragraph' }])
    const before = JSON.stringify(editor.document)

    paste(editor, {
      'text/html': '<h3>Release notes</h3><p>Shipped today</p>',
      'text/plain': 'Release notes\nShipped today'
    })
    await settled(editor, before)

    expect(outline(editor.document).slice(0, 2)).toEqual([
      ['heading', 'Release notes'],
      ['paragraph', 'Shipped today']
    ])
  })
})
