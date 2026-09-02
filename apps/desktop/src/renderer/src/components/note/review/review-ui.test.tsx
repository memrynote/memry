import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { serializeCriticMarkup } from '@memry/shared'
import { ReviewRail } from './review-rail'
import {
  useCriticMarkupReview,
  type CriticMarkupReviewController
} from './use-critic-markup-review'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key, i18n: { language: 'en' } })
}))

vi.mock('@/hooks/use-general-settings', () => ({
  useGeneralSettings: () => ({
    settings: { clockFormat: '24h' },
    isLoading: false,
    error: null,
    updateSettings: vi.fn()
  })
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
  document.getElementById('critic-mark-hover-style')?.remove()
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
    handlePlainMarkdownChange: vi.fn((markdown: string) => markdown),
    persistCurrentMarkdown: vi.fn(),
    handleEditorReady: vi.fn(),
    openCommentComposer: vi.fn(),
    cancelCommentDraft: vi.fn(),
    getActiveDraftSelectionRect: vi.fn(() => null),
    getActiveDraftDomRange: vi.fn(() => null),
    submitComment: vi.fn(),
    updateComment: vi.fn(),
    getMarkdownSourceOffsetForEditorOffset: vi.fn(() => null),
    getEditorOffsetForMarkdownSourceOffset: vi.fn(() => null),
    resolveMark: vi.fn(),
    deleteMark: vi.fn(),
    undoLastReviewAction: vi.fn(() => false),
    setHoveredMarkId: vi.fn(),
    setMarkPositions: vi.fn(),
    replaceMarksFromYjs: vi.fn(),
    ...overrides
  }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

describe('review UI', () => {
  it('moves rail cards left on hover with a theme-owned background token', () => {
    const css = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../../assets/base.css'),
      'utf8'
    )
    const cardBlock = css.match(/\.critic-review-card\s*\{(?<body>[^}]*)\}/)?.groups?.body
    const hoverBlock = css.match(
      /\.critic-review-card\[data-hovered='true'\],\s*\.critic-review-card:hover\s*\{(?<body>[^}]*)\}/
    )?.groups?.body

    expect(cardBlock).toContain('will-change: transform')
    expect(cardBlock).toContain('transform 200ms ease')
    expect(css).toContain('--critic-review-card-hover-background: #202020;')
    expect(css).toContain('--critic-review-card-hover-background: var(--surface-active);')
    expect(hoverBlock).toContain('background-color: var(--critic-review-card-hover-background)')
    expect(hoverBlock).toContain('transform: translateX(-20px)')
    expect(hoverBlock).not.toContain('border-color')
    expect(css).toContain('.critic-review-text-collapsible')
    expect(css).toContain('text-overflow: ellipsis')
    expect(css).toContain(
      ".critic-review-card[data-expanded='true'] .critic-review-text-collapsible"
    )
    expect(css).toContain('.critic-comment-format-toolbar')
    expect(css).toContain('.critic-comment-format-button')
    expect(css).toContain('.critic-comment-main-row')
    expect(css).toContain('display: flex')
    expect(css).toContain('.critic-comment-editor .ProseMirror')
    expect(css).toContain(".critic-review-card[data-editing='true']")
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
        }
      ],
      markPositions: { 'comment-1': 24 }
    })

    render(<ReviewRail review={review} />)

    expect(screen.getByLabelText('comments.railAria')).toBeInTheDocument()
    expect(screen.getByText('Needs a source')).toBeInTheDocument()
    expect(screen.queryByText('selected text')).not.toBeInTheDocument()

    const inlineMark = document.createElement('span')
    inlineMark.dataset.criticMarkKind = 'comment'
    inlineMark.dataset.criticMarkId = 'comment-1'
    document.body.appendChild(inlineMark)

    fireEvent.pointerOver(screen.getByText('Needs a source').closest('[data-critic-mark-id]')!)
    expect(review.setHoveredMarkId).toHaveBeenCalledWith('comment-1')
    expect(inlineMark).toHaveClass('critic-mark-hovered')

    fireEvent.pointerOut(screen.getByText('Needs a source').closest('[data-critic-mark-id]')!)
    expect(inlineMark).not.toHaveClass('critic-mark-hovered')
    inlineMark.remove()

    fireEvent.click(screen.getByLabelText('comments.resolve'))
    expect(review.resolveMark).toHaveBeenCalledWith('comment-1')
  })

  it('keeps long cards collapsed to one line until the card is clicked', () => {
    const review = createReview({
      marks: [
        {
          id: 'comment-1',
          kind: 'comment',
          visibleText: 'selected text',
          body: 'This comment is long enough to need the collapsed one-line treatment.',
          start: 0,
          end: 13
        }
      ],
      markPositions: { 'comment-1': 24 }
    })

    render(<ReviewRail review={review} />)

    const commentCard = document.querySelector('[data-critic-mark-id="comment-1"]') as HTMLElement

    expect(commentCard).toHaveAttribute('aria-expanded', 'false')
    expect(
      within(commentCard)
        .getByText(/This comment is long/)
        .closest('p')
    ).toHaveClass('critic-review-text-collapsible')

    fireEvent.click(within(commentCard).getByLabelText('Expand review card'))
    expect(commentCard).toHaveAttribute('aria-expanded', 'true')

    fireEvent.click(within(commentCard).getByLabelText('Collapse review card'))
    expect(commentCard).toHaveAttribute('aria-expanded', 'false')
  })

  it('stacks nearby rail cards with a 10px gap from measured card height', async () => {
    const offsetHeightDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'offsetHeight'
    )
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get() {
        return this instanceof HTMLElement && this.classList.contains('critic-review-card') ? 30 : 0
      }
    })

    try {
      const review = createReview({
        marks: [
          {
            id: 'comment-1',
            kind: 'comment',
            visibleText: 'same line',
            body: 'First',
            start: 0,
            end: 9
          },
          {
            id: 'add-1',
            kind: 'addition',
            visibleText: 'same line',
            start: 0,
            end: 9
          },
          {
            id: 'delete-1',
            kind: 'deletion',
            visibleText: 'same line',
            originalText: 'same line',
            start: 0,
            end: 9
          }
        ],
        markPositions: { 'comment-1': 24, 'add-1': 26, 'delete-1': 28 }
      })

      render(<ReviewRail review={review} />)

      const commentCard = document.querySelector('[data-critic-mark-id="comment-1"]')
      const additionCard = document.querySelector('[data-critic-mark-id="add-1"]')
      const deletionCard = document.querySelector('[data-critic-mark-id="delete-1"]')

      await waitFor(() => {
        expect(commentCard).toHaveStyle({ top: '24px' })
        expect(additionCard).toHaveStyle({ top: '64px' })
        expect(deletionCard).toHaveStyle({ top: '104px' })
      })
    } finally {
      if (offsetHeightDescriptor) {
        Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeightDescriptor)
      } else {
        delete (HTMLElement.prototype as { offsetHeight?: number }).offsetHeight
      }
    }
  })

  it('renders an inline comment composer row and submits an active draft', async () => {
    const user = userEvent.setup()
    const review = createReview({
      activeDraft: { text: 'draft target' }
    })

    const { container } = render(<ReviewRail review={review} />)

    const composerRow = container.querySelector('.critic-comment-main-row') as HTMLElement
    expect(composerRow).not.toBeNull()
    expect(within(composerRow).getByLabelText('comments.commentPlaceholder')).toBeInTheDocument()
    expect(
      within(composerRow).getByRole('button', { name: 'comments.attachAria' })
    ).toBeInTheDocument()
    expect(
      within(composerRow).getByRole('button', { name: 'comments.mentionAria' })
    ).toBeInTheDocument()
    expect(
      within(composerRow).getByRole('button', { name: 'comments.sendAria' })
    ).toBeInTheDocument()
    expect(screen.queryByText('comments.cancel')).not.toBeInTheDocument()

    await user.type(screen.getByLabelText('comments.commentPlaceholder'), 'Draft body')
    await user.click(screen.getByLabelText('comments.sendAria'))
    expect(review.submitComment).toHaveBeenCalledWith({
      body: 'Draft body',
      mentions: [],
      attachments: [],
      formatRanges: []
    })
  })

  it('opens the mention picker from the "@" button even after typing a word', async () => {
    const user = userEvent.setup()
    const searchQuery = vi.fn().mockResolvedValue({
      groups: [
        {
          type: 'note',
          totalInGroup: 1,
          results: [
            {
              id: 'note-42',
              type: 'note',
              title: 'Planning note',
              snippet: '',
              score: 1,
              normalizedScore: 1,
              matchType: 'title',
              modifiedAt: '2026-05-10T00:00:00.000Z',
              metadata: { type: 'note', path: '/Planning note', tags: [], emoji: '📝' }
            }
          ]
        }
      ],
      totalCount: 1,
      queryTimeMs: 0
    })
    vi.mocked(window.api.search.query).mockImplementation(searchQuery)
    Object.assign(window.api, {
      calendar: {
        ...((window.api as unknown as { calendar?: Record<string, unknown> }).calendar ?? {}),
        listEvents: vi.fn().mockResolvedValue({ events: [] })
      }
    })

    const review = createReview({ activeDraft: { text: 'draft target' } })
    render(<ReviewRail review={review} />)

    // Type a word first: previously the "@" button inserted a bare "@" after a
    // word, which the mention regex ignored, so no picker opened.
    await user.type(screen.getByLabelText('comments.commentPlaceholder'), 'hello')
    await user.click(screen.getByRole('button', { name: 'comments.mentionAria' }))

    const listbox = await screen.findByRole('listbox')
    // Portalled to document.body so the review flyout's overflow cannot clip it.
    expect(listbox.getAttribute('data-ref-picker')).toBe('')
    expect(listbox.parentElement).toBe(document.body)
    expect(await within(listbox).findByText('Planning note')).toBeInTheDocument()
  })

  it('edits a comment card inline and saves through updateComment', async () => {
    const user = userEvent.setup()
    const review = createReview({
      marks: [
        {
          id: 'comment-1',
          kind: 'comment',
          visibleText: 'target',
          body: 'Original body @Planning note',
          mentions: [{ kind: 'note', refId: 'note-1', label: 'Planning note' }],
          attachments: [
            {
              id: 'attachments/note-1/spec.pdf',
              name: 'spec.pdf',
              path: 'attachments/note-1/spec.pdf',
              type: 'file'
            }
          ],
          start: 0,
          end: 6
        }
      ]
    })

    const { container } = render(<ReviewRail review={review} targetId="note-1" />)

    await user.click(screen.getByRole('button', { name: 'comments.edit' }))

    const card = container.querySelector('[data-critic-mark-id="comment-1"]')
    expect(card).toHaveAttribute('data-editing', 'true')
    expect(card?.querySelector('.critic-review-content')).not.toBeInTheDocument()

    const editorElement = await screen.findByLabelText('comments.commentPlaceholder')
    expect(editorElement).toHaveTextContent('Original body')
    expect(editorElement).toHaveTextContent('@Planning note')
    expect(screen.getByText('spec.pdf')).toBeInTheDocument()
    await waitFor(() => expect(editorElement).toHaveFocus())

    await user.keyboard(' more')
    await user.click(screen.getByLabelText('comments.sendAria'))

    expect(review.updateComment).toHaveBeenCalledWith('comment-1', {
      body: 'Original body @Planning note more',
      mentions: [{ kind: 'note', refId: 'note-1', label: 'Planning note' }],
      attachments: [expect.objectContaining({ path: 'attachments/note-1/spec.pdf' })],
      formatRanges: []
    })
    expect(screen.queryByLabelText('comments.commentPlaceholder')).not.toBeInTheDocument()
  })

  it('cancels comment editing with Escape without saving', async () => {
    const user = userEvent.setup()
    const review = createReview({
      marks: [
        {
          id: 'comment-1',
          kind: 'comment',
          visibleText: 'target',
          body: 'Original body',
          start: 0,
          end: 6
        }
      ]
    })

    render(<ReviewRail review={review} />)

    await user.click(screen.getByRole('button', { name: 'comments.edit' }))
    const editorElement = await screen.findByLabelText('comments.commentPlaceholder')
    await waitFor(() => expect(editorElement).toHaveFocus())
    await user.keyboard('{Escape}')

    expect(review.updateComment).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('comments.commentPlaceholder')).not.toBeInTheDocument()
    expect(screen.getByText('Original body')).toBeInTheDocument()
  })

  it('positions the active comment draft from the selected text top', () => {
    const review = createReview({
      activeDraft: { text: 'draft target', top: 88 }
    })

    const { container } = render(<ReviewRail review={review} />)

    expect(container.querySelector('.critic-review-draft')).toHaveStyle({ top: '88px' })
  })

  it('subtracts the rail origin offset from marquee-zone-relative mark tops', async () => {
    // Mark/draft tops are measured from the `.marquee-zone` top, but the rail
    // renders inside `.review-canvas-rail`, whose origin sits lower (canvas
    // padding). Cards must subtract that offset to stay flat with the ref line.
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        const top = this.classList.contains('review-rail-inner') ? 24 : 0
        return {
          top,
          bottom: top,
          height: 0,
          left: 0,
          right: 0,
          width: 0,
          x: 0,
          y: top,
          toJSON: () => ({})
        } as DOMRect
      })
    const zone = document.createElement('div')
    zone.className = 'marquee-zone'
    document.body.appendChild(zone)

    try {
      const review = createReview({
        marks: [
          {
            id: 'comment-1',
            kind: 'comment',
            visibleText: 'target',
            body: 'Body',
            start: 0,
            end: 6
          }
        ],
        markPositions: { 'comment-1': 124 },
        activeDraft: { text: 'draft target', top: 88 }
      })

      const { container } = render(<ReviewRail review={review} />, { container: zone })

      await waitFor(() => {
        expect(container.querySelector('[data-critic-mark-id="comment-1"]')).toHaveStyle({
          top: '100px'
        })
        expect(container.querySelector('.critic-review-draft')).toHaveStyle({ top: '64px' })
      })
    } finally {
      rectSpy.mockRestore()
      zone.remove()
    }
  })

  it('focuses the active comment draft input when the composer opens', async () => {
    const review = createReview({
      activeDraft: { text: 'draft target' }
    })

    render(<ReviewRail review={review} />)

    await waitFor(() => {
      expect(screen.getByLabelText('comments.commentPlaceholder')).toHaveFocus()
    })
  })

  it('cancels an empty comment draft when focus moves outside', async () => {
    const user = userEvent.setup()
    const review = createReview({
      activeDraft: { text: 'draft target' }
    })

    render(
      <>
        <button type="button">outside target</button>
        <ReviewRail review={review} />
      </>
    )

    await nextFrame()
    await user.click(screen.getByText('outside target'))

    expect(review.cancelCommentDraft).toHaveBeenCalledTimes(1)
  })

  it('does not auto-cancel a non-empty comment draft', async () => {
    const user = userEvent.setup()
    const review = createReview({
      activeDraft: { text: 'draft target' }
    })

    render(
      <>
        <button type="button">outside target</button>
        <ReviewRail review={review} />
      </>
    )

    const input = screen.getByLabelText('comments.commentPlaceholder')
    await user.type(input, 'Keep this')
    await user.keyboard('{Escape}')
    await user.click(screen.getByText('outside target'))

    expect(review.cancelCommentDraft).not.toHaveBeenCalled()
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
      ],
      formatRanges: []
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

  it('renders creation dates on comment cards and omits them when missing', () => {
    const review = createReview({
      marks: [
        {
          id: 'comment-dated',
          kind: 'comment',
          visibleText: 'dated text',
          body: 'Dated comment',
          createdAt: new Date(2026, 4, 26, 12, 3, 42).getTime(),
          start: 0,
          end: 10
        },
        {
          id: 'comment-undated',
          kind: 'comment',
          visibleText: 'undated text',
          body: 'Undated comment',
          start: 11,
          end: 23
        }
      ]
    })

    const { container } = render(<ReviewRail review={review} />)

    const dates = container.querySelectorAll('.critic-review-date')
    expect(dates).toHaveLength(1)
    expect(dates[0]).toHaveTextContent('26 May')
  })

  it('undoes submitted, resolved, and deleted comments', () => {
    const { result } = renderHook(() =>
      useCriticMarkupReview({ markdown: 'comment target', onMarkdownChange: vi.fn() })
    )

    act(() => {
      result.current.openCommentComposer({ text: 'comment target', isEmpty: false, top: 72 })
    })
    expect(result.current.activeDraft).toMatchObject({ text: 'comment target', top: 72 })

    act(() => {
      result.current.submitComment({
        body: 'Needs work',
        mentions: [],
        attachments: [],
        formatRanges: []
      })
    })

    act(() => {
      expect(result.current.undoLastReviewAction()).toBe(true)
    })
    expect(result.current.marks).toHaveLength(0)

    act(() => {
      result.current.openCommentComposer({ text: 'comment target', isEmpty: false })
    })
    act(() => {
      result.current.submitComment({
        body: 'Needs work',
        mentions: [],
        attachments: [],
        formatRanges: []
      })
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

  it('anchors a comment to the selected occurrence, not the first matching text', () => {
    const { result } = renderHook(() =>
      useCriticMarkupReview({
        markdown: 'Mobile first\n\nMobile second',
        onMarkdownChange: vi.fn()
      })
    )

    // Identity doc: ProseMirror positions map 1:1 to visible-text offsets.
    const visible = 'Mobile first\nMobile second'
    act(() => {
      result.current.handleEditorReady({
        _tiptapEditor: {
          state: {
            doc: {
              content: { size: visible.length },
              textBetween: (from: number, to: number) => visible.slice(from, to)
            }
          }
        }
      })
    })

    // Select the second "Mobile" (visible offsets 13-19)
    act(() => {
      result.current.openCommentComposer({ text: 'Mobile', isEmpty: false, from: 13, to: 19 })
    })
    act(() => {
      result.current.submitComment({
        body: 'Needs work',
        mentions: [],
        attachments: [],
        formatRanges: []
      })
    })

    // Source offset 14: the "\n\n" run collapses to one visible "\n"
    expect(result.current.marks[0]).toMatchObject({ kind: 'comment', start: 14, end: 20 })
  })

  it('anchors a comment without selection positions to the first matching text', () => {
    const { result } = renderHook(() =>
      useCriticMarkupReview({
        markdown: 'Mobile first\n\nMobile second',
        onMarkdownChange: vi.fn()
      })
    )

    act(() => {
      result.current.openCommentComposer({ text: 'Mobile', isEmpty: false })
    })
    act(() => {
      result.current.submitComment({
        body: 'Needs work',
        mentions: [],
        attachments: [],
        formatRanges: []
      })
    })

    expect(result.current.marks[0]).toMatchObject({ kind: 'comment', start: 0, end: 6 })
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
        ],
        formatRanges: []
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

  it('updates an existing comment and undoes the edit', () => {
    const onMarkdownChange = vi.fn()
    const { result } = renderHook(() =>
      useCriticMarkupReview({ markdown: 'comment target', onMarkdownChange })
    )

    act(() => {
      result.current.openCommentComposer({ text: 'comment target', isEmpty: false })
    })
    act(() => {
      result.current.submitComment({
        body: 'Needs work',
        mentions: [{ kind: 'note', refId: 'note-1', label: 'Planning note' }],
        attachments: [],
        formatRanges: []
      })
    })
    const commentId = result.current.marks[0].id

    act(() => {
      result.current.updateComment(commentId, {
        body: '  Needs more work  ',
        mentions: [],
        attachments: [
          {
            id: 'attachments/note-1/spec.pdf',
            name: 'spec.pdf',
            path: 'attachments/note-1/spec.pdf',
            type: 'file'
          }
        ],
        formatRanges: []
      })
    })

    expect(result.current.marks[0]).toMatchObject({
      id: commentId,
      kind: 'comment',
      body: 'Needs more work',
      attachments: [expect.objectContaining({ path: 'attachments/note-1/spec.pdf' })]
    })
    // An edit always writes all three structured keys, so an emptied one is
    // cleared from the file instead of being stranded there.
    expect(result.current.marks[0].mentions).toEqual([])
    expect(onMarkdownChange).toHaveBeenLastCalledWith(expect.stringContaining('attachments='))
    expect(onMarkdownChange).toHaveBeenLastCalledWith(expect.not.stringContaining('mentions='))

    act(() => {
      expect(result.current.undoLastReviewAction()).toBe(true)
    })
    expect(result.current.marks[0]).toMatchObject({
      body: 'Needs work',
      mentions: [{ kind: 'note', refId: 'note-1', label: 'Planning note' }]
    })
    expect(result.current.marks[0].attachments).toBeUndefined()
  })

  it('ignores comment updates for unknown ids or empty bodies', () => {
    const onMarkdownChange = vi.fn()
    const { result } = renderHook(() =>
      useCriticMarkupReview({ markdown: 'comment target', onMarkdownChange })
    )

    act(() => {
      result.current.openCommentComposer({ text: 'comment target', isEmpty: false })
    })
    act(() => {
      result.current.submitComment({
        body: 'Needs work',
        mentions: [],
        attachments: [],
        formatRanges: []
      })
    })
    const commentId = result.current.marks[0].id
    onMarkdownChange.mockClear()

    act(() => {
      result.current.updateComment('missing-id', {
        body: 'x',
        mentions: [],
        attachments: [],
        formatRanges: []
      })
      result.current.updateComment(commentId, {
        body: '   ',
        mentions: [],
        attachments: [],
        formatRanges: []
      })
    })

    expect(onMarkdownChange).not.toHaveBeenCalled()
    expect(result.current.marks[0]).toMatchObject({ body: 'Needs work' })
  })

  it('handles Mod+Z through the review undo stack before native editor undo', () => {
    const { result } = renderHook(() =>
      useCriticMarkupReview({ markdown: 'base', onMarkdownChange: vi.fn() })
    )

    act(() => {
      result.current.openCommentComposer({ text: 'base', isEmpty: false })
    })
    act(() => {
      result.current.submitComment({
        body: 'note',
        mentions: [],
        attachments: [],
        formatRanges: []
      })
    })
    expect(result.current.marks).toHaveLength(1)

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
    expect(result.current.marks).toHaveLength(0)
  })

  it('keeps a locally-added comment when a stale resync lands before save (issue #797)', () => {
    const { result, rerender } = renderHook(
      ({ markdown }: { markdown: string }) =>
        useCriticMarkupReview({ markdown, onMarkdownChange: vi.fn() }),
      { initialProps: { markdown: 'comment target' } }
    )

    act(() => {
      result.current.openCommentComposer({ text: 'comment target', isEmpty: false })
    })
    act(() => {
      result.current.submitComment({
        body: 'Needs work',
        mentions: [],
        attachments: [],
        formatRanges: []
      })
    })
    expect(result.current.marks).toHaveLength(1)
    const commentId = result.current.marks[0].id

    // A refetch/sync delivers still-stale content (lacking the just-added comment)
    // during note.tsx's 1s save debounce. The comment must not be clobbered.
    act(() => {
      rerender({ markdown: 'comment target edited' })
    })
    expect(result.current.marks).toHaveLength(1)
    expect(result.current.marks[0].id).toBe(commentId)
    expect(result.current.marks[0]).toMatchObject({ kind: 'comment', body: 'Needs work' })

    // Once the save round-trips (incoming markdown now reflects the comment),
    // pending clears and normal external resync resumes.
    const persisted = serializeCriticMarkup(result.current.plainMarkdown, result.current.marks)
    act(() => {
      rerender({ markdown: persisted })
    })
    expect(result.current.marks).toHaveLength(1)

    // Guard is scoped to the pending window: a later genuinely-external change
    // is no longer suppressed.
    act(() => {
      rerender({ markdown: 'totally different external content' })
    })
    expect(result.current.marks).toHaveLength(0)
  })

  it('renders comment formatting as nested inline elements, outermost mark first', () => {
    const review = createReview({
      marks: [
        {
          id: 'comment-1',
          kind: 'comment',
          visibleText: 'target',
          body: 'see this now',
          start: 0,
          end: 6,
          formatRanges: [
            { start: 4, end: 8, marks: ['bold', 'code'] },
            { start: 9, end: 12, marks: ['italic'] }
          ]
        }
      ]
    })

    const { container } = render(<ReviewRail review={review} />)
    const body = container.querySelector('.critic-review-body') as HTMLElement

    expect(body).toHaveTextContent('see this now')
    expect(body.querySelector('strong > code')?.textContent).toBe('this')
    expect(body.querySelector('em')?.textContent).toBe('now')
    // Anything not covered by a range stays unwrapped.
    expect(body.querySelector('u')).toBeNull()
  })

  it('renders a comment saved before formatting existed with no mark elements', () => {
    const review = createReview({
      marks: [
        {
          id: 'comment-1',
          kind: 'comment',
          visibleText: 'target',
          body: 'plain 2 * 3 and snake_case_name',
          start: 0,
          end: 6
        }
      ]
    })

    const { container } = render(<ReviewRail review={review} />)
    const body = container.querySelector('.critic-review-body') as HTMLElement

    expect(body).toHaveTextContent('plain 2 * 3 and snake_case_name')
    expect(body.querySelector('strong, em, u, s, code')).toBeNull()
  })

  it('keeps the mention link intact when a format range spans it', () => {
    const review = createReview({
      marks: [
        {
          id: 'comment-1',
          kind: 'comment',
          visibleText: 'target',
          body: 'ping @Planning note now',
          mentions: [{ kind: 'note', refId: 'note-1', label: 'Planning note' }],
          formatRanges: [{ start: 0, end: 23, marks: ['bold'] }],
          start: 0,
          end: 6
        }
      ]
    })

    const { container } = render(<ReviewRail review={review} />)
    const link = container.querySelector('a[href="memry://note/note-1"]') as HTMLElement

    expect(link).not.toBeNull()
    expect(link.textContent).toContain('@Planning note')
    // The mark wraps around the anchor; it never subdivides it.
    expect(link.closest('strong')).not.toBeNull()
    expect(link.querySelector('strong')).toBeNull()
  })

  it('does not cancel an empty draft when the pointer goes down on the format toolbar', async () => {
    const review = createReview({ activeDraft: { text: 'draft target' } })
    render(<ReviewRail review={review} />)
    await nextFrame()

    const toolbar = document.createElement('div')
    toolbar.setAttribute('data-comment-format-toolbar', '')
    document.body.appendChild(toolbar)

    fireEvent.pointerDown(toolbar)
    expect(review.cancelCommentDraft).not.toHaveBeenCalled()

    fireEvent.pointerDown(document.body)
    expect(review.cancelCommentDraft).toHaveBeenCalled()

    toolbar.remove()
  })
})
