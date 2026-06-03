import { act, fireEvent, render, renderHook, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ReviewRail } from './review-rail'
import { SuggestionModePill } from './suggestion-mode-pill'
import {
  useCriticMarkupReview,
  type CriticMarkupReviewController
} from './use-critic-markup-review'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

vi.mock('@/agent-chat/messages/memry-links', () => ({
  MemryLinkIcon: () => <span data-testid="memry-link-icon" />,
  useMemryLinkNavigation: () => vi.fn(() => true)
}))

const reviewUiMocks = vi.hoisted(() => ({
  notesService: {
    uploadAttachment: vi.fn()
  }
}))

vi.mock('@/services/notes-service', () => ({
  notesService: reviewUiMocks.notesService
}))

beforeEach(() => {
  vi.clearAllMocks()
})

function createReview(
  overrides: Partial<CriticMarkupReviewController> = {}
): CriticMarkupReviewController {
  return {
    editorInitialContent: '',
    plainMarkdown: '',
    marks: [],
    activeDraft: null,
    hoveredMarkId: null,
    markPositions: {},
    isSuggestionModeActive: false,
    handlePlainMarkdownChange: vi.fn((markdown: string) => markdown),
    persistCurrentMarkdown: vi.fn(),
    handleEditorReady: vi.fn(),
    openCommentComposer: vi.fn(),
    cancelCommentDraft: vi.fn(),
    submitComment: vi.fn(),
    startSuggestionMode: vi.fn(),
    stopSuggestionMode: vi.fn(),
    addSuggestionMark: vi.fn(),
    getMarkdownSourceOffsetForEditorOffset: vi.fn(() => null),
    getEditorOffsetForMarkdownSourceOffset: vi.fn(() => null),
    acceptMark: vi.fn(),
    rejectMark: vi.fn(),
    resolveMark: vi.fn(),
    deleteMark: vi.fn(),
    undoLastReviewAction: vi.fn(() => false),
    setHoveredMarkId: vi.fn(),
    setMarkPositions: vi.fn(),
    replaceMarksFromYjs: vi.fn(),
    ...overrides
  }
}

describe('review UI', () => {
  it('renders the suggestion mode pill and exits mode', () => {
    const onClose = vi.fn()

    render(<SuggestionModePill onClose={onClose} />)

    expect(screen.getByText('comments.suggesting')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('comments.exitSuggestionMode'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('renders rail cards, drives actions, and emits hover linkage', () => {
    const review = createReview({
      marks: [
        {
          id: 'comment-1',
          kind: 'comment',
          visibleText: 'selected text',
          body: 'Needs a source',
          start: 0,
          end: 13
        },
        {
          id: 'add-1',
          kind: 'addition',
          visibleText: 'new text',
          start: 14,
          end: 22
        }
      ],
      markPositions: { 'comment-1': 24, 'add-1': 160 }
    })

    render(<ReviewRail review={review} />)

    expect(screen.getByLabelText('comments.railAria')).toBeInTheDocument()
    expect(screen.getByText('Needs a source')).toBeInTheDocument()
    expect(screen.getByText('new text')).toBeInTheDocument()

    fireEvent.pointerOver(screen.getByText('Needs a source').closest('[data-critic-mark-id]')!)
    expect(review.setHoveredMarkId).toHaveBeenCalledWith('comment-1')

    fireEvent.click(screen.getByText('comments.resolve'))
    expect(review.resolveMark).toHaveBeenCalledWith('comment-1')

    fireEvent.click(screen.getByText('comments.accept'))
    expect(review.acceptMark).toHaveBeenCalledWith('add-1')

    fireEvent.click(screen.getByText('comments.reject'))
    expect(review.rejectMark).toHaveBeenCalledWith('add-1')
  })

  it('submits and cancels an active comment draft', async () => {
    const user = userEvent.setup()
    const review = createReview({
      activeDraft: { text: 'draft target' }
    })

    render(<ReviewRail review={review} />)

    await user.type(screen.getByLabelText('comments.commentPlaceholder'), 'Draft body')
    await user.click(screen.getByLabelText('comments.sendAria'))
    expect(review.submitComment).toHaveBeenCalledWith({
      body: 'Draft body',
      mentions: [],
      attachments: []
    })

    await user.type(screen.getByLabelText('comments.commentPlaceholder'), 'Cancel me')
    await user.click(screen.getByText('comments.cancel'))
    expect(review.cancelCommentDraft).toHaveBeenCalledTimes(1)
  })

  it('uploads draft attachments through the comment target id', async () => {
    const user = userEvent.setup()
    reviewUiMocks.notesService.uploadAttachment.mockResolvedValue({
      success: true,
      path: 'attachments/note-1/spec.pdf',
      name: 'spec.pdf',
      size: 1234,
      mimeType: 'application/pdf',
      type: 'file'
    })
    const review = createReview({
      activeDraft: { text: 'draft target' }
    })

    const { container } = render(<ReviewRail review={review} targetId="note-1" />)
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')
    expect(input).not.toBeNull()

    const file = new File(['spec'], 'spec.pdf', { type: 'application/pdf' })
    await user.upload(input!, file)
    await screen.findByText('spec.pdf')
    await user.type(screen.getByLabelText('comments.commentPlaceholder'), 'Draft body')
    await user.click(screen.getByLabelText('comments.sendAria'))

    expect(reviewUiMocks.notesService.uploadAttachment).toHaveBeenCalledWith('note-1', file)
    expect(review.submitComment).toHaveBeenCalledWith({
      body: 'Draft body',
      mentions: [],
      attachments: [
        {
          id: 'attachments/note-1/spec.pdf',
          name: 'spec.pdf',
          path: 'attachments/note-1/spec.pdf',
          size: 1234,
          mimeType: 'application/pdf',
          type: 'file'
        }
      ]
    })
  })

  it('renders saved comment mentions as clickable links and attachments as chips', () => {
    const review = createReview({
      marks: [
        {
          id: 'comment-1',
          kind: 'comment',
          visibleText: 'selected text',
          body: 'See @Planning note and spec.pdf',
          mentions: [{ kind: 'note', refId: 'note-1', label: 'Planning note' }],
          attachments: [
            {
              id: 'attachments/note-1/spec.pdf',
              name: 'spec.pdf',
              path: 'attachments/note-1/spec.pdf',
              mimeType: 'application/pdf',
              type: 'file'
            }
          ],
          start: 0,
          end: 13
        }
      ]
    })

    render(<ReviewRail review={review} />)

    const mention = screen.getByRole('link', { name: '@Planning note' })
    expect(mention).toHaveAttribute('href', 'memry://note/note-1')
    expect(mention).toHaveClass('bg-sky-500/10')
    expect(screen.getByText('spec.pdf')).toBeInTheDocument()
  })

  it('merges adjacent typed additions into one suggestion card', () => {
    const { result } = renderHook(() =>
      useCriticMarkupReview({ markdown: 'base', onMarkdownChange: vi.fn() })
    )

    act(() => {
      result.current.addSuggestionMark({ kind: 'addition', visibleText: 'a', start: 4 })
    })
    act(() => {
      result.current.addSuggestionMark({ kind: 'addition', visibleText: 'b', start: 5 })
    })

    expect(result.current.marks).toHaveLength(1)
    expect(result.current.marks[0]).toMatchObject({
      kind: 'addition',
      visibleText: 'ab',
      start: 4,
      end: 6
    })
  })

  it('persists typed additions as CriticMarkup immediately', () => {
    const onMarkdownChange = vi.fn()
    const { result } = renderHook(() =>
      useCriticMarkupReview({ markdown: 'base', onMarkdownChange })
    )

    act(() => {
      result.current.addSuggestionMark({ kind: 'addition', visibleText: 'a', start: 4 })
    })

    expect(onMarkdownChange).toHaveBeenLastCalledWith('base{++a++}')
  })

  it('feeds BlockNote plain markdown while keeping suggestion marks', () => {
    const { result } = renderHook(() =>
      useCriticMarkupReview({
        markdown: 'Keep {--deleted--} and {++added++}',
        onMarkdownChange: vi.fn()
      })
    )

    expect(result.current.editorInitialContent).toBe('Keep deleted and added')
    expect(result.current.editorInitialContent).not.toContain('{--')
    expect(result.current.editorInitialContent).not.toContain('{++')
    expect(result.current.marks).toEqual([
      expect.objectContaining({ kind: 'deletion', visibleText: 'deleted' }),
      expect.objectContaining({ kind: 'addition', visibleText: 'added' })
    ])
  })

  it('merges repeated backward deletions into one suggestion card', () => {
    const onMarkdownChange = vi.fn()
    const { result } = renderHook(() =>
      useCriticMarkupReview({ markdown: 'book', onMarkdownChange })
    )

    act(() => {
      result.current.addSuggestionMark({
        kind: 'deletion',
        visibleText: 'k',
        originalText: 'k',
        start: 3
      })
    })
    act(() => {
      result.current.addSuggestionMark({
        kind: 'deletion',
        visibleText: 'o',
        originalText: 'o',
        start: 2
      })
    })
    act(() => {
      result.current.addSuggestionMark({
        kind: 'deletion',
        visibleText: 'o',
        originalText: 'o',
        start: 1
      })
    })

    expect(result.current.marks).toHaveLength(1)
    expect(result.current.marks[0]).toMatchObject({
      kind: 'deletion',
      visibleText: 'ook',
      originalText: 'ook',
      start: 1,
      end: 4
    })
    expect(onMarkdownChange).toHaveBeenLastCalledWith('b{--ook--}')
  })

  it('reconciles missed trailing typed text into the active addition mark', () => {
    const { result } = renderHook(() =>
      useCriticMarkupReview({ markdown: 'base', onMarkdownChange: vi.fn() })
    )

    act(() => {
      result.current.startSuggestionMode()
    })
    act(() => {
      result.current.addSuggestionMark({ kind: 'addition', visibleText: 'R', start: 4 })
    })

    let serialized = ''
    act(() => {
      serialized = result.current.handlePlainMarkdownChange('baseRejectMe\n\n\n\n')
    })

    expect(result.current.marks).toHaveLength(1)
    expect(result.current.marks[0]).toMatchObject({
      kind: 'addition',
      visibleText: 'RejectMe',
      start: 4,
      end: 12
    })
    expect(serialized).toBe('base{++RejectMe++}\n\n\n\n')
  })

  it('does not create empty rail cards for whitespace-only additions', () => {
    const { result } = renderHook(() =>
      useCriticMarkupReview({ markdown: 'base', onMarkdownChange: vi.fn() })
    )

    act(() => {
      result.current.addSuggestionMark({ kind: 'addition', visibleText: ' ', start: 4 })
    })

    expect(result.current.marks).toHaveLength(0)
  })

  it('ignores stale self-originated markdown after accepting a suggestion', () => {
    const onMarkdownChange = vi.fn()
    const { result, rerender } = renderHook(
      ({ markdown }) => useCriticMarkupReview({ markdown, onMarkdownChange }),
      { initialProps: { markdown: 'base' } }
    )

    act(() => {
      result.current.addSuggestionMark({ kind: 'addition', visibleText: 'a', start: 4 })
    })

    let staleMarkdown = ''
    act(() => {
      staleMarkdown = result.current.handlePlainMarkdownChange('basea')
    })

    expect(staleMarkdown).toContain('{++a++}')

    const markId = result.current.marks[0].id
    act(() => {
      result.current.acceptMark(markId)
    })

    expect(result.current.marks).toHaveLength(0)

    rerender({ markdown: staleMarkdown })

    expect(result.current.marks).toHaveLength(0)
  })

  it('undoes accepted and rejected suggestion actions', () => {
    const onMarkdownChange = vi.fn()
    const { result } = renderHook(() =>
      useCriticMarkupReview({ markdown: 'base wrong', onMarkdownChange })
    )

    act(() => {
      result.current.addSuggestionMark({ kind: 'addition', visibleText: ' added', start: 4 })
    })
    const additionId = result.current.marks[0].id
    act(() => {
      result.current.rejectMark(additionId)
    })

    expect(result.current.plainMarkdown).toBe('base wrong')
    expect(result.current.marks).toHaveLength(0)

    act(() => {
      expect(result.current.undoLastReviewAction()).toBe(true)
    })

    expect(result.current.plainMarkdown).toBe('base added wrong')
    expect(result.current.marks).toHaveLength(1)
    expect(result.current.marks[0]).toMatchObject({ id: additionId, kind: 'addition' })

    act(() => {
      result.current.addSuggestionMark({
        kind: 'substitution',
        visibleText: 'right',
        originalText: 'wrong',
        start: 'base added '.length
      })
    })
    const substitutionId = result.current.marks.find((mark) => mark.kind === 'substitution')?.id
    expect(substitutionId).toBeTruthy()

    act(() => {
      result.current.acceptMark(substitutionId!)
    })
    expect(result.current.marks.some((mark) => mark.id === substitutionId)).toBe(false)

    act(() => {
      expect(result.current.undoLastReviewAction()).toBe(true)
    })

    expect(result.current.plainMarkdown).toBe('base added right')
    expect(result.current.marks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: substitutionId, kind: 'substitution' })
      ])
    )
  })

  it('undoes submitted, resolved, and deleted comments', () => {
    const { result } = renderHook(() =>
      useCriticMarkupReview({ markdown: 'comment target', onMarkdownChange: vi.fn() })
    )

    act(() => {
      result.current.openCommentComposer({ text: 'comment target', isEmpty: false })
    })
    act(() => {
      result.current.submitComment({ body: 'Needs work', mentions: [], attachments: [] })
    })
    const commentId = result.current.marks[0].id

    act(() => {
      expect(result.current.undoLastReviewAction()).toBe(true)
    })
    expect(result.current.marks).toHaveLength(0)

    act(() => {
      result.current.openCommentComposer({ text: 'comment target', isEmpty: false })
    })
    act(() => {
      result.current.submitComment({ body: 'Needs work', mentions: [], attachments: [] })
    })
    act(() => {
      result.current.resolveMark(result.current.marks[0].id)
    })
    expect(result.current.marks).toHaveLength(0)

    act(() => {
      expect(result.current.undoLastReviewAction()).toBe(true)
    })
    expect(result.current.marks).toEqual([
      expect.objectContaining({ kind: 'comment', body: 'Needs work' })
    ])

    const restoredCommentId = result.current.marks[0].id
    act(() => {
      result.current.deleteMark(restoredCommentId)
    })
    expect(result.current.marks).toHaveLength(0)

    act(() => {
      expect(result.current.undoLastReviewAction()).toBe(true)
    })
    expect(result.current.marks).toEqual([
      expect.objectContaining({ kind: 'comment', body: 'Needs work' })
    ])
  })

  it('submits structured comment refs into the review mark and serialized markdown', () => {
    const onMarkdownChange = vi.fn()
    const { result } = renderHook(() =>
      useCriticMarkupReview({ markdown: 'comment target', onMarkdownChange })
    )

    act(() => {
      result.current.openCommentComposer({ text: 'comment target', isEmpty: false })
    })
    act(() => {
      result.current.submitComment({
        body: 'Needs @Planning note and spec.pdf',
        mentions: [{ kind: 'note', refId: 'note-1', label: 'Planning note' }],
        attachments: [
          {
            id: 'attachments/note-1/spec.pdf',
            name: 'spec.pdf',
            path: 'attachments/note-1/spec.pdf',
            mimeType: 'application/pdf',
            type: 'file'
          }
        ]
      })
    })

    expect(result.current.marks[0]).toMatchObject({
      kind: 'comment',
      body: 'Needs @Planning note and spec.pdf',
      mentions: [{ kind: 'note', refId: 'note-1', label: 'Planning note' }],
      attachments: [expect.objectContaining({ path: 'attachments/note-1/spec.pdf' })]
    })
    expect(onMarkdownChange).toHaveBeenLastCalledWith(expect.stringContaining('mentions='))
    expect(onMarkdownChange).toHaveBeenLastCalledWith(expect.stringContaining('attachments='))
  })

  it('handles Mod+Z through the review undo stack before native editor undo', () => {
    const { result } = renderHook(() =>
      useCriticMarkupReview({ markdown: 'base', onMarkdownChange: vi.fn() })
    )

    act(() => {
      result.current.addSuggestionMark({ kind: 'addition', visibleText: ' added', start: 4 })
    })
    act(() => {
      result.current.rejectMark(result.current.marks[0].id)
    })

    const undoEvent = new KeyboardEvent('keydown', {
      key: 'z',
      metaKey: true,
      bubbles: true,
      cancelable: true
    })
    act(() => {
      document.dispatchEvent(undoEvent)
    })

    expect(undoEvent.defaultPrevented).toBe(true)
    expect(result.current.plainMarkdown).toBe('base added')
    expect(result.current.marks).toHaveLength(1)
  })

  it('serializes a repeated-letter deletion at the provided source offset', () => {
    const markdown = `## Why I keep at it

Three reasons, in increasing order of importance:

1. **Information** — useful, but Wikipedia handles this

2. **Empathy** — fiction is a flight simulator for other lives`
    const onMarkdownChange = vi.fn()
    const { result } = renderHook(() => useCriticMarkupReview({ markdown, onMarkdownChange }))
    const flightI = markdown.indexOf('flight') + 2

    act(() => {
      result.current.addSuggestionMark({
        kind: 'deletion',
        visibleText: 'i',
        originalText: 'i',
        start: flightI
      })
    })
    act(() => {
      result.current.persistCurrentMarkdown()
    })

    const serialized = onMarkdownChange.mock.calls.at(-1)?.[0] as string
    expect(serialized).toContain('fl{--i--}ght')
    expect(serialized).toContain('## Why I keep at it')
    expect(serialized).not.toContain('Why I keep at {--i--}t')
  })

  it('serializes a repeated-letter addition at the provided source offset', () => {
    const markdown = `## Why I keep at it

Three reasons, in increasing order of importance:

1. **Information** — useful, but Wikipedia handles this

2. **Empathy** — fiction is a flight simulator for other lives`
    const onMarkdownChange = vi.fn()
    const { result } = renderHook(() => useCriticMarkupReview({ markdown, onMarkdownChange }))
    const wikipediaExtraP = markdown.indexOf('Wikipedia') + 'Wikip'.length

    act(() => {
      result.current.addSuggestionMark({
        kind: 'addition',
        visibleText: 'p',
        start: wikipediaExtraP
      })
    })
    act(() => {
      result.current.persistCurrentMarkdown()
    })

    const serialized = onMarkdownChange.mock.calls.at(-1)?.[0] as string
    expect(serialized).toContain('Wikip{++p++}edia')
    expect(serialized).toContain('## Why I keep at it')
    expect(serialized).not.toContain('Why I kee{++p++} at it')
  })
})
