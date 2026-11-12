import { beforeAll, describe, expect, it, vi } from 'vitest'
import { BlockNoteEditor } from '@blocknote/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { buildBlockDirectionDecorations, firstStrongDirection } from './block-direction-plugin'

// Same stubs as checkbox-task-conversion.test.ts: the real schema's file and
// diagram blocks touch browser APIs jsdom lacks at import time.
vi.mock('react-pdf', () => ({
  Document: () => null,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: { workerSrc: '' } }
}))
vi.mock('mermaid', () => ({
  default: {
    initialize: () => undefined,
    parse: () => Promise.resolve(true),
    render: () => Promise.resolve({ svg: '<svg/>' })
  }
}))

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false
})

const { editorSchema } = await import('./editor-schema')

type DirDecoration = { from: number; type: { attrs: Record<string, string> } }

/** The `dir` each top-level block's container ends up with, in document order. */
function containerDirs(doc: ProseMirrorNode): Array<string | undefined> {
  const decorations = buildBlockDirectionDecorations(doc).find() as unknown as DirDecoration[]
  const dirs: Array<string | undefined> = []
  doc.descendants((node, pos) => {
    if (node.type.name !== 'blockContainer') return true
    dirs.push(decorations.find((d) => d.from === pos)?.type.attrs.dir)
    return false
  })
  return dirs
}

describe('firstStrongDirection', () => {
  it('reads the first letter, skipping digits, punctuation and emoji', () => {
    expect(firstStrongDirection('مرحبا hello')).toBe('rtl')
    expect(firstStrongDirection('سلام')).toBe('rtl')
    expect(firstStrongDirection('שלום')).toBe('rtl')
    expect(firstStrongDirection('Hello مرحبا')).toBe('ltr')
    expect(firstStrongDirection('1. 🎉 مرحبا')).toBe('rtl')
    expect(firstStrongDirection('123 !?')).toBeNull()
  })
})

describe('block direction decorations', () => {
  it('gives each block the direction of its own text', () => {
    const editor = BlockNoteEditor.create({ schema: editorSchema, _headless: true })
    editor.replaceBlocks(editor.document, [
      { type: 'paragraph', content: 'سلام\nHello' },
      { type: 'heading', content: 'Hello' },
      { type: 'bulletListItem', content: '123' },
      { type: 'taskBlock', props: { taskId: 't1', title: 'کار فارسی' } },
      { type: 'taskBlock', props: { taskId: 't2', title: 'English task' } },
      { type: 'codeBlock', content: '// توضیح\nconst x = 1' }
    ] as never)
    expect(containerDirs(editor._tiptapEditor.state.doc)).toEqual([
      'rtl',
      'ltr',
      undefined,
      'rtl',
      'ltr',
      undefined
    ])
  })
})
