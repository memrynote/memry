import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  acceptCriticMark,
  deleteCriticMark,
  parseCriticMarkup,
  rejectCriticMark,
  resolveCriticMark,
  serializeCriticMarkup,
  type CriticMarkupCommentAttachmentRef,
  type CriticMarkupCommentMentionRef,
  type CriticMarkupKind,
  type CriticMarkupMark
} from '@memry/shared'
import type { ReviewSelection } from '../content-area'
import {
  editorOffsetToMarkdownSourceOffset,
  editorOffsetToProseMirrorDocPos,
  markdownSourceOffsetToEditorOffset,
  proseMirrorVisibleText
} from '../content-area/critic-markup-offset-map'

interface UseCriticMarkupReviewParams {
  markdown: string
  onMarkdownChange: (markdown: string) => void
}

interface CommentDraft {
  text: string
}

interface ReviewUndoEntry {
  before: ReviewUndoSnapshot
  afterSerialized: string
}

interface ReviewUndoSnapshot {
  plainMarkdown: string
  marks: CriticMarkupMark[]
}

export interface AddSuggestionMarkInput {
  kind: Extract<CriticMarkupKind, 'addition' | 'deletion' | 'substitution'>
  visibleText: string
  originalText?: string
  start?: number
}

export interface SubmitCommentInput {
  body: string
  mentions: CriticMarkupCommentMentionRef[]
  attachments: CriticMarkupCommentAttachmentRef[]
}

export interface CriticMarkupReviewController {
  editorInitialContent: string
  plainMarkdown: string
  marks: CriticMarkupMark[]
  activeDraft: CommentDraft | null
  hoveredMarkId: string | null
  markPositions: Record<string, number>
  isSuggestionModeActive: boolean
  handlePlainMarkdownChange: (plainMarkdown: string) => string
  persistCurrentMarkdown: () => void
  handleEditorReady: (editor: any | null) => void
  openCommentComposer: (selection: ReviewSelection) => void
  cancelCommentDraft: () => void
  submitComment: (input: SubmitCommentInput) => void
  startSuggestionMode: () => void
  stopSuggestionMode: () => void
  addSuggestionMark: (input: AddSuggestionMarkInput) => void
  getMarkdownSourceOffsetForEditorOffset: (editorOffset: number) => number | null
  getEditorOffsetForMarkdownSourceOffset: (sourceOffset: number) => number | null
  acceptMark: (id: string) => void
  rejectMark: (id: string) => void
  resolveMark: (id: string) => void
  deleteMark: (id: string) => void
  undoLastReviewAction: () => boolean
  setHoveredMarkId: (id: string | null) => void
  setMarkPositions: (positions: Record<string, number>) => void
  replaceMarksFromYjs: (marks: CriticMarkupMark[]) => void
}

export function useCriticMarkupReview({
  markdown,
  onMarkdownChange
}: UseCriticMarkupReviewParams): CriticMarkupReviewController {
  const parsed = useMemo(() => parseCriticMarkup(markdown), [markdown])
  const [plainMarkdown, setPlainMarkdown] = useState(parsed.plainText)
  const [marks, setMarks] = useState<CriticMarkupMark[]>(parsed.marks)
  const [activeDraft, setActiveDraft] = useState<CommentDraft | null>(null)
  const [hoveredMarkId, setHoveredMarkId] = useState<string | null>(null)
  const [markPositions, setMarkPositions] = useState<Record<string, number>>({})
  const [isSuggestionModeActive, setIsSuggestionModeActive] = useState(false)

  const plainMarkdownRef = useRef(parsed.plainText)
  const marksRef = useRef(parsed.marks)
  const activeDraftRef = useRef<CommentDraft | null>(null)
  const editorRef = useRef<any | null>(null)
  const emittedMarkdownsRef = useRef<string[]>([])
  const isSuggestionModeActiveRef = useRef(false)
  const undoStackRef = useRef<ReviewUndoEntry[]>([])

  useEffect(() => {
    const currentSerialized = serializeCriticMarkup(plainMarkdownRef.current, marksRef.current)
    if (markdown !== currentSerialized && emittedMarkdownsRef.current.includes(markdown)) {
      return
    }

    undoStackRef.current = []
    plainMarkdownRef.current = parsed.plainText
    marksRef.current = parsed.marks
    setPlainMarkdown(parsed.plainText)
    setMarks(parsed.marks)
    setHoveredMarkId(null)
    setMarkPositions({})
  }, [markdown, parsed.plainText, parsed.marks])

  const persist = useCallback(
    (nextPlainMarkdown: string, nextMarks: CriticMarkupMark[]) => {
      const serialized = serializeCriticMarkup(nextPlainMarkdown, nextMarks)
      plainMarkdownRef.current = nextPlainMarkdown
      marksRef.current = nextMarks
      setPlainMarkdown(nextPlainMarkdown)
      setMarks(nextMarks)
      rememberEmittedMarkdown(emittedMarkdownsRef.current, serialized)
      onMarkdownChange(serialized)
    },
    [onMarkdownChange]
  )

  const handlePlainMarkdownChange = useCallback((nextPlainMarkdown: string): string => {
    const nextMarks = isSuggestionModeActiveRef.current
      ? reconcileLiveSuggestionInsertion(
          plainMarkdownRef.current,
          nextPlainMarkdown,
          marksRef.current
        )
      : marksRef.current
    const serialized = serializeCriticMarkup(nextPlainMarkdown, nextMarks)
    plainMarkdownRef.current = nextPlainMarkdown
    marksRef.current = nextMarks
    setPlainMarkdown(nextPlainMarkdown)
    setMarks(nextMarks)
    rememberEmittedMarkdown(emittedMarkdownsRef.current, serialized)
    return serialized
  }, [])

  const persistCurrentMarkdown = useCallback(() => {
    const serialized = serializeCriticMarkup(plainMarkdownRef.current, marksRef.current)
    rememberEmittedMarkdown(emittedMarkdownsRef.current, serialized)
    onMarkdownChange(serialized)
  }, [onMarkdownChange])

  const handleEditorReady = useCallback((editor: any | null) => {
    editorRef.current = editor
  }, [])

  const openCommentComposer = useCallback((selection: ReviewSelection) => {
    if (selection.isEmpty || !selection.text.trim()) return
    const nextDraft = { text: selection.text.trim() }
    activeDraftRef.current = nextDraft
    setActiveDraft(nextDraft)
  }, [])

  const cancelCommentDraft = useCallback(() => {
    activeDraftRef.current = null
    setActiveDraft(null)
  }, [])

  const submitComment = useCallback(
    (input: SubmitCommentInput) => {
      const draft = activeDraftRef.current
      const trimmedBody = input.body.trim()
      if (!draft || !trimmedBody) return

      const start = findTextStart(plainMarkdownRef.current, draft.text, marksRef.current)
      if (start === -1) return

      const id = createCriticMarkId('comment')
      const nextMarks = [
        ...marksRef.current,
        {
          id,
          kind: 'comment' as const,
          visibleText: draft.text,
          body: trimmedBody,
          metadata: `id=${id};type=comment`,
          ...(input.mentions.length > 0 ? { mentions: input.mentions } : {}),
          ...(input.attachments.length > 0 ? { attachments: input.attachments } : {}),
          start,
          end: start + draft.text.length
        }
      ]
      pushReviewUndoEntry(
        undoStackRef.current,
        snapshotReviewState(plainMarkdownRef.current, marksRef.current),
        plainMarkdownRef.current,
        nextMarks
      )
      activeDraftRef.current = null
      setActiveDraft(null)
      persist(plainMarkdownRef.current, nextMarks)
    },
    [persist]
  )

  const addSuggestionMark = useCallback(
    (input: AddSuggestionMarkInput) => {
      if (!input.visibleText) return
      if (input.kind === 'addition' && !input.visibleText.trim()) return

      if (input.start === undefined) return
      const start = input.start

      let nextPlainMarkdown = plainMarkdownRef.current
      let currentMarks = marksRef.current

      if (
        input.kind === 'addition' &&
        nextPlainMarkdown.slice(start, start + input.visibleText.length) !== input.visibleText
      ) {
        nextPlainMarkdown = `${nextPlainMarkdown.slice(0, start)}${input.visibleText}${nextPlainMarkdown.slice(start)}`
        currentMarks = shiftMarksForPlainTextEdit(
          currentMarks,
          start,
          start,
          input.visibleText.length
        )
      }

      if (input.kind === 'substitution' && input.originalText) {
        const originalEnd = start + input.originalText.length
        if (nextPlainMarkdown.slice(start, originalEnd) === input.originalText) {
          nextPlainMarkdown = `${nextPlainMarkdown.slice(0, start)}${input.visibleText}${nextPlainMarkdown.slice(originalEnd)}`
          currentMarks = shiftMarksForPlainTextEdit(
            currentMarks,
            start,
            originalEnd,
            input.visibleText.length - input.originalText.length
          )
        }
      }

      const previousMark = currentMarks[currentMarks.length - 1]
      if (
        previousMark?.kind === 'addition' &&
        input.kind === 'addition' &&
        previousMark.end === start
      ) {
        const nextMarks = currentMarks.map((mark) =>
          mark.id === previousMark.id
            ? {
                ...mark,
                visibleText: `${mark.visibleText}${input.visibleText}`,
                end: mark.end + input.visibleText.length
              }
            : mark
        )
        persist(nextPlainMarkdown, nextMarks)
        return
      }

      if (input.kind === 'deletion') {
        const mergedDeletionMarks = mergeAdjacentDeletionMark(currentMarks, input, start)
        if (mergedDeletionMarks) {
          persist(nextPlainMarkdown, mergedDeletionMarks)
          return
        }
      }

      const end = start + input.visibleText.length
      if (
        input.kind === 'substitution' &&
        nextPlainMarkdown.slice(start, end) !== input.visibleText
      ) {
        return
      }

      const id = createCriticMarkId(input.kind)
      const nextMarks = [
        ...currentMarks,
        {
          id,
          kind: input.kind,
          visibleText: input.visibleText,
          originalText: input.originalText,
          start,
          end
        }
      ]
      persist(nextPlainMarkdown, nextMarks)
    },
    [persist]
  )

  const applyTransform = useCallback(
    (
      id: string,
      transform: typeof acceptCriticMark | typeof rejectCriticMark,
      mode: 'accept' | 'reject'
    ) => {
      const mark = marksRef.current.find((item) => item.id === id)
      if (!mark) return
      const before = snapshotReviewState(plainMarkdownRef.current, marksRef.current)
      const result = transform(plainMarkdownRef.current, marksRef.current, id)
      replaceEditorVisibleText(editorRef.current, plainMarkdownRef.current, mark, mode)
      pushReviewUndoEntry(undoStackRef.current, before, result.plainText, result.marks)
      persist(result.plainText, result.marks)
    },
    [persist]
  )

  const getMarkdownSourceOffsetForEditorOffset = useCallback((editorOffset: number) => {
    return editorOffsetToMarkdownSourceOffset(plainMarkdownRef.current, editorOffset)
  }, [])

  const getEditorOffsetForMarkdownSourceOffset = useCallback((sourceOffset: number) => {
    return markdownSourceOffsetToEditorOffset(plainMarkdownRef.current, sourceOffset)
  }, [])

  const acceptMark = useCallback(
    (id: string) => applyTransform(id, acceptCriticMark, 'accept'),
    [applyTransform]
  )

  const rejectMark = useCallback(
    (id: string) => applyTransform(id, rejectCriticMark, 'reject'),
    [applyTransform]
  )

  const resolveMark = useCallback(
    (id: string) => {
      if (!marksRef.current.some((item) => item.id === id)) return
      const before = snapshotReviewState(plainMarkdownRef.current, marksRef.current)
      const result = resolveCriticMark(plainMarkdownRef.current, marksRef.current, id)
      pushReviewUndoEntry(undoStackRef.current, before, result.plainText, result.marks)
      persist(result.plainText, result.marks)
    },
    [persist]
  )

  const deleteMark = useCallback(
    (id: string) => {
      if (!marksRef.current.some((item) => item.id === id)) return
      const before = snapshotReviewState(plainMarkdownRef.current, marksRef.current)
      const result = deleteCriticMark(plainMarkdownRef.current, marksRef.current, id)
      pushReviewUndoEntry(undoStackRef.current, before, result.plainText, result.marks)
      persist(result.plainText, result.marks)
    },
    [persist]
  )

  const undoLastReviewAction = useCallback((): boolean => {
    const entry = undoStackRef.current.at(-1)
    if (!entry) return false

    const currentSerialized = serializeCriticMarkup(plainMarkdownRef.current, marksRef.current)
    if (currentSerialized !== entry.afterSerialized) return false

    undoStackRef.current.pop()
    replaceEditorPlainMarkdown(
      editorRef.current,
      plainMarkdownRef.current,
      entry.before.plainMarkdown
    )
    activeDraftRef.current = null
    setActiveDraft(null)
    setHoveredMarkId(null)
    setMarkPositions({})
    persist(entry.before.plainMarkdown, entry.before.marks)
    return true
  }, [persist])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!isUndoKeyboardShortcut(event)) return
      if (isNativeTextInput(event.target)) return
      if (!undoLastReviewAction()) return

      event.preventDefault()
      event.stopPropagation()
    }

    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [undoLastReviewAction])

  const updateMarkPositions = useCallback((positions: Record<string, number>) => {
    setMarkPositions((previous) => {
      const previousKeys = Object.keys(previous)
      const nextKeys = Object.keys(positions)
      if (
        previousKeys.length === nextKeys.length &&
        nextKeys.every((key) => previous[key] === positions[key])
      ) {
        return previous
      }
      return positions
    })
  }, [])

  const startSuggestionMode = useCallback(() => {
    isSuggestionModeActiveRef.current = true
    setIsSuggestionModeActive(true)
  }, [])

  const stopSuggestionMode = useCallback(() => {
    isSuggestionModeActiveRef.current = false
    setIsSuggestionModeActive(false)
  }, [])

  const replaceMarksFromYjs = useCallback((nextMarks: CriticMarkupMark[]) => {
    if (areCriticMarkupMarksEqual(marksRef.current, nextMarks)) return
    marksRef.current = nextMarks
    setMarks(nextMarks)
    setHoveredMarkId(null)
    setMarkPositions({})
  }, [])

  return {
    editorInitialContent: parsed.plainText,
    plainMarkdown,
    marks,
    activeDraft,
    hoveredMarkId,
    markPositions,
    isSuggestionModeActive,
    handlePlainMarkdownChange,
    persistCurrentMarkdown,
    handleEditorReady,
    openCommentComposer,
    cancelCommentDraft,
    submitComment,
    startSuggestionMode,
    stopSuggestionMode,
    addSuggestionMark,
    getMarkdownSourceOffsetForEditorOffset,
    getEditorOffsetForMarkdownSourceOffset,
    acceptMark,
    rejectMark,
    resolveMark,
    deleteMark,
    undoLastReviewAction,
    setHoveredMarkId,
    setMarkPositions: updateMarkPositions,
    replaceMarksFromYjs
  }
}

function snapshotReviewState(plainMarkdown: string, marks: CriticMarkupMark[]): ReviewUndoSnapshot {
  return {
    plainMarkdown,
    marks: marks.map((mark) => ({ ...mark }))
  }
}

function pushReviewUndoEntry(
  stack: ReviewUndoEntry[],
  before: ReviewUndoSnapshot,
  afterPlainMarkdown: string,
  afterMarks: CriticMarkupMark[]
): void {
  stack.push({
    before,
    afterSerialized: serializeCriticMarkup(afterPlainMarkdown, afterMarks)
  })
  if (stack.length > 50) stack.splice(0, stack.length - 50)
}

function isUndoKeyboardShortcut(event: KeyboardEvent): boolean {
  if (event.key.toLowerCase() !== 'z') return false
  if (event.altKey || event.shiftKey) return false
  return event.metaKey || event.ctrlKey
}

function isNativeTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return Boolean(target.closest('input, textarea, select'))
}

function areCriticMarkupMarksEqual(first: CriticMarkupMark[], second: CriticMarkupMark[]): boolean {
  return JSON.stringify(first) === JSON.stringify(second)
}

function reconcileLiveSuggestionInsertion(
  previousPlainMarkdown: string,
  nextPlainMarkdown: string,
  marks: CriticMarkupMark[]
): CriticMarkupMark[] {
  const edit = findSingleTextEdit(previousPlainMarkdown, nextPlainMarkdown)
  if (!edit || !edit.insertedText || edit.deletedText) return marks
  const insertedVisibleText = stripTrailingBlockSeparators(edit.insertedText)
  const visibleDelta = insertedVisibleText.length

  const targetAddition = [...marks]
    .reverse()
    .find((mark) => mark.kind === 'addition' && mark.start <= edit.start && mark.end >= edit.start)

  if (targetAddition) {
    return marks.map((mark) => {
      if (mark.id === targetAddition.id) {
        const end = mark.end + visibleDelta
        return {
          ...mark,
          end,
          visibleText: nextPlainMarkdown.slice(mark.start, end)
        }
      }
      if (mark.end <= edit.start) return mark
      if (mark.start >= edit.start) {
        return {
          ...mark,
          start: mark.start + edit.insertedText.length,
          end: mark.end + edit.insertedText.length
        }
      }
      return {
        ...mark,
        end: mark.end + edit.insertedText.length
      }
    })
  }

  const shiftedMarks = shiftMarksForPlainTextEdit(
    marks,
    edit.start,
    edit.start,
    edit.insertedText.length
  )
  if (!insertedVisibleText.trim()) return shiftedMarks

  const id = createCriticMarkId('addition')
  return [
    ...shiftedMarks,
    {
      id,
      kind: 'addition',
      visibleText: insertedVisibleText,
      start: edit.start,
      end: edit.start + visibleDelta
    }
  ]
}

function stripTrailingBlockSeparators(text: string): string {
  return text.replace(/\n+$/u, '')
}

function findSingleTextEdit(
  previousText: string,
  nextText: string
): { start: number; deletedText: string; insertedText: string } | null {
  if (previousText === nextText) return null

  let start = 0
  while (
    start < previousText.length &&
    start < nextText.length &&
    previousText[start] === nextText[start]
  ) {
    start++
  }

  let previousEnd = previousText.length
  let nextEnd = nextText.length
  while (
    previousEnd > start &&
    nextEnd > start &&
    previousText[previousEnd - 1] === nextText[nextEnd - 1]
  ) {
    previousEnd--
    nextEnd--
  }

  return {
    start,
    deletedText: previousText.slice(start, previousEnd),
    insertedText: nextText.slice(start, nextEnd)
  }
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

function mergeAdjacentDeletionMark(
  marks: CriticMarkupMark[],
  input: AddSuggestionMarkInput,
  start: number
): CriticMarkupMark[] | null {
  const previousMark = marks[marks.length - 1]
  if (previousMark?.kind !== 'deletion') return null

  const visibleText = input.visibleText
  const originalText = input.originalText ?? input.visibleText
  const end = start + visibleText.length

  if (end === previousMark.start) {
    return marks.map((mark) =>
      mark.id === previousMark.id
        ? {
            ...mark,
            visibleText: `${visibleText}${mark.visibleText}`,
            originalText: `${originalText}${mark.originalText ?? mark.visibleText}`,
            start,
            end: mark.end
          }
        : mark
    )
  }

  if (start === previousMark.end) {
    return marks.map((mark) =>
      mark.id === previousMark.id
        ? {
            ...mark,
            visibleText: `${mark.visibleText}${visibleText}`,
            originalText: `${mark.originalText ?? mark.visibleText}${originalText}`,
            end
          }
        : mark
    )
  }

  return null
}

function shiftMarksForPlainTextEdit(
  marks: CriticMarkupMark[],
  editStart: number,
  editEnd: number,
  delta: number
): CriticMarkupMark[] {
  if (delta === 0) return marks
  return marks.map((mark) => {
    if (mark.end <= editStart) return mark
    if (mark.start >= editEnd) {
      return {
        ...mark,
        start: mark.start + delta,
        end: mark.end + delta
      }
    }
    return {
      ...mark,
      end: mark.end + delta
    }
  })
}

function createCriticMarkId(kind: CriticMarkupKind): string {
  return `critic-${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function rememberEmittedMarkdown(emittedMarkdowns: string[], markdown: string): void {
  if (emittedMarkdowns.includes(markdown)) return
  emittedMarkdowns.push(markdown)
  if (emittedMarkdowns.length > 12) emittedMarkdowns.splice(0, emittedMarkdowns.length - 12)
}

function replaceEditorVisibleText(
  editor: any | null,
  plainMarkdown: string,
  mark: CriticMarkupMark,
  mode: 'accept' | 'reject'
): void {
  if (
    (mode === 'accept' && mark.kind !== 'deletion') ||
    (mode === 'reject' && mark.kind === 'deletion')
  ) {
    return
  }

  const tiptap = editor?._tiptapEditor
  if (!tiptap || !mark.visibleText) return
  const range = findTextRange(tiptap, plainMarkdown, mark)
  if (!range) return

  let replacement = mark.visibleText
  if (mark.kind === 'addition') replacement = ''
  if (mark.kind === 'deletion') replacement = ''
  if (mark.kind === 'substitution') replacement = mark.originalText ?? ''

  dispatchTextReplacement(tiptap, range, replacement)
}

function replaceEditorPlainMarkdown(
  editor: any | null,
  currentPlainMarkdown: string,
  nextPlainMarkdown: string
): void {
  const edit = findSingleTextEdit(currentPlainMarkdown, nextPlainMarkdown)
  if (!edit) return

  const tiptap = editor?._tiptapEditor
  if (!tiptap) return

  const fromOffset = markdownSourceOffsetToEditorOffset(currentPlainMarkdown, edit.start)
  const toOffset = markdownSourceOffsetToEditorOffset(
    currentPlainMarkdown,
    edit.start + edit.deletedText.length
  )
  if (fromOffset === null || toOffset === null) return
  if (proseMirrorVisibleText(tiptap.state.doc).slice(fromOffset, toOffset) !== edit.deletedText) {
    return
  }

  const from = editorOffsetToProseMirrorDocPos(tiptap.state.doc, fromOffset)
  const to = editorOffsetToProseMirrorDocPos(tiptap.state.doc, toOffset)
  if (from === null || to === null) return

  dispatchTextReplacement(tiptap, { from, to }, edit.insertedText)
}

function dispatchTextReplacement(
  tiptap: any,
  range: { from: number; to: number },
  replacement: string
): void {
  if (!replacement && range.from === range.to) return

  const tr = replacement
    ? tiptap.state.tr.insertText(replacement, range.from, range.to)
    : tiptap.state.tr.delete(range.from, range.to)
  tr.setMeta('addToHistory', false)
  tiptap.view.dispatch(tr)
}

function findTextRange(
  tiptap: any,
  plainMarkdown: string,
  mark: CriticMarkupMark
): { from: number; to: number } | null {
  const doc = tiptap.state.doc
  const fromOffset = markdownSourceOffsetToEditorOffset(plainMarkdown, mark.start)
  const toOffset = markdownSourceOffsetToEditorOffset(plainMarkdown, mark.end)
  if (fromOffset !== null && toOffset !== null) {
    if (proseMirrorVisibleText(doc).slice(fromOffset, toOffset) === mark.visibleText) {
      const from = editorOffsetToProseMirrorDocPos(doc, fromOffset)
      const to = editorOffsetToProseMirrorDocPos(doc, toOffset)
      if (from !== null && to !== null) return { from, to }
    }
  }

  return findInlineMarkTextRange(tiptap, mark)
}

function findInlineMarkTextRange(
  tiptap: any,
  mark: CriticMarkupMark
): { from: number; to: number } | null {
  const root = tiptap.view?.dom as HTMLElement | undefined
  if (!root) return null

  const element = Array.from(root.querySelectorAll<HTMLElement>('[data-critic-mark-id]')).find(
    (candidate) => candidate.dataset.criticMarkId === mark.id
  )
  if (!element || element.textContent !== mark.visibleText) return null

  const firstText = firstTextNode(element)
  const lastText = lastTextNode(element)
  if (!firstText || !lastText) return null

  const from = tiptap.view.posAtDOM(firstText, 0)
  const to = tiptap.view.posAtDOM(lastText, (lastText.textContent ?? '').length)
  if (typeof from !== 'number' || typeof to !== 'number' || from > to) return null
  return { from, to }
}

function firstTextNode(root: Node): Text | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  return walker.nextNode() as Text | null
}

function lastTextNode(root: Node): Text | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let last: Text | null = null
  let node: Node | null
  while ((node = walker.nextNode())) {
    last = node as Text
  }
  return last
}
