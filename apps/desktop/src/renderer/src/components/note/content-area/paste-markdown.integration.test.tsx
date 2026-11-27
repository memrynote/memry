import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { BlockNoteEditor, type PartialBlock } from '@blocknote/core'
import { BlockNoteView } from '@blocknote/shadcn'
import { cleanup, render } from '@testing-library/react'
import { NodeSelection, TextSelection } from '@tiptap/pm/state'
import * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'

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

import { withCollaborationIfLive } from './collaboration-options'
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
  initialContent: PartialBlock<any, any, any>[],
  resolveNotePath?: () => Promise<string | undefined>
): BlockNoteEditor<any, any, any> {
  const editor = BlockNoteEditor.create({
    schema: editorSchema,
    pasteHandler: (context: Parameters<typeof handleEditorPaste>[0]) =>
      handleEditorPaste({ ...context, resolveNotePath }),
    initialContent
  } as never) as BlockNoteEditor<any, any, any>
  render(<BlockNoteView editor={editor} />)
  return editor
}

/** An editor bound to `doc`, as the app mounts a note with a live Y.Doc. */
function mountCollaborativeEditor(
  doc: Y.Doc,
  initialContent: PartialBlock<any, any, any>[],
  resolveNotePath: () => Promise<string | undefined>
): BlockNoteEditor<any, any, any> {
  const editor = BlockNoteEditor.create(
    withCollaborationIfLive(doc.getXmlFragment(CRDT_FRAGMENT_NAME), {
      schema: editorSchema,
      pasteHandler: (context: Parameters<typeof handleEditorPaste>[0]) =>
        handleEditorPaste({ ...context, resolveNotePath })
    } as never)
  ) as BlockNoteEditor<any, any, any>
  render(<BlockNoteView editor={editor} />)
  editor.replaceBlocks(editor.document, initialContent)
  return editor
}

/** Appends `suffix` to the text reading `needle` in a peer's copy of `doc`, and syncs it back. */
function peerAppends(doc: Y.Doc, needle: string, suffix: string): void {
  const peer = new Y.Doc()
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc))
  const visit = (node: Y.XmlFragment | Y.XmlElement | Y.XmlText): boolean => {
    if (node instanceof Y.XmlText) {
      if (node.toString() !== needle) return false
      node.insert(needle.length, suffix)
      return true
    }
    return node.toArray().some((child) => visit(child as Y.XmlElement | Y.XmlText))
  }
  if (!visit(peer.getXmlFragment(CRDT_FRAGMENT_NAME))) throw new Error(`no text reads "${needle}"`)
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, Y.encodeStateVector(doc)))
  peer.destroy()
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

/** Selects the block of `type`, as clicking an image does. */
function selectBlockContent(editor: BlockNoteEditor<any, any, any>, type: string): void {
  const v = view(editor)
  let at: number | null = null
  v.state.doc.descendants((node: any, pos: number) => {
    if (at === null && node.type.name === type) at = pos
    return at === null
  })
  if (at === null) throw new Error(`no ${type} block`)
  v.dispatch(v.state.tr.setSelection(NodeSelection.create(v.state.doc, at)))
}

/** Every block with its children, nested as the editor nests them. */
function tree(blocks: any[]): unknown[] {
  return outline(blocks).map(([type, label], index) => {
    const children = blocks[index].children ?? []
    const node = `${type}: ${label}`
    return children.length > 0 && type !== 'toggleListItem' ? [node, tree(children)] : node
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

  it('builds an equation below a paragraph and a blank line', async () => {
    const editor = mountEditor([{ type: 'paragraph' }])
    const before = JSON.stringify(editor.document)

    paste(editor, { 'text/plain': 'one\n\n$$\nx\n$$' })
    await settled(editor, before)

    expect(outline(editor.document)).toEqual([
      ['paragraph', 'one'],
      ['mathBlock', 'x']
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
    // The split copies the block's id onto its second half; a duplicate id
    // breaks every block lookup in the editor.
    const ids = editor.document.map((block) => block.id)
    expect(new Set(ids).size).toBe(ids.length)
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

describe('pasting markdown around existing blocks', () => {
  it('keeps the children of the block holding the caret when a callout ends the paste', async () => {
    const editor = mountEditor([
      {
        type: 'bulletListItem',
        content: 'parent',
        children: [{ type: 'bulletListItem', content: 'child' }]
      },
      { type: 'paragraph', content: 'after' }
    ])
    placeCaretIn(editor, 'parent', 'parent'.length)
    const before = JSON.stringify(editor.document)

    paste(editor, { 'text/plain': 'x\n\n> [!tip]\n> B' })
    await settled(editor, before)

    // BlockNote's own paste does the same with a quote: the children follow
    // the end of their block into the last pasted block, and no empty block
    // is left to hold them.
    expect(tree(editor.document)).toEqual([
      'bulletListItem: parentx',
      ['callout: tip: B', ['bulletListItem: child']],
      'paragraph: after'
    ])
  })

  it('keeps a toggle body when a callout ends the paste', async () => {
    const editor = mountEditor([
      { type: 'toggleListItem', content: 'tog', children: [{ type: 'paragraph', content: 'body' }] }
    ] as any)
    placeCaretIn(editor, 'tog', 'tog'.length)
    const before = JSON.stringify(editor.document)

    paste(editor, { 'text/plain': 'x\n\n> [!tip]\n> B' })
    await settled(editor, before)

    expect(tree(editor.document)).toEqual([
      'toggleListItem: togx > ',
      ['callout: tip: B', ['paragraph: body']]
    ])
  })

  it('replaces a selected image with the pasted blocks', async () => {
    const editor = mountEditor([
      { type: 'paragraph', content: 'one' },
      { type: 'image', props: { url: 'https://example.com/a.png' } },
      { type: 'paragraph', content: 'two' }
    ])
    selectBlockContent(editor, 'image')
    const before = JSON.stringify(editor.document)

    paste(editor, { 'text/plain': 'hello\n\nworld' })
    await settled(editor, before)

    expect(outline(editor.document)).toEqual([
      ['paragraph', 'one'],
      ['paragraph', 'hello'],
      ['paragraph', 'world'],
      ['paragraph', 'two']
    ])
  })

  it('keeps a column list whole when column markdown is pasted into a column', async () => {
    const editor = mountEditor([
      {
        type: 'columnList',
        children: [
          { type: 'column', children: [{ type: 'paragraph', content: 'left' }] },
          { type: 'column', children: [{ type: 'paragraph', content: 'right' }] }
        ]
      }
    ] as any)
    placeCaretIn(editor, 'left', 'left'.length)
    const before = JSON.stringify(editor.document)

    paste(editor, {
      'text/plain':
        '--- start-multi-column: r1\nA\n\n--- end-column ---\n\nB\n\n--- end-multi-column'
    })
    await settled(editor, before)

    // A column cannot hold a column list, so the pasted columns' blocks land
    // in the column holding the caret, in reading order, the first joining
    // the text before the caret as any pasted paragraph does.
    const [columns] = editor.document as any[]
    expect(editor.document).toHaveLength(1)
    expect(columns.children.map((column: any) => outline(column.children))).toEqual([
      [
        ['paragraph', 'leftA'],
        ['paragraph', 'B']
      ],
      [['paragraph', 'right']]
    ])
  })
})

describe('pasting markdown while the editor changes', () => {
  const PASTES = ['> [!tip]\n> one', 'two', '$$\nx^2\n$$\n\nthree']

  async function pasteEachAfterTheLast(editor: BlockNoteEditor<any, any, any>): Promise<void> {
    for (const markdown of PASTES) {
      const before = JSON.stringify(editor.document)
      paste(editor, { 'text/plain': markdown })
      await settled(editor, before)
    }
  }

  it('lands pastes made in quick succession as if each waited for the last', async () => {
    const slow = mountEditor([{ type: 'paragraph' }])
    await pasteEachAfterTheLast(slow)
    const fast = mountEditor([{ type: 'paragraph' }])

    for (const markdown of PASTES) paste(fast, { 'text/plain': markdown })

    await vi.waitFor(() => expect(tree(fast.document)).toEqual(tree(slow.document)), {
      timeout: 5000
    })
  })

  it('pastes where the caret was when the paste was made', async () => {
    const editor = mountEditor([
      { type: 'paragraph', content: 'aaa' },
      { type: 'paragraph', content: 'bbb' }
    ])
    placeCaretIn(editor, 'aaa', 'aaa'.length)
    const before = JSON.stringify(editor.document)

    paste(editor, { 'text/plain': 'PASTED' })
    placeCaretIn(editor, 'bbb', 0)
    await settled(editor, before)

    expect(outline(editor.document)).toEqual([
      ['paragraph', 'aaaPASTED'],
      ['paragraph', 'bbb']
    ])
  })

  it('drops a paste whose editor closed before it was parsed', async () => {
    const editor = mountEditor([{ type: 'paragraph', content: 'kept' }])
    const before = JSON.stringify(editor.document)

    paste(editor, { 'text/plain': '> [!tip]\n> late' })
    cleanup()
    await new Promise((resolve) => setTimeout(resolve, 500))

    expect(JSON.stringify(editor.document)).toBe(before)
  })

  it('pastes where the caret was when a synced edit arrives before the paste is parsed', async () => {
    const doc = new Y.Doc()
    let finishParse: ((notePath: string | undefined) => void) | undefined
    const editor = mountCollaborativeEditor(
      doc,
      [
        { type: 'paragraph', content: 'aaa' },
        { type: 'paragraph', content: 'bbb' },
        { type: 'paragraph', content: 'ccc' }
      ],
      () => new Promise((resolve) => (finishParse = resolve))
    )
    placeCaretIn(editor, 'aaa', 'aaa'.length)

    paste(editor, { 'text/plain': '> [!tip]\n> PASTED' })
    await vi.waitFor(() => expect(finishParse).toBeDefined())
    peerAppends(doc, 'ccc', '-remote')
    expect(outline(editor.document).at(-1)).toEqual(['paragraph', 'ccc-remote'])
    finishParse?.(undefined)

    await vi.waitFor(
      () =>
        expect(outline(editor.document)).toEqual([
          ['paragraph', 'aaa'],
          ['callout', 'tip: PASTED'],
          ['paragraph', 'bbb'],
          ['paragraph', 'ccc-remote']
        ]),
      { timeout: 5000 }
    )
    doc.destroy()
  })

  it('lands later pastes when parsing an earlier one never finishes', async () => {
    let lookups = 0
    const editor = mountEditor([{ type: 'paragraph' }], () =>
      lookups++ === 0 ? new Promise(() => undefined) : Promise.resolve(undefined)
    )
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      paste(editor, { 'text/plain': 'first' })
      paste(editor, { 'text/plain': '> [!tip]\n> second' })
      await vi.advanceTimersByTimeAsync(60_000)
    } finally {
      vi.useRealTimers()
    }

    // The stuck paste falls back to BlockNote's parser where it was made, and
    // the one after it still goes through the note parser.
    await vi.waitFor(
      () =>
        expect(outline(editor.document)).toEqual([
          ['paragraph', 'first'],
          ['callout', 'tip: second']
        ]),
      { timeout: 5000 }
    )
  })

  it('settles a failed paste without an unhandled rejection', async () => {
    const rejections: unknown[] = []
    const onRejection = (reason: unknown): void => {
      rejections.push(reason)
    }
    process.on('unhandledRejection', onRejection)
    try {
      const editor = mountEditor([{ type: 'paragraph' }], () =>
        Promise.reject(new Error('note lookup failed'))
      )

      paste(editor, { 'text/plain': '> [!tip]\n> body' })
      cleanup()
      await new Promise((resolve) => setTimeout(resolve, 500))

      expect(rejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  })
})
