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
            const fallback = nearestVisibleTextEditorRange(
              fullText,
              mark.visibleText,
              offset ?? endOffset ?? 0
            )
            if (!fallback) continue
            offset = fallback.offset
            endOffset = fallback.endOffset
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

function nearestVisibleTextEditorRange(
  fullText: string,
  visibleText: string,
  targetOffset: number
): { offset: number; endOffset: number } | null {
  let best: { offset: number; endOffset: number; distance: number } | null = null
  let searchFrom = 0

  while (searchFrom <= fullText.length) {
    const offset = fullText.indexOf(visibleText, searchFrom)
    if (offset === -1) break
    searchFrom = offset + Math.max(visibleText.length, 1)
    const distance = Math.abs(offset - targetOffset)
    if (!best || distance < best.distance) {
      best = { offset, endOffset: offset + visibleText.length, distance }
    }
  }

  return best ? { offset: best.offset, endOffset: best.endOffset } : null
}
