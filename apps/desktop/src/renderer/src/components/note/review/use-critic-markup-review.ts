import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { EditorState } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import {
  deleteCriticMark,
  parseCriticMarkup,
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
  proseMirrorDocPosToEditorOffset,
  proseMirrorVisibleText
} from '../content-area/critic-markup-offset-map'

interface UseCriticMarkupReviewParams {
  markdown: string
  onMarkdownChange: (markdown: string) => void
}

type TiptapEditor = { state: EditorState; view: EditorView }
type BlockNoteHost = { _tiptapEditor?: TiptapEditor }

interface CommentDraft {
  text: string
  top?: number
  from?: number
  to?: number
}

export interface DraftSelectionRect {
  top: number
  bottom: number
  left: number
  right: number
}

interface ReviewUndoEntry {
  before: ReviewUndoSnapshot
  afterSerialized: string
}

interface ReviewUndoSnapshot {
  plainMarkdown: string
  marks: CriticMarkupMark[]
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
  handlePlainMarkdownChange: (plainMarkdown: string) => string
  persistCurrentMarkdown: () => void
  handleEditorReady: (editor: unknown) => void
  openCommentComposer: (selection: ReviewSelection) => void
  cancelCommentDraft: () => void
  getActiveDraftSelectionRect: () => DraftSelectionRect | null
  getActiveDraftDomRange: () => Range | null
  submitComment: (input: SubmitCommentInput) => void
  updateComment: (id: string, input: SubmitCommentInput) => void
  getMarkdownSourceOffsetForEditorOffset: (editorOffset: number) => number | null
  getEditorOffsetForMarkdownSourceOffset: (sourceOffset: number) => number | null
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
  const parsedMarkIds = useMemo(() => new Set(parsed.marks.map((mark) => mark.id)), [parsed.marks])
  const [plainMarkdown, setPlainMarkdown] = useState(parsed.plainText)
  const [marks, setMarks] = useState<CriticMarkupMark[]>(parsed.marks)
  const [activeDraft, setActiveDraft] = useState<CommentDraft | null>(null)
  const [hoveredMarkId, setHoveredMarkId] = useState<string | null>(null)
  const [markPositions, setMarkPositions] = useState<Record<string, number>>({})

  const plainMarkdownRef = useRef(parsed.plainText)
  const marksRef = useRef(parsed.marks)
  const activeDraftRef = useRef<CommentDraft | null>(null)
  const editorRef = useRef<BlockNoteHost | null>(null)
  const emittedMarkdownsRef = useRef<string[]>([])
  const undoStackRef = useRef<ReviewUndoEntry[]>([])
  // Ids of marks added locally but not yet confirmed persisted. Guards the resync
  // below from dropping a just-added comment when a refetch/sync delivers stale
  // note content during note.tsx's save debounce window (issue #797).
  const pendingMarkIdsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    const currentSerialized = serializeCriticMarkup(plainMarkdownRef.current, marksRef.current)
    // No-op resync: the incoming markdown matches what the current marks
    // serialize to. Keep the in-memory marks — re-parsing would drop fields the
    // markup cannot carry (mark createdAt, stable mark ids).
    if (markdown === currentSerialized) {
      pendingMarkIdsRef.current.clear()
      return
    }
    if (emittedMarkdownsRef.current.includes(markdown)) {
      return
    }

    // Don't clobber locally-added comments that haven't persisted yet. If the
    // incoming markdown is missing any pending mark id, it predates our unsaved
    // change (a stale refetch/sync) — keep local state until the save round-trips.
    if (pendingMarkIdsRef.current.size > 0) {
      const hasUnpersisted = Array.from(pendingMarkIdsRef.current).some(
        (id) => !parsedMarkIds.has(id)
      )
      if (hasUnpersisted) return
      // All pending marks are present in the incoming markdown → confirmed persisted.
      pendingMarkIdsRef.current.clear()
    }

    undoStackRef.current = []
    plainMarkdownRef.current = parsed.plainText
    marksRef.current = parsed.marks
    /* eslint-disable react-you-might-not-need-an-effect/no-pass-data-to-parent, react-you-might-not-need-an-effect/no-derived-state, react-you-might-not-need-an-effect/no-adjust-state-on-prop-change -- genuine external sync: resync local review state from incoming CRDT markdown only when it differs from what we last emitted (guarded above), while also resetting the undo stack and mirror refs; this cannot be computed during render */
    setPlainMarkdown(parsed.plainText)
    setMarks(parsed.marks)
    setHoveredMarkId(null)
    setMarkPositions({})
    /* eslint-enable react-you-might-not-need-an-effect/no-pass-data-to-parent, react-you-might-not-need-an-effect/no-derived-state, react-you-might-not-need-an-effect/no-adjust-state-on-prop-change */
  }, [markdown, parsed.plainText, parsed.marks, parsedMarkIds])

  const persist = useCallback(
    (nextPlainMarkdown: string, nextMarks: CriticMarkupMark[]) => {
      const serialized = serializeCriticMarkup(nextPlainMarkdown, nextMarks)
      plainMarkdownRef.current = nextPlainMarkdown
      marksRef.current = nextMarks
      setPlainMarkdown(nextPlainMarkdown)
      setMarks(nextMarks)
      rememberEmittedMarkdown(emittedMarkdownsRef.current, serialized)
      // Drop pending ids for marks that no longer exist locally (undo/delete of a
      // still-unsaved mark), so a wedged pending set can't suppress future resyncs.
      if (pendingMarkIdsRef.current.size > 0) {
        const nextIds = new Set(nextMarks.map((mark) => mark.id))
        for (const id of pendingMarkIdsRef.current) {
          if (!nextIds.has(id)) pendingMarkIdsRef.current.delete(id)
        }
      }
      onMarkdownChange(serialized)
    },
    [onMarkdownChange]
  )

  const handlePlainMarkdownChange = useCallback((nextPlainMarkdown: string): string => {
    const nextMarks = marksRef.current
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

  const handleEditorReady = useCallback((editor: unknown) => {
    editorRef.current = editor as BlockNoteHost | null
  }, [])

  const openCommentComposer = useCallback((selection: ReviewSelection) => {
    if (selection.isEmpty || !selection.text.trim()) return
    const nextDraft: CommentDraft = {
      text: selection.text.trim(),
      ...(selection.top !== undefined ? { top: selection.top } : {}),
      ...(selection.from !== undefined ? { from: selection.from } : {}),
      ...(selection.to !== undefined ? { to: selection.to } : {})
    }
    activeDraftRef.current = nextDraft
    setActiveDraft(nextDraft)
  }, [])

  const getActiveDraftSelectionRect = useCallback((): DraftSelectionRect | null => {
    const draft = activeDraftRef.current
    const tiptap = editorRef.current?._tiptapEditor
    if (!draft || draft.from === undefined || draft.to === undefined || !tiptap) return null
    try {
      const start = tiptap.view.coordsAtPos(draft.from)
      const end = tiptap.view.coordsAtPos(draft.to, -1)
      return {
        top: Math.min(start.top, end.top),
        bottom: Math.max(start.bottom, end.bottom),
        left: Math.min(start.left, end.left),
        right: Math.max(start.right, end.right)
      }
    } catch {
      return null
    }
  }, [])

  const getActiveDraftDomRange = useCallback((): Range | null => {
    const draft = activeDraftRef.current
    const tiptap = editorRef.current?._tiptapEditor
    if (!draft || draft.from === undefined || draft.to === undefined || !tiptap) return null
    try {
      const start = tiptap.view.domAtPos(draft.from)
      const end = tiptap.view.domAtPos(draft.to)
      const range = document.createRange()
      range.setStart(start.node, start.offset)
      range.setEnd(end.node, end.offset)
      return range
    } catch {
      return null
    }
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

      let start: number
      const doc = editorRef.current?._tiptapEditor?.state?.doc
      if (draft.from !== undefined && doc) {
        const editorOffset = proseMirrorDocPosToEditorOffset(doc, draft.from)
        const sourceOffset =
          editorOffset !== null
            ? editorOffsetToMarkdownSourceOffset(plainMarkdownRef.current, editorOffset)
            : null
        start =
          sourceOffset ?? findTextStart(plainMarkdownRef.current, draft.text, marksRef.current)
      } else {
        start = findTextStart(plainMarkdownRef.current, draft.text, marksRef.current)
      }
      if (start === -1) return

      const id = createCriticMarkId('comment')
      const createdAt = Date.now()
      const nextMarks = [
        ...marksRef.current,
        {
          id,
          kind: 'comment' as const,
          visibleText: draft.text,
          body: trimmedBody,
          metadata: `id=${id};type=comment;createdAt=${createdAt}`,
          createdAt,
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
      pendingMarkIdsRef.current.add(id)
      persist(plainMarkdownRef.current, nextMarks)
    },
    [persist]
  )

  const updateComment = useCallback(
    (id: string, input: SubmitCommentInput) => {
      const trimmedBody = input.body.trim()
      if (!trimmedBody) return
      const existing = marksRef.current.find((mark) => mark.id === id && mark.kind === 'comment')
      if (!existing) return

      const nextMarks = marksRef.current.map((mark) => {
        if (mark.id !== id) return mark
        const { mentions: _mentions, attachments: _attachments, ...rest } = mark
        return {
          ...rest,
          body: trimmedBody,
          ...(input.mentions.length > 0 ? { mentions: input.mentions } : {}),
          ...(input.attachments.length > 0 ? { attachments: input.attachments } : {})
        }
      })
      pushReviewUndoEntry(
        undoStackRef.current,
        snapshotReviewState(plainMarkdownRef.current, marksRef.current),
        plainMarkdownRef.current,
        nextMarks
      )
      persist(plainMarkdownRef.current, nextMarks)
    },
    [persist]
  )

  const getMarkdownSourceOffsetForEditorOffset = useCallback((editorOffset: number) => {
    return editorOffsetToMarkdownSourceOffset(plainMarkdownRef.current, editorOffset)
  }, [])

  const getEditorOffsetForMarkdownSourceOffset = useCallback((sourceOffset: number) => {
    return markdownSourceOffsetToEditorOffset(plainMarkdownRef.current, sourceOffset)
  }, [])

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
    handlePlainMarkdownChange,
    persistCurrentMarkdown,
    handleEditorReady,
    openCommentComposer,
    cancelCommentDraft,
    getActiveDraftSelectionRect,
    getActiveDraftDomRange,
    submitComment,
    updateComment,
    getMarkdownSourceOffsetForEditorOffset,
    getEditorOffsetForMarkdownSourceOffset,
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

function createCriticMarkId(kind: CriticMarkupKind): string {
  return `critic-${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function rememberEmittedMarkdown(emittedMarkdowns: string[], markdown: string): void {
  if (emittedMarkdowns.includes(markdown)) return
  emittedMarkdowns.push(markdown)
  if (emittedMarkdowns.length > 12) emittedMarkdowns.splice(0, emittedMarkdowns.length - 12)
}

function replaceEditorPlainMarkdown(
  editor: BlockNoteHost | null,
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
  tiptap: TiptapEditor,
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
