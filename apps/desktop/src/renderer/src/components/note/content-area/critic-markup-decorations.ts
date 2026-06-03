import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { CriticMarkupMark } from '@memry/shared'
import { editorOffsetToProseMirrorDocPos, proseMirrorVisibleText } from './critic-markup-offset-map'

const PLUGIN_KEY = new PluginKey('criticMarkupDecorations')

export function createCriticMarkupDecorationPlugin(
  getMarks: () => CriticMarkupMark[],
  getEditorOffsetForMarkdownSourceOffset: (sourceOffset: number) => number | null
): Plugin {
  return new Plugin({
    key: PLUGIN_KEY,
    props: {
      decorations(state) {
        const decorations: Decoration[] = []
        const fullText = proseMirrorVisibleText(state.doc)

        for (const mark of getMarks()) {
          if (!mark.visibleText) continue
          let offset = getEditorOffsetForMarkdownSourceOffset(mark.start)
          let endOffset = getEditorOffsetForMarkdownSourceOffset(mark.end)
          const matchesMappedRange =
            offset !== null &&
            endOffset !== null &&
            fullText.slice(offset, endOffset) === mark.visibleText

          if (!matchesMappedRange) {
            if (mark.kind !== 'comment') continue
            offset = fullText.indexOf(mark.visibleText)
            endOffset = offset + mark.visibleText.length
          }

          if (offset === null || endOffset === null || offset < 0) continue

          const from = editorOffsetToProseMirrorDocPos(state.doc, offset)
          const to = editorOffsetToProseMirrorDocPos(state.doc, endOffset)
          if (from === null || to === null || to <= from) continue

          decorations.push(
            Decoration.inline(from, to, {
              class: `critic-mark-inline critic-mark-inline-${mark.kind}`,
              'data-critic-mark-id': mark.id,
              'data-critic-mark-kind': mark.kind
            })
          )
        }

        return DecorationSet.create(state.doc, decorations)
      }
    }
  })
}
