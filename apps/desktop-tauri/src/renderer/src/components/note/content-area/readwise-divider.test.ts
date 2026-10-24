import { beforeAll, describe, expect, it, vi } from 'vitest'
import { BlockNoteEditor } from '@blocknote/core'
import { renderHtmlComment } from './html-comment'
import { editorSchema } from './editor-schema'
import { parseMarkdownPreservingBlanks, serializeBlocksPreservingBlanks } from './markdown-utils'
import { serializeMarkdownPreservingSource } from './markdown-source'
import { normalizeNoteBlocks } from './normalize-note-blocks'

// pdf.js and Mermaid need browser APIs jsdom lacks; the bytes asserted here never reach them.
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

const nodeView = { renderType: 'nodeView' }
const render = (source: string): HTMLElement =>
  renderHtmlComment.call(nodeView, { props: { source } }).dom

describe('Readwise section dividers', () => {
  it('draws the start marker as a labeled band with the edit hint', () => {
    const dom = render('<!-- readwise:start -->')
    expect(dom.getAttribute('role')).toBe('separator')
    expect(dom.getAttribute('aria-label')).toBe('Readwise · syncs automatically')
    expect(dom.textContent).toContain('Readwise · syncs automatically')
    expect(dom.textContent).toContain('Edit inside this section and Readwise stops updating it.')
  })

  it('draws the end marker, with its state fields, as a closing band without a hint', () => {
    const dom = render('<!-- readwise:end v1 last=2025-01-01T00:00:00Z hash=0a1b2c3d -->')
    expect(dom.textContent).toBe('End of Readwise section')
    expect(dom.querySelector('.readwise-divider-hint')).toBeNull()
  })

  it('gives the journal day markers their own labels', () => {
    expect(render('<!-- readwise-day:start -->').textContent).toContain(
      "Readwise · today's highlights"
    )
    expect(render('<!-- readwise-day:end v1 hash=4b1e09aa -->').textContent).toBe('End of Readwise')
  })

  it.each(['<!-- readwise:starting -->', '<!-- readwise:other -->', '<!-- note to self -->'])(
    'keeps the generic chip for %s',
    (source) => {
      const dom = render(source)
      expect(dom.className).toBe('html-comment-marker')
      expect(dom.textContent).toBe('<!---->')
    }
  )
})

describe('Readwise section round trip', () => {
  beforeAll(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false
  })
  const editor = BlockNoteEditor.create({ schema: editorSchema, _headless: true } as never)
  const note = [
    'My own line.',
    '',
    '<!-- readwise:start -->',
    '',
    '## Highlights',
    '',
    '- First highlight',
    '',
    '<!-- readwise:end v1 last=2025-01-01T00:00:00Z hash=0a1b2c3d -->',
    '',
    '<!-- readwise-day:start -->',
    '',
    '- Atomic Habits: 3 highlights',
    '',
    '<!-- readwise-day:end v1 hash=4b1e09aa -->'
  ].join('\n')

  it('saves the exact bytes it opened', async () => {
    const parsed = await parseMarkdownPreservingBlanks(editor, note)
    const blocks = normalizeNoteBlocks(parsed, note)
    const canonical = await serializeBlocksPreservingBlanks(editor, blocks)
    expect(
      await serializeMarkdownPreservingSource(editor, blocks, canonical === note ? null : note)
    ).toBe(note)
    expect(canonical).toBe(note)
  })
})
