import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { EditorState } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import {
  deleteCriticMark,
  normalizeCriticMarkupCommentFormatRanges,
  parseCriticMarkup,
  resolveCriticMark,
  serializeCriticMarkup,
  type CriticMarkupCommentAttachmentRef,
  type CriticMarkupCommentFormatRange,
  type CriticMarkupCommentMentionRef,
  type CriticMarkupKind,
  type CriticMarkupMark
} from '@memry/shared'
import { createLogger } from '@/lib/logger'
import type { ReviewDocBinding, ReviewSelection } from '../content-area'
import {
  editorOffsetToMarkdownSourceOffset,
  editorOffsetToProseMirrorDocPos,
  markdownSourceOffsetToEditorOffset,
  proseMirrorDocPosToEditorOffset,
  proseMirrorVisibleText
} from '../content-area/critic-markup-offset-map'

interface UseCriticMarkupReviewParams {
  /**
   * The note or journal day the review state belongs to. A new key starts the
   * state over from `markdown`, so nothing of one note reaches the next.
   */
  documentKey: string | undefined
  markdown: string
  onMarkdownChange: (markdown: string) => void
}

const log = createLogger('Hook:CriticMarkupReview')

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
  formatRanges: CriticMarkupCommentFormatRange[]
}

export interface CriticMarkupReviewController {
  editorInitialContent: string
  plainMarkdown: string
  marks: CriticMarkupMark[]
  activeDraft: CommentDraft | null
  hoveredMarkId: string | null
  markPositions: Record<string, number>
  handlePlainMarkdownChange: (plainMarkdown: string) => string
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
  setDocBinding: (binding: ReviewDocBinding | null) => void
}

export function useCriticMarkupReview({
  documentKey,
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
  // The note's CRDT doc while the editor is bound to it (`ContentArea`). It
  // then owns the body and the marks. Null otherwise.
  const docBindingRef = useRef<ReviewDocBinding | null>(null)
  const unsubscribeBodyRef = useRef<(() => void) | null>(null)
  // Bound, the text copy above trails the doc until it is read again, and a
  // read converts the whole note. Only marks and a comment draft count in that
  // text, so it is read while one of them is there: at once when the first
  // comes, and 150ms after each change to the body.
  const bodyChangesRef = useRef(0)
  const textReadAtRef = useRef(0)
  const bodyReadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const documentKeyRef = useRef(documentKey)

  // Before any effect of the editor below: its binding then loads the next
  // note's marks into state that no longer holds this note's.
  useLayoutEffect(() => {
    if (documentKeyRef.current === documentKey) return
    documentKeyRef.current = documentKey
    pendingMarkIdsRef.current.clear()
    undoStackRef.current = []
    emittedMarkdownsRef.current = []
    plainMarkdownRef.current = parsed.plainText
    marksRef.current = parsed.marks
    activeDraftRef.current = null
    /* oxlint-disable react-you-might-not-need-an-effect/no-derived-state, react-you-might-not-need-an-effect/no-adjust-state-on-prop-change -- a new note resets the review state before the editor's effects bind it to the new note's doc; deriving it during render would leave the refs above on the old note */
    setPlainMarkdown(parsed.plainText)
    setMarks(parsed.marks)
    setActiveDraft(null)
    setHoveredMarkId(null)
    setMarkPositions({})
    /* oxlint-enable react-you-might-not-need-an-effect/no-derived-state, react-you-might-not-need-an-effect/no-adjust-state-on-prop-change */
  }, [documentKey, parsed])

  useEffect(() => {
    // Bound to the doc, the doc owns the marks and the editor the text. The
    // markdown here is the file, which trails both: it can lack a comment the
    // file cannot place, or one the write-back has not written yet.
    if (docBindingRef.current) return
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
    /* oxlint-disable react-you-might-not-need-an-effect/no-pass-data-to-parent, react-you-might-not-need-an-effect/no-derived-state, react-you-might-not-need-an-effect/no-adjust-state-on-prop-change -- genuine external sync: resync local review state from incoming CRDT markdown only when it differs from what we last emitted (guarded above), while also resetting the undo stack and mirror refs; this cannot be computed during render */
    setPlainMarkdown(parsed.plainText)
    setMarks(parsed.marks)
    setHoveredMarkId(null)
    setMarkPositions({})
    /* oxlint-enable react-you-might-not-need-an-effect/no-pass-data-to-parent, react-you-might-not-need-an-effect/no-derived-state, react-you-might-not-need-an-effect/no-adjust-state-on-prop-change */
  }, [markdown, parsed.plainText, parsed.marks, parsedMarkIds])

  const catchUpWithBody = useCallback(() => {
    if (bodyReadTimerRef.current) clearTimeout(bodyReadTimerRef.current)
    bodyReadTimerRef.current = null
    const binding = docBindingRef.current
    if (!binding || textReadAtRef.current === bodyChangesRef.current) return
    if (marksRef.current.length === 0 && !activeDraftRef.current) return
    const readAt = bodyChangesRef.current
    const key = documentKeyRef.current
    void binding.readBody().then(
      (plain) => {
        if (docBindingRef.current !== binding || documentKeyRef.current !== key) return
        if (readAt < textReadAtRef.current) return
        textReadAtRef.current = readAt
        plainMarkdownRef.current = plain
        setPlainMarkdown(plain)
      },
      (error: unknown) => log.error('Could not read the note text for its comments', error)
    )
  }, [])

  const persist = useCallback(
    (nextPlainMarkdown: string, nextMarks: CriticMarkupMark[]) => {
      const previousMarks = marksRef.current
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
      // The doc owns the body, so saving this copy of it would erase what was
      // typed since (#5568). Only this change reaches the doc's marks: the
      // others there may have moved with the text since this state read them.
      const binding = docBindingRef.current
      if (binding) {
        binding.updateMarks(markChanges(previousMarks, nextMarks))
        catchUpWithBody()
        return
      }
      onMarkdownChange(serialized)
    },
    [catchUpWithBody, onMarkdownChange]
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

  const handleEditorReady = useCallback((editor: unknown) => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- BlockNote types blocks against its custom schema generics; this helper takes the structural shape and the editor is any-typed at this seam
    editorRef.current = editor as BlockNoteHost | null
  }, [])

  const openCommentComposer = useCallback(
    (selection: ReviewSelection) => {
      if (selection.isEmpty || !selection.text.trim()) return
      const nextDraft: CommentDraft = {
        text: selection.text.trim(),
        ...(selection.top !== undefined ? { top: selection.top } : {}),
        ...(selection.from !== undefined ? { from: selection.from } : {}),
        ...(selection.to !== undefined ? { to: selection.to } : {})
      }
      activeDraftRef.current = nextDraft
      setActiveDraft(nextDraft)
      catchUpWithBody()
    },
    [catchUpWithBody]
  )

  const getActiveDraftSelectionRect = useCallback((): DraftSelectionRect | null => {
    const draft = activeDraftRef.current
    const tiptap = editorRef.current?._tiptapEditor
    if (draft?.from === undefined || draft.to === undefined || !tiptap) return null
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
    if (draft?.from === undefined || draft.to === undefined || !tiptap) return null
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

  const addComment = useCallback(
    (draft: CommentDraft, input: SubmitCommentInput, trimmedBody: string, plain: string) => {
      const range =
        selectedSourceRange(plain, draft, editorRef.current?._tiptapEditor?.state?.doc) ??
        textRange(plain, draft.text, marksRef.current)
      if (!range) return

      const id = createCriticMarkId('comment')
      const createdAt = Date.now()
      const formatRanges =
        normalizeCriticMarkupCommentFormatRanges(input.formatRanges, trimmedBody.length) ?? []
      const nextMarks = [
        ...marksRef.current,
        {
          id,
          kind: 'comment' as const,
          // The markdown the selection covers, `**` and all: the text the
          // file holds, so the write-back finds it where the offsets say.
          visibleText: plain.slice(range.start, range.end),
          body: trimmedBody,
          metadata: `id=${id};type=comment;createdAt=${createdAt}`,
          createdAt,
          ...(input.mentions.length > 0 ? { mentions: input.mentions } : {}),
          ...(input.attachments.length > 0 ? { attachments: input.attachments } : {}),
          ...(formatRanges.length > 0 ? { formatRanges } : {}),
          start: range.start,
          end: range.end
        }
      ]
      pushReviewUndoEntry(
        undoStackRef.current,
        snapshotReviewState(plain, marksRef.current),
        plain,
        nextMarks
      )
      activeDraftRef.current = null
      setActiveDraft(null)
      pendingMarkIdsRef.current.add(id)
      persist(plain, nextMarks)
    },
    [persist]
  )

  const submitComment = useCallback(
    (input: SubmitCommentInput) => {
      const draft = activeDraftRef.current
      const trimmedBody = input.body.trim()
      if (!draft || !trimmedBody) return

      const binding = docBindingRef.current
      if (!binding) {
        addComment(draft, input, trimmedBody, plainMarkdownRef.current)
        return
      }
      // This hook's copy of the text can trail the doc, which would put the
      // comment in the wrong place or drop it when its words are new. The
      // editor's text is the doc's.
      void binding.readBody().then(
        (plain) => {
          if (activeDraftRef.current === draft) addComment(draft, input, trimmedBody, plain)
        },
        (error: unknown) => {
          log.error(
            'Could not read the note text; placing the comment in the last known text',
            error
          )
          if (activeDraftRef.current === draft) {
            addComment(draft, input, trimmedBody, plainMarkdownRef.current)
          }
        }
      )
    },
    [addComment]
  )

  const updateComment = useCallback(
    (id: string, input: SubmitCommentInput) => {
      const trimmedBody = input.body.trim()
      if (!trimmedBody) return
      const existing = marksRef.current.find((mark) => mark.id === id && mark.kind === 'comment')
      if (!existing) return

      const formatRanges =
        normalizeCriticMarkupCommentFormatRanges(input.formatRanges, trimmedBody.length) ?? []
      const nextMarks = marksRef.current.map((mark) => {
        if (mark.id !== id) return mark
        const {
          mentions: _mentions,
          attachments: _attachments,
          formatRanges: _formatRanges,
          ...rest
        } = mark
        // Passed unconditionally: `buildCommentMetadata` only rewrites these keys
        // when it receives arrays, so omitting an emptied one strands the stale
        // `mentions=`/`attachments=`/`format=` in the file.
        return {
          ...rest,
          body: trimmedBody,
          mentions: input.mentions,
          attachments: input.attachments,
          formatRanges
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

    // A copy behind the body cannot tell whether the text changed since.
    if (docBindingRef.current && textReadAtRef.current !== bodyChangesRef.current) return false
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

  const setDocBinding = useCallback(
    (binding: ReviewDocBinding | null) => {
      unsubscribeBodyRef.current?.()
      unsubscribeBodyRef.current = null
      if (bodyReadTimerRef.current) clearTimeout(bodyReadTimerRef.current)
      bodyReadTimerRef.current = null
      docBindingRef.current = binding
      if (!binding) return
      // The copy is the file's, or another doc's.
      bodyChangesRef.current++
      unsubscribeBodyRef.current = binding.onBodyChange(() => {
        bodyChangesRef.current++
        if (bodyReadTimerRef.current) clearTimeout(bodyReadTimerRef.current)
        bodyReadTimerRef.current = setTimeout(catchUpWithBody, 150)
      })
      catchUpWithBody()
    },
    [catchUpWithBody]
  )

  const replaceMarksFromYjs = useCallback(
    (nextMarks: CriticMarkupMark[]) => {
      if (areCriticMarkupMarksEqual(marksRef.current, nextMarks)) return
      marksRef.current = nextMarks
      setMarks(nextMarks)
      setHoveredMarkId(null)
      setMarkPositions({})
      catchUpWithBody()
    },
    [catchUpWithBody]
  )

  return {
    editorInitialContent: parsed.plainText,
    plainMarkdown,
    marks,
    activeDraft,
    hoveredMarkId,
    markPositions,
    handlePlainMarkdownChange,
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
    replaceMarksFromYjs,
    setDocBinding
  }
}

/** What turns `before` into `after`, by mark id. */
function markChanges(
  before: CriticMarkupMark[],
  after: CriticMarkupMark[]
): { upsert: CriticMarkupMark[]; remove: string[] } {
  const beforeById = new Map(before.map((mark) => [mark.id, mark]))
  const afterIds = new Set(after.map((mark) => mark.id))
  return {
    upsert: after.filter(
      (mark) => JSON.stringify(mark) !== JSON.stringify(beforeById.get(mark.id))
    ),
    remove: before.filter((mark) => !afterIds.has(mark.id)).map((mark) => mark.id)
  }
}

/**
 * The markdown the editor selection covers, as offsets into `plain`: from the
 * first selected character to just after the last, so markers the selection
 * ends beside stay out (`**bold**` selected as `bold` is `bold`). Null when the
 * selection does not map.
 */
function selectedSourceRange(
  plain: string,
  draft: CommentDraft,
  doc: EditorState['doc'] | undefined
): { start: number; end: number } | null {
  if (draft.from === undefined || draft.to === undefined || !doc) return null
  const from = proseMirrorDocPosToEditorOffset(doc, draft.from)
  const to = proseMirrorDocPosToEditorOffset(doc, draft.to)
  if (from === null || to === null || to <= from) return null
  const first = editorOffsetToMarkdownSourceOffset(plain, from)
  const last = editorOffsetToMarkdownSourceOffset(plain, to - 1)
  if (first === null || last === null) return null
  // The draft's text is the selection trimmed, and so is the range.
  let start = first
  let end = last + 1
  while (start < end && /\s/.test(plain[start])) start++
  while (end > start && /\s/.test(plain[end - 1])) end--
  return end > start ? { start, end } : null
}

/** `text` where it first stands in `plain` and no mark already covers it exactly. */
function textRange(
  plain: string,
  text: string,
  existingMarks: CriticMarkupMark[]
): { start: number; end: number } | null {
  const start = findTextStart(plain, text, existingMarks)
  return start === -1 ? null : { start, end: start + text.length }
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
