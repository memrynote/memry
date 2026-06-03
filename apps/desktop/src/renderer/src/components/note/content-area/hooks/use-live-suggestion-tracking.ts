import { useEffect } from 'react'
import { TextSelection } from '@tiptap/pm/state'
import { proseMirrorDocPosToEditorOffset } from '../critic-markup-offset-map'

interface AddSuggestionInput {
  kind: 'addition' | 'deletion' | 'substitution'
  visibleText: string
  originalText?: string
  start?: number
}

interface UseLiveSuggestionTrackingParams {
  editor: any
  containerRef: React.RefObject<HTMLDivElement | null>
  enabled: boolean
  onAddSuggestion: (input: AddSuggestionInput) => void
  resolveMarkdownSourceOffset?: (editorOffset: number) => number | null
}

export function useLiveSuggestionTracking({
  editor,
  containerRef,
  enabled,
  onAddSuggestion,
  resolveMarkdownSourceOffset
}: UseLiveSuggestionTrackingParams): void {
  useEffect(() => {
    const container = containerRef.current
    if (!container || !enabled) return

    const handleBeforeInput = (event: InputEvent): void => {
      const tiptap = editor._tiptapEditor
      if (!tiptap || event.isComposing) return

      const state = tiptap.state
      const selection = state.selection
      if (!selection) return

      if (event.inputType === 'insertText' && event.data) {
        const originalText = state.doc.textBetween(selection.from, selection.to, '\n')
        const start = markdownSourceOffsetForDocPos(
          state.doc,
          selection.from,
          resolveMarkdownSourceOffset
        )
        if (start === null) return
        event.preventDefault()
        tiptap.view.dispatch(state.tr.insertText(event.data, selection.from, selection.to))
        onAddSuggestion({
          kind: originalText ? 'substitution' : 'addition',
          visibleText: event.data,
          originalText: originalText || undefined,
          start
        })
        return
      }

      if (event.inputType === 'deleteContentBackward') {
        if (recordDeletion(tiptap, onAddSuggestion, resolveMarkdownSourceOffset)) {
          event.preventDefault()
        }
      }
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Backspace' || event.metaKey || event.ctrlKey || event.altKey) return
      const tiptap = editor._tiptapEditor
      if (!tiptap) return
      if (!recordDeletion(tiptap, onAddSuggestion, resolveMarkdownSourceOffset)) {
        return
      }
      event.preventDefault()
    }

    container.addEventListener('beforeinput', handleBeforeInput, true)
    container.addEventListener('keydown', handleKeyDown, true)
    return () => {
      container.removeEventListener('beforeinput', handleBeforeInput, true)
      container.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [containerRef, editor, enabled, onAddSuggestion, resolveMarkdownSourceOffset])
}

function recordDeletion(
  tiptap: any,
  onAddSuggestion: (input: AddSuggestionInput) => void,
  resolveMarkdownSourceOffset?: (editorOffset: number) => number | null
): boolean {
  const state = tiptap.state
  const selection = state.selection
  if (!selection) return false

  const hasRange = selection.from !== selection.to
  const from = hasRange ? selection.from : Math.max(selection.from - 1, 0)
  const to = selection.to
  if (from >= to) return false

  const deletedText = state.doc.textBetween(from, to, '\n')
  if (!deletedText) return false
  const start = markdownSourceOffsetForDocPos(state.doc, from, resolveMarkdownSourceOffset)
  if (start === null) return false

  onAddSuggestion({
    kind: 'deletion',
    visibleText: deletedText,
    originalText: deletedText,
    start
  })
  moveSelectionTo(tiptap, from)
  return true
}

function moveSelectionTo(tiptap: any, position: number): void {
  try {
    tiptap.view.dispatch(
      tiptap.state.tr.setSelection(TextSelection.create(tiptap.state.doc, position))
    )
  } catch {
    // Ignore invalid cursor positions; the suggestion mark is still preserved.
  }
}

function markdownSourceOffsetForDocPos(
  doc: any,
  targetPos: number,
  resolveMarkdownSourceOffset?: (editorOffset: number) => number | null
): number | null {
  if (!resolveMarkdownSourceOffset) return null
  const editorOffset = proseMirrorDocPosToEditorOffset(doc, targetPos)
  if (editorOffset === null) return null
  return resolveMarkdownSourceOffset(editorOffset)
}
