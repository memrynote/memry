import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BlockNoteEditor, type PartialBlock } from '@blocknote/core'
import { TextSelection } from '@tiptap/pm/state'
import {
  blockIdsToCopy,
  buildBlockClipboard,
  copyBlocksFromMenu,
  writeBlockClipboard,
  type BlockClipboardData
} from './block-clipboard'
import { registerBlockSelection } from './marquee-block-registry'
import { handleEditorPaste } from './table-cell-paste'

// Issue #2567: Copy in the block menu. These run against real mounted BlockNote
// editors, because what matters is that the clipboard payload pastes back into
// the editor as the same blocks — a mocked editor would accept anything.
//
// Uses the default BlockNote schema: the custom schema's extra specs drag
// react-pdf into jsdom.

/* eslint-disable @typescript-eslint/no-explicit-any */

// jsdom ships neither, and the copy and paste paths read both.
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

// ProseMirror's `pasteHTML` builds a ClipboardEvent, which jsdom lacks.
beforeEach(() => {
  if ((globalThis as any).ClipboardEvent) return
  class StubClipboardEvent extends Event {
    clipboardData = new FakeDataTransfer()
  }
  ;(globalThis as any).ClipboardEvent = StubClipboardEvent
})

/** jsdom's Blob has no `text()`. */
function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(blob)
  })
}

const SOURCE: PartialBlock[] = [
  { id: 'intro', type: 'paragraph', content: 'Intro' },
  {
    id: 'heading',
    type: 'heading',
    // Block colours and alignment survive only through `blocknote/html`: BlockNote's
    // markdown paste has no syntax for either.
    props: { level: 2, backgroundColor: 'blue', textAlignment: 'center' },
    content: [
      { type: 'text', text: 'Packing ', styles: {} },
      { type: 'text', text: 'list', styles: { bold: true, textColor: 'red' } }
    ]
  },
  {
    id: 'parent',
    type: 'bulletListItem',
    content: 'Clothes',
    children: [{ id: 'child', type: 'bulletListItem', content: 'Socks' }]
  },
  { id: 'image', type: 'image', props: { url: 'https://example.com/cat.png', name: 'cat.png' } },
  { id: 'outro', type: 'paragraph', content: 'Outro' }
]

const mounted: Array<{ editor: BlockNoteEditor; el: HTMLElement }> = []
const unregisters: Array<() => void> = []

afterEach(() => {
  for (const unregister of unregisters.splice(0)) unregister()
  for (const { editor, el } of mounted.splice(0)) {
    editor.unmount()
    el.remove()
  }
  vi.unstubAllGlobals()
})

function mountEditor(initialContent?: PartialBlock[]): BlockNoteEditor {
  const editor = BlockNoteEditor.create({
    pasteHandler: handleEditorPaste,
    ...(initialContent ? { initialContent: initialContent as any } : {})
  })
  const el = document.createElement('div')
  document.body.appendChild(el)
  editor.mount(el)
  mounted.push({ editor, el })
  return editor
}

function selectBlocks(editor: BlockNoteEditor, ids: string[]): void {
  unregisters.push(registerBlockSelection(editor, { getIds: () => ids, clear: vi.fn() }))
}

/** Blocks without ids, so a pasted copy compares equal to its source. */
function withoutIds(blocks: readonly any[]): any[] {
  return blocks.map(({ id: _id, children, ...rest }) => ({
    ...rest,
    children: withoutIds(children ?? [])
  }))
}

/** Paste through the editor's real paste pipeline into its one empty block. */
function pasteInto(editor: BlockNoteEditor, data: BlockClipboardData): void {
  const transfer = new FakeDataTransfer()
  transfer.setData('blocknote/html', data.blocknoteHTML)
  transfer.setData('text/html', data.html)
  transfer.setData('text/plain', data.markdown)

  const view = (editor as any).prosemirrorView
  view.dispatch(view.state.tr.setSelection(TextSelection.atStart(view.state.doc)))
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: transfer })
  view.dom.dispatchEvent(event)
}

async function clipboardFor(editor: BlockNoteEditor, ids: string[]): Promise<BlockClipboardData> {
  const data = await buildBlockClipboard(editor, ids)
  if (!data) throw new Error('nothing was copied')
  return data
}

describe('blockIdsToCopy', () => {
  it('copies the hovered block alone when there is no block selection', () => {
    const editor = mountEditor(SOURCE)

    expect(blockIdsToCopy(editor, 'heading')).toEqual(['heading'])
  })

  it('copies the hovered block alone when it is outside the block selection', () => {
    const editor = mountEditor(SOURCE)
    selectBlocks(editor, ['intro', 'heading'])

    expect(blockIdsToCopy(editor, 'outro')).toEqual(['outro'])
  })

  it('copies the whole selection in document order, dropping children of selected parents', () => {
    const editor = mountEditor(SOURCE)
    selectBlocks(editor, ['image', 'child', 'heading', 'parent'])

    expect(blockIdsToCopy(editor, 'image')).toEqual(['heading', 'parent', 'image'])
  })
})

describe('buildBlockClipboard', () => {
  it('writes one block as the note file holds it, markers and inline formatting included', async () => {
    const editor = mountEditor(SOURCE)

    const data = await clipboardFor(editor, ['heading'])

    expect(data.markdown).toBe(
      [
        '<!-- colors:{"backgroundColor":"blue"} -->',
        '<!-- align:center -->',
        '## Packing <span style="color:red">**list**</span>'
      ].join('\n')
    )
    expect(data.html).toContain('<h2')
    expect(data.html).toContain('list')
  })

  it('writes several blocks in the given order, a parent with its children', async () => {
    const editor = mountEditor(SOURCE)

    const data = await clipboardFor(editor, ['intro', 'parent', 'outro'])

    expect(data.markdown).toBe(['Intro', '', '- Clothes', '  - Socks', '', 'Outro'].join('\n'))
  })

  it('returns null when no id resolves', async () => {
    const editor = mountEditor(SOURCE)

    expect(await buildBlockClipboard(editor, ['missing'])).toBeNull()
  })

  it('pastes one copied block back as the same block', async () => {
    const source = mountEditor(SOURCE)
    const target = mountEditor()

    pasteInto(target, await clipboardFor(source, ['heading']))

    expect(withoutIds(target.document)).toEqual(withoutIds([source.getBlock('heading')]))
  })

  it('pastes a copied selection back as the same blocks, children and images included', async () => {
    const source = mountEditor(SOURCE)
    const target = mountEditor()
    selectBlocks(source, ['image', 'child', 'heading', 'parent'])

    pasteInto(target, await clipboardFor(source, blockIdsToCopy(source, 'parent')))

    expect(withoutIds(target.document)).toEqual(
      withoutIds(['heading', 'parent', 'image'].map((id) => source.getBlock(id)))
    )
  })
})

describe('writeBlockClipboard', () => {
  const data: BlockClipboardData = {
    blocknoteHTML: '<p data-pm-slice="0 0 []">bn</p>',
    html: '<p>html</p>',
    markdown: 'plain'
  }

  let execCommand: ReturnType<typeof vi.fn>

  beforeEach(() => {
    execCommand = vi.fn()
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true })
  })

  it('puts all three flavours on the copy event, ahead of the other copy listeners', async () => {
    const transfer = new FakeDataTransfer()
    transfer.setData('text/plain', 'stale')
    const marqueeListener = vi.fn()
    document.addEventListener('copy', marqueeListener, true)
    execCommand.mockImplementation(() => {
      const event = new Event('copy', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'clipboardData', { value: transfer })
      document.body.dispatchEvent(event)
      return event.defaultPrevented
    })

    try {
      await writeBlockClipboard(data)
    } finally {
      document.removeEventListener('copy', marqueeListener, true)
    }

    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(marqueeListener).not.toHaveBeenCalled()
    expect(transfer.types).toEqual(['blocknote/html', 'text/html', 'text/plain'])
    expect(transfer.getData('blocknote/html')).toBe(data.blocknoteHTML)
    expect(transfer.getData('text/html')).toBe(data.html)
    expect(transfer.getData('text/plain')).toBe(data.markdown)
  })

  it('falls back to the async clipboard with HTML and markdown when no copy event fires', async () => {
    class StubClipboardItem {
      constructor(readonly items: Record<string, Blob>) {}
    }
    const write = vi.fn(async (_items: StubClipboardItem[]) => {})
    vi.stubGlobal('ClipboardItem', StubClipboardItem)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { write } })
    execCommand.mockReturnValue(false)

    await writeBlockClipboard(data)

    expect(write).toHaveBeenCalledTimes(1)
    const { items } = write.mock.calls[0][0][0]
    expect(Object.keys(items)).toEqual(['text/html', 'text/plain'])
    expect(await readBlob(items['text/html'])).toBe(data.html)
    expect(await readBlob(items['text/plain'])).toBe(data.markdown)
  })

  it('surfaces a failed clipboard write to the caller', async () => {
    vi.stubGlobal('ClipboardItem', class {})
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { write: vi.fn(async () => Promise.reject(new Error('denied'))) }
    })
    execCommand.mockReturnValue(false)

    await expect(writeBlockClipboard(data)).rejects.toThrow('denied')
  })
})

describe('copyBlocksFromMenu', () => {
  it('copies nothing for a block that no longer exists', async () => {
    const editor = mountEditor(SOURCE)
    const execCommand = vi.fn()
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true })

    expect(await copyBlocksFromMenu(editor, 'missing')).toBe(false)
    expect(execCommand).not.toHaveBeenCalled()
  })
})
