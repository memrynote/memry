/**
 * Text that spells a placeholder the markdown masks use must stay text when it
 * is pasted or opened in the editor, as it does when the main process seeds it
 * (`src/main/sync/mask-collisions.test.ts`): reading `MEMRY` as text is
 * reading `MEMRX` as text, with the word swapped back. Real schema and real
 * serializer.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest'
import { BlockNoteEditor } from '@blocknote/core'

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
import { parseMarkdownPreservingBlanks, serializeBlocksPreservingBlanks } from './markdown-utils'

const editor = BlockNoteEditor.create({ schema: editorSchema, _headless: true } as never)

async function opened(markdown: string): Promise<string> {
  const blocks = await parseMarkdownPreservingBlanks(editor, markdown)
  return serializeBlocksPreservingBlanks(editor, blocks)
}

const CASES: Array<[string, string]> = [
  ['table cell code spans', '| `x|MEMRYCSP0X` | `MEMRYCSP0X` |\n| --- | --- |\n| `a b` | c |'],
  ['a hard break', 'a  \nMEMRYHBK0;\nb'],
  ['a hard break before a token on its line', 'a  \nMEMRYHBK0;b\nc'],
  ['an inline token', 'MEMRYTKN0X and ((mention:abc))'],
  [
    'a table row wider than its header, after text spelling its probe',
    'MEMRYTBL0X\n\n| a |\n| --- |\n| b | MEMRYTBL1X | c |'
  ],
  ['a details markup line', '<details data-x>\nMEMRYDLT;summary>t\n'],
  ['a colour span', '<span style="color:red">x</span> MEMRYICO0:y:MEMRYICC; MEMRYICO1:z'],
  ['a link card marker', 'MEMRYLINKCARD link-card:{"a":1} -->\n[[a]]']
]

describe('pasted markdown that spells a placeholder', () => {
  it.each(CASES)('%s stays text', async (_name, markdown) => {
    const reference = await opened(markdown.replaceAll('MEMRY', 'MEMRX'))
    expect(await opened(markdown)).toBe(reference.replaceAll('MEMRX', 'MEMRY'))
  })
})
