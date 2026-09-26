/**
 * What a note's file says after a checkbox line becomes a task. The conversion
 * runs on every note the editor opens, including one that just arrived from
 * another device, so whatever it drops is dropped from the note everywhere.
 * Real schema and real serializer: a mocked editor would pass whatever the
 * vault file ends up holding.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest'
import { BlockNoteEditor, type Block } from '@blocknote/core'

// Same stubs as roundtrip-conformance.test.ts: the file block's PDF preview and
// the diagram preview both touch browser APIs jsdom lacks at import time.
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

import { editorSchema } from './editor-schema'
import {
  checkboxLineMarkdown,
  parseMarkdownPreservingBlanks,
  serializeBlocksPreservingBlanks
} from './markdown-utils'
import { normalizeNoteBlocks } from './normalize-note-blocks'

const editor = BlockNoteEditor.create({ schema: editorSchema, _headless: true } as never)

/** Open the line, convert its checkbox the way ContentArea does, save. */
async function convertAndSave(line: string): Promise<string> {
  const parsed = await parseMarkdownPreservingBlanks(editor, line)
  const [checkbox] = normalizeNoteBlocks(parsed as Block[])
  const task = {
    ...checkbox,
    type: 'taskBlock',
    props: {
      taskId: 't1',
      title: checkboxLineMarkdown(editor, checkbox),
      checked: !!(checkbox.props as { checked?: boolean }).checked,
      parentTaskId: ''
    },
    content: undefined,
    children: []
  } as unknown as Block
  return serializeBlocksPreservingBlanks(editor, [task])
}

describe('checkbox to task conversion', () => {
  it.each([
    [
      '- [ ] **Dune: Part Two** — bumped because [[Dune (2021)]] was so good',
      '- [ ] **Dune: Part Two** — bumped because [[Dune (2021)]] was so good {task:t1}'
    ],
    ['- [x] Parasite — see [[Parasite]]', '- [x] Parasite — see [[Parasite]] {task:t1}'],
    ['- [ ] #errand buy [[Milk]]', '- [ ] #errand buy [[Milk]] {task:t1}'],
    [
      '- [ ] Call [[Anna Smith|Anna]] about *the* [lease](https://example.com/lease) #home',
      '- [ ] Call [[Anna Smith|Anna]] about *the* [lease](https://example.com/lease) #home {task:t1}'
    ]
  ])('keeps the inline content of %s and only adds the task suffix', async (line, expected) => {
    expect(await convertAndSave(line)).toBe(expected)
  })
})
