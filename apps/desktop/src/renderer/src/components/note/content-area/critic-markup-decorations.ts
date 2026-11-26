import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { CriticMarkupMark } from '@memry/shared'
import {
  editorOffsetToProseMirrorDocPos,
  markdownSliceEditorText,
  markdownSourceRangeEditorText,
  proseMirrorVisibleText
} from './critic-markup-offset-map'

const PLUGIN_KEY = new PluginKey('criticMarkupDecorations')

/**
 * `getPlainMarkdown` is the editor's text as markdown, the text a mark's
 * offsets count in. A mark holds the markdown it covers (`start **bold`), or,
 * when an older build made it, the words the editor showed (`start bold`).
 * Either way the decoration goes on words the editor shows now: a copy of the
 * markdown a moment behind the editor (it follows typing at a debounce) never
 * paints the wrong ones.
 */
export function createCriticMarkupDecorationPlugin(
  getMarks: () => CriticMarkupMark[],
  getPlainMarkdown: () => string,
  getEditorOffsetForMarkdownSourceOffset: (sourceOffset: number) => number | null
): Plugin {
  return new Plugin({
    key: PLUGIN_KEY,
    props: {
      decorations(state) {
        const decorations: Decoration[] = []
        const fullText = proseMirrorVisibleText(state.doc)
        const plain = getPlainMarkdown()

        for (const mark of getMarks()) {
          if (!mark.visibleText) continue
          const sourceStart = sourceRangeStart(plain, mark)
          const sourceEnd = sourceStart === null ? mark.end : sourceStart + mark.visibleText.length
          const shown =
            (sourceStart === null
              ? null
              : markdownSourceRangeEditorText(plain, sourceStart, sourceEnd)) ??
            (fullText.includes(mark.visibleText)
              ? mark.visibleText
              : markdownSliceEditorText(mark.visibleText))
          if (!shown) continue
          let offset = getEditorOffsetForMarkdownSourceOffset(sourceStart ?? mark.start)
          let endOffset = getEditorOffsetForMarkdownSourceOffset(sourceEnd)
          const matchesMappedRange =
            offset !== null && endOffset !== null && fullText.slice(offset, endOffset) === shown

          if (!matchesMappedRange) {
            const fallback = nearestVisibleTextEditorRange(
              fullText,
              shown,
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

/**
 * Where the mark's markdown stands in `plain`: at its offsets, or else at the
 * copy nearest them, while the offsets wait for the write-back to move them
 * after an edit. Null when `plain` does not hold it.
 */
function sourceRangeStart(plain: string, mark: CriticMarkupMark): number | null {
  if (plain.slice(mark.start, mark.end) === mark.visibleText) return mark.start
  return nearestOccurrence(plain, mark.visibleText, mark.start)
}

function nearestVisibleTextEditorRange(
  fullText: string,
  visibleText: string,
  targetOffset: number
): { offset: number; endOffset: number } | null {
  const offset = nearestOccurrence(fullText, visibleText, targetOffset)
  return offset === null ? null : { offset, endOffset: offset + visibleText.length }
}

function nearestOccurrence(text: string, needle: string, target: number): number | null {
  let best: number | null = null
  let searchFrom = 0

  while (searchFrom <= text.length) {
    const offset = text.indexOf(needle, searchFrom)
    if (offset === -1) break
    searchFrom = offset + Math.max(needle.length, 1)
    if (best === null || Math.abs(offset - target) < Math.abs(best - target)) best = offset
  }

  return best
}
