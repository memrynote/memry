/* eslint-disable @typescript-eslint/no-explicit-any */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { BlockNoteEditor } from '@blocknote/core'
import { NodeSelection } from '@tiptap/pm/state'

vi.mock('react-pdf', () => ({
  Document: () => null,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: { workerSrc: '' } }
}))

vi.mock('@/lib/url-metadata', () => ({
  fetchLinkPreview: vi.fn().mockResolvedValue({ domain: '', title: '', favicon: '' }),
  extractDomain: (url: string) => url
}))

vi.mock('@/services/tasks-service', () => ({
  tasksService: { update: vi.fn(), listProjects: vi.fn(), create: vi.fn() }
}))

vi.mock('@/services/notes-service', () => ({
  notesService: { getTags: vi.fn() }
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() })
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key.split('.').at(-1) ?? key })
}))

import { tasksService } from '@/services/tasks-service'
import { notesService } from '@/services/notes-service'
import { editorSchema } from './editor-schema'
import { registerEditorPlugin } from './register-editor-plugin'
import { createDateMentionGhostPlugin } from './date-mention-ghost-plugin'
import { analyzeTaskIntents } from './scan-task-intents'
import { indentTaskBlock, outdentTaskBlock } from './hooks/task-block-marquee-indent'
import { MentionMenu, type MentionSuggestionItem } from './mention-menu'
import { TagSuggestionPopover } from './tag-suggestion-popover'
import {
  createMultiBlockIndentPlugin,
  indentBlocks,
  outdentBlocks,
  selectedBlockIds
} from './multi-block-indent-plugin'

const mounted: Array<{ editor: BlockNoteEditor; el: HTMLElement }> = []

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  for (const { editor, el } of mounted.splice(0)) {
    ;(editor as any).mount(undefined)
    el.remove()
  }
})

beforeEach(() => {
  vi.mocked(tasksService.update).mockReset()
  vi.mocked(tasksService.update).mockResolvedValue({ success: true } as never)
  vi.mocked(notesService.getTags).mockResolvedValue([
    { tag: 'work', color: 'blue', count: 4 }
  ] as never)
})

function mountEditor(blocks: unknown[], useAppSchema = false): BlockNoteEditor {
  const editor = useAppSchema
    ? (BlockNoteEditor.create({ schema: editorSchema } as never) as unknown as BlockNoteEditor)
    : BlockNoteEditor.create()
  const el = document.createElement('div')
  document.body.appendChild(el)
  editor.mount(el)
  mounted.push({ editor, el })
  editor.replaceBlocks(editor.document, blocks as never)
  return editor
}

function paragraphs(labels: string[]): unknown[] {
  return labels.map((label) => ({ id: label, type: 'paragraph', content: label }))
}

function tiptap(editor: BlockNoteEditor): any {
  return (editor as any)._tiptapEditor
}

function containerPos(doc: any, id: string): number {
  let found = -1
  doc.descendants((node: any, pos: number) => {
    if (found !== -1) return false
    if (node.type.name === 'blockContainer' && node.attrs?.id === id) {
      found = pos
      return false
    }
    return true
  })
  if (found === -1) throw new Error(`no block container for ${id}`)
  return found
}

function outline(blocks: any[]): string[] {
  return blocks.map((block) => {
    const label =
      block.type === 'taskBlock'
        ? `#${block.props.taskId}`
        : (block.content ?? []).map((c: any) => c.text ?? '').join('')
    const children = outline(block.children ?? [])
    return children.length > 0 ? `${label}(${children.join(' ')})` : label
  })
}

/** The document without the empty paragraph BlockNote keeps after the last block. */
function topBlocks(editor: BlockNoteEditor): any[] {
  const blocks = [...(editor.document as any[])]
  const last = blocks.at(-1)
  if (blocks.length > 1 && last?.type === 'paragraph' && (last.content ?? []).length === 0) {
    blocks.pop()
  }
  return blocks
}

function topOutline(editor: BlockNoteEditor): string[] {
  return outline(topBlocks(editor))
}

function shapeOf(blocks: any[]): unknown[] {
  return blocks.map((block) => ({
    id: block.id,
    type: block.type,
    parentTaskId: block.props?.parentTaskId,
    children: shapeOf(block.children ?? [])
  }))
}

function registerPlugin(editor: BlockNoteEditor): void {
  registerEditorPlugin(editor, createMultiBlockIndentPlugin(editor), (p, plugins) => [
    p,
    ...plugins
  ])
}

function selectAcross(editor: BlockNoteEditor, fromId: string, toId: string): void {
  const tt = tiptap(editor)
  tt.commands.setTextSelection({
    from: containerPos(tt.state.doc, fromId) + 3,
    to: containerPos(tt.state.doc, toId) + 3
  })
}

// A real keydown on the view, the path the app takes. tiptap's
// `keyboardShortcut` command replays captured steps onto its own transaction
// and loses every sink after the first.
function pressTab(editor: BlockNoteEditor, shift = false): KeyboardEvent {
  const event = tabEvent({ shiftKey: shift })
  tiptap(editor).view.dom.dispatchEvent(event)
  return event
}

function countTransactions(editor: BlockNoteEditor): () => number {
  let count = 0
  tiptap(editor).on('transaction', () => {
    count += 1
  })
  return () => count
}

function pluginOf(editor: BlockNoteEditor): any {
  return createMultiBlockIndentPlugin(editor)
}

function tabEvent(init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true, ...init })
}

describe('Tab over a multi-block selection', () => {
  it('nests every selected block, unnests them again, in one undoable transaction', () => {
    const editor = mountEditor(paragraphs(['A', 'B', 'C', 'D']))
    registerPlugin(editor)
    expect(topOutline(editor)).toEqual(['A', 'B', 'C', 'D'])

    selectAcross(editor, 'B', 'C')
    expect(selectedBlockIds(editor)).toEqual(['B', 'C'])

    const transactions = countTransactions(editor)
    const tab = pressTab(editor)

    expect(topOutline(editor)).toEqual(['A(B C)', 'D'])
    expect(transactions()).toBe(1)
    expect(tab.defaultPrevented).toBe(true)
    expect(selectedBlockIds(editor)).toEqual(['B', 'C'])

    editor.undo()
    expect(topOutline(editor)).toEqual(['A', 'B', 'C', 'D'])

    selectAcross(editor, 'B', 'C')
    pressTab(editor)
    expect(topOutline(editor)).toEqual(['A(B C)', 'D'])

    // History groups edits closer than its group delay into one undo step.
    // Move the clock so the outdent below gets its own step.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 5_000)
    const before = transactions()
    pressTab(editor, true)

    expect(topOutline(editor)).toEqual(['A', 'B', 'C', 'D'])
    expect(transactions() - before).toBe(1)

    editor.undo()
    expect(topOutline(editor)).toEqual(['A(B C)', 'D'])
  })

  it('skips a block that cannot nest and keeps going', () => {
    const editor = mountEditor(paragraphs(['A', 'B', 'C']))
    registerPlugin(editor)

    selectAcross(editor, 'A', 'B')
    expect(() => pressTab(editor)).not.toThrow()

    expect(topOutline(editor)).toEqual(['A(B)', 'C'])
  })

  it('leaves a single-block selection to BlockNote', () => {
    const editor = mountEditor(paragraphs(['A', 'B']))
    const plugin = pluginOf(editor)
    registerPlugin(editor)

    const tt = tiptap(editor)
    tt.commands.setTextSelection(containerPos(tt.state.doc, 'B') + 3)
    expect(selectedBlockIds(editor)).toEqual([])
    expect(plugin.props.handleKeyDown(tt.view, tabEvent())).toBe(false)

    pressTab(editor)
    expect(topOutline(editor)).toEqual(['A(B)'])
  })

  it('ignores Tab with a modifier held', () => {
    const editor = mountEditor(paragraphs(['A', 'B', 'C']))
    const plugin = pluginOf(editor)
    registerPlugin(editor)
    selectAcross(editor, 'B', 'C')

    const tt = tiptap(editor)
    for (const modifier of ['metaKey', 'ctrlKey', 'altKey'] as const) {
      expect(plugin.props.handleKeyDown(tt.view, tabEvent({ [modifier]: true }))).toBe(false)
    }

    expect(topOutline(editor)).toEqual(['A', 'B', 'C'])
  })
})

describe('mixed paragraph and task blocks', () => {
  const blocks = (): unknown[] => [
    { id: 'T0', type: 'taskBlock', props: { taskId: 't0', title: 'Parent' } },
    { id: 'P', type: 'paragraph', content: 'P' },
    { id: 'T1', type: 'taskBlock', props: { taskId: 't1', title: 'One' } },
    { id: 'T2', type: 'taskBlock', props: { taskId: 't2', title: 'Two' } }
  ]

  function byHand(editor: BlockNoteEditor, ids: string[], direction: 'indent' | 'outdent'): void {
    for (const id of direction === 'indent' ? ids : [...ids].reverse()) {
      if ((editor as any).getBlock(id)?.type === 'taskBlock') {
        if (direction === 'indent') indentTaskBlock(editor, id)
        else outdentTaskBlock(editor, id)
        continue
      }
      const tt = tiptap(editor)
      const pos = containerPos(tt.state.doc, id)
      tt.view.dispatch(tt.state.tr.setSelection(NodeSelection.create(tt.state.doc, pos)))
      if (direction === 'indent') {
        if ((editor as any).canNestBlock()) (editor as any).nestBlock()
      } else if ((editor as any).canUnnestBlock()) {
        ;(editor as any).unnestBlock()
      }
    }
  }

  it('indents the paragraph and re-parents every task in one batch', () => {
    const editor = mountEditor(blocks(), true)
    indentBlocks(editor, ['P', 'T1', 'T2'])

    expect(topOutline(editor)).toEqual(['#t0(P #t1 #t2)'])
    const nested = (editor.document[0] as any).children
    expect(nested[1].props.parentTaskId).toBe('t0')
    expect(nested[2].props.parentTaskId).toBe('t0')
    expect(vi.mocked(tasksService.update).mock.calls.map(([arg]) => arg)).toEqual([
      { id: 't1', parentId: 't0' },
      { id: 't2', parentId: 't0' }
    ])

    const hand = mountEditor(blocks(), true)
    byHand(hand, ['P', 'T1', 'T2'], 'indent')
    expect(shapeOf(topBlocks(editor))).toEqual(shapeOf(topBlocks(hand)))
    expect(analyzeTaskIntents(topBlocks(editor) as never, new Set())).toEqual(
      analyzeTaskIntents(topBlocks(hand) as never, new Set())
    )
  })

  it('skips a task block that cannot nest and still moves the rest', () => {
    const editor = mountEditor(
      [
        { id: 'A', type: 'paragraph', content: 'A' },
        { id: 'T0', type: 'taskBlock', props: { taskId: 't0', title: 'Parent' } },
        { id: 'B', type: 'paragraph', content: 'B' }
      ],
      true
    )
    registerPlugin(editor)
    selectAcross(editor, 'A', 'B')
    expect(selectedBlockIds(editor)).toEqual(['A', 'T0', 'B'])

    pressTab(editor)

    // A is first, T0 has no task block above it, B nests under T0 as by hand.
    expect(topOutline(editor)).toEqual(['A', '#t0(B)'])
    expect((editor as any).getBlock('T0').props.parentTaskId).toBe('')
    expect(tasksService.update).not.toHaveBeenCalled()
  })

  it('outdents the same batch back to where it started', () => {
    const editor = mountEditor(blocks(), true)
    indentBlocks(editor, ['P', 'T1', 'T2'])
    vi.mocked(tasksService.update).mockClear()

    outdentBlocks(editor, ['P', 'T1', 'T2'])

    expect(topOutline(editor)).toEqual(['#t0', 'P', '#t1', '#t2'])
    expect(vi.mocked(tasksService.update).mock.calls.map(([arg]) => arg)).toEqual([
      { id: 't2', parentId: null },
      { id: 't1', parentId: null }
    ])

    const hand = mountEditor(blocks(), true)
    indentBlocks(hand, ['P', 'T1', 'T2'])
    byHand(hand, ['P', 'T1', 'T2'], 'outdent')
    expect(shapeOf(topBlocks(editor))).toEqual(shapeOf(topBlocks(hand)))
    expect(analyzeTaskIntents(topBlocks(editor) as never, new Set())).toEqual(
      analyzeTaskIntents(topBlocks(hand) as never, new Set())
    )
  })
})

describe('menus that own Tab keep it', () => {
  it('lets the tag suggestion popover confirm its highlighted tag', async () => {
    const editor = mountEditor(paragraphs(['A', 'B', 'C']))
    registerPlugin(editor)
    selectAcross(editor, 'B', 'C')
    const before = topOutline(editor)

    const container = document.createElement('div')
    const pill = document.createElement('span')
    pill.className = 'inline-hash-tag'
    pill.dataset.hashTag = 'wo'
    pill.getBoundingClientRect = vi.fn(() => ({ top: 20, bottom: 40, left: 60 }) as DOMRect)
    container.getBoundingClientRect = vi.fn(() => ({ top: 10, left: 20 }) as DOMRect)
    container.append(pill)

    const handlers = new Map<string, () => void>()
    const onSelect = vi.fn()
    const fakeEditor = {
      _tiptapEditor: {
        state: {
          selection: {
            $from: {
              parentOffset: 2,
              pos: 10,
              nodeBefore: { type: { name: 'hashTag' }, attrs: { tag: 'wo' }, nodeSize: 4 }
            },
            from: 10,
            to: 10
          }
        },
        on: (event: string, handler: () => void) => handlers.set(event, handler),
        off: (event: string) => handlers.delete(event)
      }
    }

    render(
      createElement(TagSuggestionPopover as any, {
        editor: fakeEditor,
        editorContainerRef: { current: container },
        onSelect
      })
    )
    act(() => {
      handlers.get('selectionUpdate')?.()
    })
    expect(await screen.findByText('#work')).toBeInTheDocument()
    // The keydown listener is a passive effect behind a promise-driven render.
    await act(async () => {
      await Promise.resolve()
    })

    tiptap(editor).view.dom.dispatchEvent(tabEvent())

    expect(onSelect).toHaveBeenCalledWith('work', 'blue', 6)
    expect(topOutline(editor)).toEqual(before)
  })

  it('lets the mention menu confirm its highlighted row', () => {
    const editor = mountEditor(paragraphs(['A', 'B', 'C']))
    registerPlugin(editor)
    selectAcross(editor, 'B', 'C')
    const before = topOutline(editor)

    const items: MentionSuggestionItem[] = [
      { kind: 'note', id: 'n1', title: 'Q3 Roadmap' },
      { kind: 'note', id: 'n2', title: 'Meeting prep' }
    ]
    const onItemClick = vi.fn()
    render(
      createElement(MentionMenu as any, {
        items,
        loadingState: 'loaded',
        selectedIndex: 0,
        onItemClick,
        hasMore: false,
        onShowMore: vi.fn()
      })
    )

    tiptap(editor).view.dom.dispatchEvent(tabEvent())

    expect(onItemClick).toHaveBeenCalledWith(items[0])
    expect(topOutline(editor)).toEqual(before)
  })

  it('leaves the inline date ghost to fill its own text', () => {
    const editor = mountEditor([{ id: 'A', type: 'paragraph', content: '@to' }])
    registerPlugin(editor)
    registerEditorPlugin(
      editor,
      createDateMentionGhostPlugin({ onAcceptPill: vi.fn() }),
      (p, plugins) => [p, ...plugins]
    )

    const tt = tiptap(editor)
    tt.commands.setTextSelection(containerPos(tt.state.doc, 'A') + 5)
    pressTab(editor)

    expect(topOutline(editor)).toEqual(['@Today'])
  })
})
