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

/**
 * CPU time this thread has used, in ms. The bounds below are on the work a read
 * does; wall time also counts the seconds a loaded machine makes it wait, and
 * `process.cpuUsage` counts every test file the renderer project runs in its
 * other worker threads.
 */
function cpuMs(): number {
  const { user, system } = process.threadCpuUsage()
  return (user + system) / 1000
}

const editor = BlockNoteEditor.create({ schema: editorSchema, _headless: true } as never)

const CAP = 100
/**
 * How much longer a nested read may take than a flat read of the same tags. The
 * bound is relative because CI runs under coverage, which slows every read
 * several times; before the cap the nested read cost 50x its flat twin.
 */
const RATIO = 4
/** Absolute slack, so a flat read of a few ms leaves room for timer noise. */
const SLACK_MS = 100

/** CPU ms of the faster of two parses: load on the machine only ever adds to a run. */
async function timedParse(markdown: string): Promise<{ blocks: Block[]; ms: number }> {
  let ms = Infinity
  let blocks: Block[] = []
  for (let run = 0; run < 2; run++) {
    const start = cpuMs()
    blocks = await parseMarkdownPreservingBlanks(editor, markdown)
    ms = Math.min(ms, cpuMs() - start)
  }
  return { blocks, ms }
}

interface Run {
  text?: string
  content?: Run[]
}

function textOf(blocks: Block[]): string {
  const out: string[] = []
  const visit = (list: Block[]): void => {
    for (const block of list) {
      if (Array.isArray(block.content)) {
        for (const run of block.content as unknown as Run[]) {
          out.push(run.text ?? '')
          // A link holds its text one level down.
          for (const inner of run.content ?? []) out.push(inner.text ?? '')
        }
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
      const { blocks, ms } = await timedParse(markdown)
      const { ms: flatMs } = await timedParse(`${open}x${close}`.repeat(depth))
      expect(ms).toBeLessThan(RATIO * flatMs + SLACK_MS)
      // Only the spans no color token took are left for the parse.
      if (open.includes('color:red') && closed) return
      // A second `<a>` closes the first, so they never nest and none is text.
      expect(count(textOf(blocks), open)).toBe(open === '<a href=u>' ? 0 : depth - CAP)
    })
  })
})
