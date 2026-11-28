/**
 * A paste of deeply nested handled tags (`<b>`, `<i>`, `<span style>`, `<a>`)
 * is read in a bounded time. Past the 100th open handled tag a tag is text, so
 * the HTML parse never sees a depth that costs seconds or overflows the stack
 * (`inline/raw-html.ts`). The same pipeline runs in main, where
 * `blocknote-converter.raw-html-nesting.test.ts` checks it.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest'
import { BlockNoteEditor, type Block } from '@blocknote/core'

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
import { parseMarkdownPreservingBlanks } from './markdown-utils'

const editor = BlockNoteEditor.create({ schema: editorSchema, _headless: true } as never)

const CAP = 100
const LIMIT_MS = 500

interface Run {
  text?: string
}

function textOf(blocks: Block[]): string {
  const out: string[] = []
  const visit = (list: Block[]): void => {
    for (const block of list) {
      if (Array.isArray(block.content)) {
        for (const run of block.content as unknown as Run[]) out.push(run.text ?? '')
      }
      visit(block.children ?? [])
    }
  }
  visit(blocks)
  return out.join('')
}

const count = (text: string, needle: string): number => text.split(needle).length - 1

describe.each([4000, 8000])('a paste of %i nested handled tags', (depth) => {
  describe.each([
    ['<b>', '</b>'],
    ['<i>', '</i>'],
    ['<a href=u>', '</a>'],
    ['<span style="color:red">', '</span>'],
    ['<span style="x:1">', '</span>']
  ])('%s', (open, close) => {
    it.each([true, false])('is read in a bounded time (closed: %s)', async (closed) => {
      const markdown = `${open.repeat(depth)}x${closed ? close.repeat(depth) : ''}`
      const start = performance.now()
      const blocks = await parseMarkdownPreservingBlanks(editor, markdown)
      expect(performance.now() - start).toBeLessThan(LIMIT_MS)
      // Only the spans no color token took are left for the parse.
      if (open.includes('color:red') && closed) return
      expect(count(textOf(blocks), open)).toBe(depth - CAP)
    })
  })
})
