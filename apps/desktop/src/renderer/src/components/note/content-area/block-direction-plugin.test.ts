import { describe, expect, it } from 'vitest'
import { BlockNoteEditor } from '@blocknote/core'
import { buildBlockDirectionDecorations, firstStrongDirection } from './block-direction-plugin'

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
  it('gives each text block and its container the direction of its own text', () => {
    const editor = BlockNoteEditor.create()
    editor.replaceBlocks(editor.document, [
      { type: 'paragraph', content: 'مرحبا' },
      { type: 'heading', content: 'Hello' },
      { type: 'bulletListItem', content: '123' }
    ])
    const found = buildBlockDirectionDecorations(editor._tiptapEditor.state.doc).find()
    const dirs = found.map(
      (d) => (d as unknown as { type: { attrs: Record<string, string> } }).type.attrs.dir
    )
    expect(dirs.filter((d) => d === 'rtl')).toHaveLength(2)
    expect(dirs.filter((d) => d === 'ltr')).toHaveLength(2)
    expect(found).toHaveLength(4)
  })
})
