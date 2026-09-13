import { describe, expect, it } from 'vitest'
import {
  exportMarkdown,
  seedFromDocLoad,
  seedFromMarkdown,
  type MarkdownEditorSurface
} from './markdown-bridge.ts'

/**
 * A block shaped the way `isEditorEmpty` reads one: BlockNote always keeps a
 * trailing block, so the empty document is one block with no content.
 */
interface FakeBlock {
  content: unknown[]
}

interface FakeEditorOptions {
  document?: FakeBlock[]
  parse?: (markdown: string) => FakeBlock[]
  serialize?: (blocks: FakeBlock[]) => string
  replace?: (blocks: FakeBlock[]) => void
}

interface FakeEditor extends MarkdownEditorSurface {
  parsed: string[]
  replaced: unknown[][]
  document: FakeBlock[]
}

const block = (text: string): FakeBlock => ({ content: [text] })
const EMPTY_DOC: FakeBlock[] = [{ content: [] }]

function fakeEditor(options: FakeEditorOptions = {}): FakeEditor {
  const editor: FakeEditor = {
    document: options.document ?? EMPTY_DOC.map((b) => ({ ...b })),
    parsed: [],
    replaced: [],
    blocksToMarkdownLossy: () =>
      options.serialize
        ? options.serialize(editor.document)
        : editor.document.map((b) => b.content.join('')).join('\n'),
    tryParseMarkdownToBlocks: (markdown) => {
      editor.parsed.push(markdown)
      return options.parse ? options.parse(markdown) : [block(markdown)]
    },
    replaceBlocks: (_target, blocks) => {
      const typed = blocks as FakeBlock[]
      editor.replaced.push(typed)
      if (options.replace) options.replace(typed)
      editor.document = typed
    }
  }
  return editor
}

describe('exportMarkdown', () => {
  it('serializes the mounted document through the schema', () => {
    const editor = fakeEditor({ document: [block('# Title'), block('body')] })
    expect(exportMarkdown(editor)).toEqual({ status: 'ok', markdown: '# Title\nbody' })
  })

  it('reports a serializer throw instead of returning empty markdown', () => {
    const editor = fakeEditor({
      serialize: () => {
        throw new Error('serializer exploded')
      }
    })
    expect(exportMarkdown(editor)).toEqual({ status: 'error', detail: 'serializer exploded' })
  })

  it('never returns an empty detail, so the wire shape stays legal', () => {
    const editor = fakeEditor({
      serialize: () => {
        throw new Error('')
      }
    })
    expect(exportMarkdown(editor)).toEqual({
      status: 'error',
      detail: 'markdown conversion failed'
    })
  })
})

describe('seedFromMarkdown', () => {
  it('splits the frontmatter block off and parses only the body', () => {
    const editor = fakeEditor()
    const result = seedFromMarkdown(editor, '---\ntags:\n  - alpha\n---\n# Heading\n\nbody\n')

    expect(result).toEqual({ status: 'seeded' })
    expect(editor.parsed).toEqual(['# Heading\n\nbody\n'])
  })

  it('never re-derives tags or properties from the frontmatter it dropped', () => {
    const editor = fakeEditor()
    seedFromMarkdown(editor, '---\ntags: [alpha]\nproperties:\n  status: draft\n---\nbody\n')

    // The only thing that reached BlockNote is the body. Tags and properties
    // live on the note record; a second reading of them here is the defect.
    expect(editor.parsed).toEqual(['body\n'])
    expect(JSON.stringify(editor.replaced)).not.toContain('alpha')
    expect(JSON.stringify(editor.replaced)).not.toContain('draft')
  })

  it('treats an unclosed fence as body, exactly as the shared splitter does', () => {
    const editor = fakeEditor()
    seedFromMarkdown(editor, '---\ntags: [alpha]\nstill open\n')
    expect(editor.parsed).toEqual(['---\ntags: [alpha]\nstill open\n'])
  })

  it('keeps a BOM with the frontmatter block rather than with the body', () => {
    const editor = fakeEditor()
    seedFromMarkdown(editor, '﻿---\ntitle: x\n---\nbody\n')
    expect(editor.parsed).toEqual(['body\n'])
  })

  it('reports a frontmatter-only payload as a spent seed, not as an error', () => {
    const editor = fakeEditor()
    expect(seedFromMarkdown(editor, '---\ntags: [alpha]\n---\n')).toEqual({
      status: 'skipped',
      reason: 'no-body'
    })
    expect(editor.replaced).toEqual([])
  })

  it('reports the ordinary empty create as a spent seed', () => {
    const editor = fakeEditor()
    expect(seedFromMarkdown(editor, '')).toEqual({ status: 'skipped', reason: 'no-body' })
    expect(editor.parsed).toEqual([])
  })

  it('refuses to replace a document that already has content', () => {
    const editor = fakeEditor({ document: [block('the real body')] })
    expect(seedFromMarkdown(editor, 'seed text')).toEqual({
      status: 'skipped',
      reason: 'not-empty'
    })
    expect(editor.replaced).toEqual([])
  })

  it('reports a parse failure and leaves the document untouched', () => {
    const editor = fakeEditor({
      parse: () => {
        throw new Error('bad markdown')
      }
    })
    expect(seedFromMarkdown(editor, 'body')).toEqual({
      status: 'error',
      detail: 'bad markdown'
    })
    expect(editor.replaced).toEqual([])
    expect(editor.document).toEqual(EMPTY_DOC)
  })

  it('reports a failure to apply the parsed blocks', () => {
    const editor = fakeEditor({
      replace: () => {
        throw new Error('replace failed')
      }
    })
    expect(seedFromMarkdown(editor, 'body')).toEqual({
      status: 'error',
      detail: 'replace failed'
    })
  })

  it('reports markdown that parses to nothing as a spent seed', () => {
    const editor = fakeEditor({ parse: () => [] })
    expect(seedFromMarkdown(editor, '<!-- comment -->')).toEqual({
      status: 'skipped',
      reason: 'no-body'
    })
    expect(editor.replaced).toEqual([])
  })
})

describe('seedFromDocLoad', () => {
  it('parses its input verbatim, frontmatter included', () => {
    // Frozen behaviour: this is what every shipped host gets today
    // (chapter 12 §12.1.1), and an older host must keep getting exactly it.
    const editor = fakeEditor()
    const raw = '---\ntitle: x\n---\nbody\n'
    expect(seedFromDocLoad(editor, raw)).toEqual({ status: 'seeded' })
    expect(editor.parsed).toEqual([raw])
  })

  it('applies nothing to a document that already has content', () => {
    const editor = fakeEditor({ document: [block('the real body')] })
    expect(seedFromDocLoad(editor, 'seed text')).toEqual({
      status: 'skipped',
      reason: 'not-empty'
    })
    expect(editor.replaced).toEqual([])
  })

  it('reports a parse failure rather than emptying the document', () => {
    const editor = fakeEditor({
      parse: () => {
        throw new Error('bad markdown')
      }
    })
    expect(seedFromDocLoad(editor, 'body')).toEqual({
      status: 'error',
      detail: 'bad markdown'
    })
    expect(editor.document).toEqual(EMPTY_DOC)
  })
})
