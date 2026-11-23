import { describe, expect, it } from 'vitest'
import { BlockNoteEditor } from '@blocknote/core'
import type { DecorationSet } from '@tiptap/pm/view'
import type { CriticMarkupMark } from '@memry/shared'
import { createCriticMarkupDecorationPlugin } from './critic-markup-decorations'

function highlightedTexts(markdown: string, marks: CriticMarkupMark[], plain: string): string[] {
  const editor = BlockNoteEditor.create()
  editor.replaceBlocks(editor.document, editor.tryParseMarkdownToBlocks(markdown))
  const state = (editor as any)._tiptapEditor.state
  const plugin = createCriticMarkupDecorationPlugin(
    () => marks,
    () => plain,
    () => null
  )
  const decorations = plugin.props.decorations?.call(plugin, state) as DecorationSet
  return decorations
    .find()
    .toSorted((a, b) => a.from - b.from)
    .map((decoration) => state.doc.textBetween(decoration.from, decoration.to))
}

function comment(id: string, visibleText: string): CriticMarkupMark {
  return { id, kind: 'comment', visibleText, body: 'Note.', start: 0, end: visibleText.length }
}

describe('CriticMarkup decorations', () => {
  // A comment holds the markdown it covers, cut wherever the selection ended.
  // The highlight goes on the words the editor shows, also while the copy of
  // the note's text has not caught up with the comment yet.
  it("highlights the words a comment's markdown shows when the text copy lacks it", () => {
    const markdown = [
      'Note: start **bold** text, see [link 5](https://example.com/5) brown and `code_0` here.',
      '',
      'Rename snake_case_name later.'
    ].join('\n')
    const marks = [
      comment('bold', 'start **bold'),
      comment('link', 'nk 5](https://example.com/5) brown'),
      comment('code', 'and `code'),
      // An older build's comment holds the words as the editor shows them.
      comment('older', 'snake_case_name')
    ]

    expect(highlightedTexts(markdown, marks, '')).toEqual([
      'start bold',
      'nk 5 brown',
      'and code',
      'snake_case_name'
    ])
  })
})
