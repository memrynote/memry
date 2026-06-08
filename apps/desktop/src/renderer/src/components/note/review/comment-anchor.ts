import type { CriticMarkupMark } from '@memry/shared'
import {
  editorOffsetToMarkdownSourceOffset,
  proseMirrorDocPosToEditorOffset
} from '../content-area/critic-markup-offset-map'

/**
 * Resolve the plain-markdown start offset for a comment draft. Prefers the
 * draft's captured ProseMirror selection position so the comment anchors to
 * the occurrence the user actually selected; falls back to a text search when
 * no position info is available (e.g. DOM-only selections).
 */
export function findCommentDraftStart(
  plainMarkdown: string,
  draft: { text: string; from?: number },
  editor: any | null,
  existingMarks: CriticMarkupMark[]
): number {
  const tiptap = editor?._tiptapEditor
  if (draft.from !== undefined && tiptap) {
    const editorOffset = proseMirrorDocPosToEditorOffset(tiptap.state.doc, draft.from)
    if (editorOffset !== null) {
      const sourceOffset = editorOffsetToMarkdownSourceOffset(plainMarkdown, editorOffset)
      if (sourceOffset !== null) {
        // Exact match at the selection's mapped position
        if (plainMarkdown.startsWith(draft.text, sourceOffset)) return sourceOffset
        // Selection text was trimmed or spans hidden formatting: pick the
        // occurrence closest to the mapped position
        const closest = findClosestTextStart(plainMarkdown, draft.text, sourceOffset)
        if (closest !== -1) return closest
      }
    }
  }
  return findTextStart(plainMarkdown, draft.text, existingMarks)
}

function findClosestTextStart(plainMarkdown: string, text: string, targetOffset: number): number {
  let best = -1
  let index = plainMarkdown.indexOf(text)
  while (index !== -1) {
    if (best === -1 || Math.abs(index - targetOffset) < Math.abs(best - targetOffset)) best = index
    index = plainMarkdown.indexOf(text, index + 1)
  }
  return best
}

function findTextStart(
  plainMarkdown: string,
  text: string,
  existingMarks: CriticMarkupMark[]
): number {
  let searchFrom = 0
  while (searchFrom < plainMarkdown.length) {
    const index = plainMarkdown.indexOf(text, searchFrom)
    if (index === -1) return -1
    const occupied = existingMarks.some(
      (mark) => mark.start === index && mark.end === index + text.length
    )
    if (!occupied) return index
    searchFrom = index + text.length
  }
  return -1
}
