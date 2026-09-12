/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  parseMarkdownPreservingBlanks: vi.fn()
}))

vi.mock('./markdown-utils', () => ({
  parseMarkdownPreservingBlanks: mocks.parseMarkdownPreservingBlanks,
  isEmptyParagraph: (block: any) => {
    if (block.type !== 'paragraph') return false
    if (block.children?.length) return false
    return !block.content || block.content.length === 0
  }
}))

vi.mock('./normalize-note-blocks', () => ({
  normalizeNoteBlocks: (blocks: any[]) => blocks
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import { insertTemplateBlocks } from './insert-template'

function makeEditor(reference: any) {
  const getBlock = vi.fn(() => reference)
  const insertBlocks = vi.fn((blocks: any[]) =>
    blocks.map((block, index) => ({ ...block, id: `inserted-${index}` }))
  )
  const replaceBlocks = vi.fn((_remove: any[], blocks: any[]) => ({
    insertedBlocks: blocks.map((block, index) => ({ ...block, id: `inserted-${index}` })),
    removedBlocks: []
  }))
  const setTextCursorPosition = vi.fn()
  return {
    editor: { getBlock, insertBlocks, replaceBlocks, setTextCursorPosition },
    getBlock,
    insertBlocks,
    replaceBlocks,
    setTextCursorPosition
  }
}

const emptyParagraph = { id: 'ref', type: 'paragraph', content: [] }
const filledParagraph = { id: 'ref', type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.parseMarkdownPreservingBlanks.mockResolvedValue([{ type: 'paragraph', content: [] }])
})

describe('insertTemplateBlocks', () => {
  it('substitutes the title placeholder before parsing', async () => {
    const { editor } = makeEditor(filledParagraph)

    await insertTemplateBlocks({
      editor,
      content: '# {{title}}\n\nAgenda for {{title}}',
      noteTitle: 'Weekly review',
      referenceBlockId: 'ref',
      placement: 'after'
    })

    expect(mocks.parseMarkdownPreservingBlanks).toHaveBeenCalledWith(
      editor,
      '# Weekly review\n\nAgenda for Weekly review',
      undefined
    )
  })

  it('returns empty and touches nothing for a whitespace-only template', async () => {
    const { editor, getBlock, insertBlocks, replaceBlocks, setTextCursorPosition } =
      makeEditor(filledParagraph)

    const result = await insertTemplateBlocks({
      editor,
      content: '   \n\t\n  ',
      noteTitle: 'Weekly review',
      referenceBlockId: 'ref',
      placement: 'replace-if-empty'
    })

    expect(result).toEqual({ ok: false, reason: 'empty' })
    expect(mocks.parseMarkdownPreservingBlanks).not.toHaveBeenCalled()
    expect(getBlock).not.toHaveBeenCalled()
    expect(insertBlocks).not.toHaveBeenCalled()
    expect(replaceBlocks).not.toHaveBeenCalled()
    expect(setTextCursorPosition).not.toHaveBeenCalled()
  })

  it('returns stale-block when the reference block is gone after parsing', async () => {
    const { editor, insertBlocks, replaceBlocks, setTextCursorPosition } = makeEditor(undefined)

    const result = await insertTemplateBlocks({
      editor,
      content: '# Agenda',
      noteTitle: 'Weekly review',
      referenceBlockId: 'ref',
      placement: 'replace-if-empty'
    })

    expect(result).toEqual({ ok: false, reason: 'stale-block' })
    expect(insertBlocks).not.toHaveBeenCalled()
    expect(replaceBlocks).not.toHaveBeenCalled()
    expect(setTextCursorPosition).not.toHaveBeenCalled()
  })

  it('replaces an empty trigger paragraph when told to consume it', async () => {
    const { editor, insertBlocks, replaceBlocks } = makeEditor(emptyParagraph)

    const result = await insertTemplateBlocks({
      editor,
      content: '# Agenda',
      noteTitle: 'Weekly review',
      referenceBlockId: 'ref',
      placement: 'replace-if-empty'
    })

    expect(replaceBlocks).toHaveBeenCalledWith(
      [emptyParagraph],
      [{ type: 'paragraph', content: [] }]
    )
    expect(insertBlocks).not.toHaveBeenCalled()
    expect(result).toEqual({ ok: true, insertedBlockIds: ['inserted-0'] })
  })

  it('inserts after a reference paragraph that still has content', async () => {
    const { editor, insertBlocks, replaceBlocks } = makeEditor(filledParagraph)

    await insertTemplateBlocks({
      editor,
      content: '# Agenda',
      noteTitle: 'Weekly review',
      referenceBlockId: 'ref',
      placement: 'replace-if-empty'
    })

    expect(insertBlocks).toHaveBeenCalledWith(
      [{ type: 'paragraph', content: [] }],
      filledParagraph,
      'after'
    )
    expect(replaceBlocks).not.toHaveBeenCalled()
  })

  it('strips ids from parsed blocks and their children', async () => {
    mocks.parseMarkdownPreservingBlanks.mockResolvedValue([
      {
        id: 'from-source-note',
        type: 'bulletListItem',
        children: [{ id: 'child-from-source-note', type: 'paragraph', children: [] }]
      }
    ])
    const { editor, insertBlocks } = makeEditor(filledParagraph)

    await insertTemplateBlocks({
      editor,
      content: '- item',
      noteTitle: 'Weekly review',
      referenceBlockId: 'ref',
      placement: 'after'
    })

    const [blocks] = insertBlocks.mock.calls[0]
    expect(blocks[0].id).toBeUndefined()
    expect(blocks[0].children[0].id).toBeUndefined()
  })

  it('puts the caret at the start of the first inserted block', async () => {
    mocks.parseMarkdownPreservingBlanks.mockResolvedValue([
      { type: 'heading', content: [] },
      { type: 'paragraph', content: [] }
    ])
    const { editor, setTextCursorPosition } = makeEditor(filledParagraph)

    const result = await insertTemplateBlocks({
      editor,
      content: '# Agenda\n\nbody',
      noteTitle: 'Weekly review',
      referenceBlockId: 'ref',
      placement: 'after'
    })

    expect(setTextCursorPosition).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'inserted-0', type: 'heading' }),
      'start'
    )
    expect(result).toEqual({ ok: true, insertedBlockIds: ['inserted-0', 'inserted-1'] })
  })

  it('reports empty when the markdown parses to no blocks', async () => {
    mocks.parseMarkdownPreservingBlanks.mockResolvedValueOnce([])
    const { editor, insertBlocks, replaceBlocks } = makeEditor(emptyParagraph)

    const result = await insertTemplateBlocks({
      editor,
      content: '<!-- nothing -->',
      noteTitle: 'Note',
      referenceBlockId: 'ref',
      placement: 'replace-if-empty'
    })

    expect(result).toEqual({ ok: false, reason: 'empty' })
    expect(insertBlocks).not.toHaveBeenCalled()
    expect(replaceBlocks).not.toHaveBeenCalled()
  })
})
