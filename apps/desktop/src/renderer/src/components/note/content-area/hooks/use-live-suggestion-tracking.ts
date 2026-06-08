import { useEffect } from 'react'
import { TextSelection } from '@tiptap/pm/state'
import { proseMirrorDocPosToEditorOffset } from '../critic-markup-offset-map'
import type { CriticMarkupMark } from '@memry/shared'

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
  getReviewMarks?: () => CriticMarkupMark[]
  getPlainMarkdown: () => string
  onInsertSourceBreak?: (sourceOffset: number, breakStr: string) => void
  requestMarkdownFlush?: () => void
}

export function useLiveSuggestionTracking({
  editor,
  containerRef,
  enabled,
  onAddSuggestion,
  resolveMarkdownSourceOffset,
  getReviewMarks,
  getPlainMarkdown,
  onInsertSourceBreak,
  requestMarkdownFlush
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
        const replacementRange = markdownSourceRangeForDocRange(
          state.doc,
          selection.from,
          selection.to,
          resolveMarkdownSourceOffset
        )
        if (
          originalText &&
          replacementRange &&
          isRangeInsideAdditionMark(replacementRange.start, replacementRange.end, getReviewMarks)
        ) {
          return
        }

        const start = markdownSourceOffsetForDocPos(
          state.doc,
          selection.from,
          resolveMarkdownSourceOffset
        )
        if (start === null) return
        event.preventDefault()
        const insertTr = state.tr
          .insertText(event.data, selection.from, selection.to)
          .setMeta('addToHistory', false)
        tiptap.view.dispatch(insertTr)
        onAddSuggestion({
          kind: originalText ? 'substitution' : 'addition',
          visibleText: event.data,
          originalText: originalText || undefined,
          start
        })
        return
      }

      if (event.inputType === 'deleteContentBackward') {
        const result = recordDeletion(
          tiptap,
          onAddSuggestion,
          getPlainMarkdown(),
          resolveMarkdownSourceOffset,
          getReviewMarks
        )
        if (result !== false) {
          event.preventDefault()
        }
      }
    }

    let rangeHandledByDocument = false

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) {
        const tiptap = editor._tiptapEditor
        if (tiptap && onInsertSourceBreak) {
          const { from } = tiptap.state.selection
          const docSize = tiptap.state.doc?.content?.size ?? 0
          const charAtFrom =
            from < docSize ? tiptap.state.doc.textBetween(from, from + 1, '\n') : ''
          const isAtBlockSep = charAtFrom === '\n'
          const sourceOffset =
            markdownSourceOffsetForDocPos(tiptap.state.doc, from, resolveMarkdownSourceOffset) ??
            from
          onInsertSourceBreak(sourceOffset, isAtBlockSep ? '\n' : '\n\n')
          if (requestMarkdownFlush) {
            setTimeout(requestMarkdownFlush, 0)
          }
        }
        return
      }

      if (!isBackspaceDeleteEvent(event)) return
      if (rangeHandledByDocument) {
        rangeHandledByDocument = false
        return
      }
      const tiptap = editor._tiptapEditor
      if (!tiptap) return
      const result = recordDeletion(
        tiptap,
        onAddSuggestion,
        getPlainMarkdown(),
        resolveMarkdownSourceOffset,
        getReviewMarks
      )
      if (result === false) return
      event.preventDefault()
    }

    const handleDocumentKeyDown = (event: KeyboardEvent): void => {
      if (!isBackspaceDeleteEvent(event)) return
      if (!hasSelectedRangeInsideContainer(container)) return
      const tiptap = editor._tiptapEditor
      if (!tiptap) return
      rangeHandledByDocument = true
      const result = recordDeletion(
        tiptap,
        onAddSuggestion,
        getPlainMarkdown(),
        resolveMarkdownSourceOffset,
        getReviewMarks
      )
      if (result === false) {
        rangeHandledByDocument = false
        return
      }
      event.preventDefault()
      event.stopImmediatePropagation()
    }

    const ownerDocument = container.ownerDocument
    container.addEventListener('beforeinput', handleBeforeInput, true)
    container.addEventListener('keydown', handleKeyDown, true)
    ownerDocument.addEventListener('keydown', handleDocumentKeyDown, true)
    return () => {
      container.removeEventListener('beforeinput', handleBeforeInput, true)
      container.removeEventListener('keydown', handleKeyDown, true)
      ownerDocument.removeEventListener('keydown', handleDocumentKeyDown, true)
    }
  }, [
    containerRef,
    editor,
    enabled,
    onAddSuggestion,
    resolveMarkdownSourceOffset,
    getReviewMarks,
    getPlainMarkdown,
    onInsertSourceBreak,
    requestMarkdownFlush
  ])
}

function isBackspaceDeleteEvent(event: KeyboardEvent): boolean {
  return event.key === 'Backspace' && !event.metaKey && !event.ctrlKey && !event.altKey
}

function hasSelectedRangeInsideContainer(container: HTMLElement): boolean {
  const selection = container.ownerDocument.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false
  const { anchorNode, focusNode } = selection
  return Boolean(
    anchorNode &&
    focusNode &&
    containsSelectionNode(container, anchorNode) &&
    containsSelectionNode(container, focusNode)
  )
}

function containsSelectionNode(container: HTMLElement, node: Node): boolean {
  return node === container || container.contains(node)
}

function recordDeletion(
  tiptap: any,
  onAddSuggestion: (input: AddSuggestionInput) => void,
  plainMarkdown: string,
  resolveMarkdownSourceOffset?: (editorOffset: number) => number | null,
  getReviewMarks?: () => CriticMarkupMark[]
): 'recorded' | 'suppress' | false {
  const state = tiptap.state
  const selection = state.selection
  if (!selection) return false

  const hasRange = selection.from !== selection.to
  const from = hasRange ? selection.from : Math.max(selection.from - 1, 0)
  const to = selection.to
  if (from >= to) return false

  const visibleDeletedText = state.doc.textBetween(from, to, '\n')
  if (!visibleDeletedText) return false

  // Try to resolve source range via offset map.
  // Use (to - 1) + 1 for the end so that trailing hidden markers (e.g. closing
  // "**") after the last visible char are excluded from the deleted slice.
  const sourceStart = markdownSourceOffsetForDocPos(state.doc, from, resolveMarkdownSourceOffset)
  const sourceEndBase =
    to > 0 ? markdownSourceOffsetForDocPos(state.doc, to - 1, resolveMarkdownSourceOffset) : null
  const sourceEnd = sourceEndBase !== null ? sourceEndBase + 1 : null

  let deletedText: string
  let start: number

  if (sourceStart !== null && sourceEnd !== null) {
    deletedText = plainMarkdown.slice(sourceStart, sourceEnd)
    start = sourceStart
  } else {
    // Fallback: find unambiguous occurrence of visible text in source
    const idx = findUnambiguousMatch(plainMarkdown, visibleDeletedText)
    if (idx === -1) {
      // Can't map — suppress native delete but don't record a suggestion
      return 'suppress'
    }
    deletedText = visibleDeletedText
    start = idx
  }

  // Block separators (pure newlines) are not recordable — skip without hard-delete
  if (/^\n+$/.test(deletedText)) {
    return 'suppress'
  }

  if (isRangeInsideAdditionMark(start, start + deletedText.length, getReviewMarks)) {
    return false
  }

  onAddSuggestion({
    kind: 'deletion',
    visibleText: deletedText,
    originalText: deletedText,
    start
  })
  moveSelectionTo(tiptap, from)
  return 'recorded'
}

function findUnambiguousMatch(source: string, text: string): number {
  const idx = source.indexOf(text)
  if (idx === -1) return -1
  if (source.indexOf(text, idx + 1) !== -1) return -1 // ambiguous
  return idx
}

function markdownSourceRangeForDocRange(
  doc: any,
  from: number,
  to: number,
  resolveMarkdownSourceOffset?: (editorOffset: number) => number | null
): { start: number; end: number } | null {
  const start = markdownSourceOffsetForDocPos(doc, from, resolveMarkdownSourceOffset)
  const end = markdownSourceOffsetForDocPos(doc, to, resolveMarkdownSourceOffset)
  if (start === null || end === null) return null
  return { start, end }
}

function isRangeInsideAdditionMark(
  start: number,
  end: number,
  getReviewMarks?: () => CriticMarkupMark[]
): boolean {
  return Boolean(
    getReviewMarks?.().some(
      (mark) => mark.kind === 'addition' && mark.start <= start && mark.end >= end
    )
  )
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
