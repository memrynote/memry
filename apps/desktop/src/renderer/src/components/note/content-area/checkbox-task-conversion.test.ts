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
import { turnTaskIntoCheckbox } from './task-to-checkbox'

const editor = BlockNoteEditor.create({ schema: editorSchema, _headless: true } as never)

/** Open the line, convert its checkbox the way ContentArea does, save. */
async function convertAndSave(line: string): Promise<string> {
  const parsed = await parseMarkdownPreservingBlanks(editor, line)
  const [checkbox] = normalizeNoteBlocks(parsed as Block[], line)
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

describe('task to plain checkbox', () => {
  // The editor above is typed for the helpers that take it; these tests drive
  // its document directly.
  const live = editor as unknown as {
    document: Block[]
    replaceBlocks: (remove: Block[], insert: Block[]) => void
  }

  async function open(markdown: string): Promise<string> {
    const parsed = await parseMarkdownPreservingBlanks(editor, markdown)
    live.replaceBlocks(live.document, normalizeNoteBlocks(parsed as Block[], markdown))
    return live.document[0].id
  }

  it('puts the task line back as a plain checkbox, links and styles intact', async () => {
    const taskId = await open(
      '- [x] Read the [lease](https://example.com/lease) **today** {task:t1}'
    )

    await turnTaskIntoCheckbox(editor as never, taskId)

    const [checkbox] = live.document
    expect(checkbox.type).toBe('checkListItem')
    expect(checkbox.props).toMatchObject({ checked: true, plain: true })
    expect(await serializeBlocksPreservingBlanks(editor, live.document)).toBe(
      '- [x] Read the [lease](https://example.com/lease) **today** {check}'
    )
  })

  it('refuses a task with subtasks under it', async () => {
    const taskId = await open('- [ ] Trip {task:t1}\n  - [ ] Pack {task:t2}')

    await turnTaskIntoCheckbox(editor as never, taskId)

    expect(live.document[0].type).toBe('taskBlock')
  })
})
