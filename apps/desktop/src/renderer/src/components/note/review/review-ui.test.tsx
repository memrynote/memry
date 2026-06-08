import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ReviewRail } from './review-rail'
import { SuggestionModePill } from './suggestion-mode-pill'
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
    isSuggestionModeActive: false,
    handlePlainMarkdownChange: vi.fn((markdown: string) => markdown),
    persistCurrentMarkdown: vi.fn(),
    handleEditorReady: vi.fn(),
    openCommentComposer: vi.fn(),
    cancelCommentDraft: vi.fn(),
    getActiveDraftSelectionRect: vi.fn(() => null),
    getActiveDraftDomRange: vi.fn(() => null),
    submitComment: vi.fn(),
    updateComment: vi.fn(),
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

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

describe('review UI', () => {
  it('moves rail cards left on hover with a theme-owned background token', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/renderer/src/assets/base.css'), 'utf8')
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
    expect(css).toContain('.critic-review-suggestion-label-addition')
    expect(css).toContain(
      'color: color-mix(in srgb, rgb(39, 131, 222) 40%, var(--muted-foreground))'
    )
    expect(css).toContain('color: rgb(39, 131, 222)')
    expect(css).toContain('color: var(--muted-foreground)')
    expect(css).toContain('.critic-review-text-collapsible')
    expect(css).toContain('text-overflow: ellipsis')
    expect(css).toContain(
      ".critic-review-card[data-expanded='true'] .critic-review-text-collapsible"
    )
    expect(css).toContain('.critic-comment-main-row')
    expect(css).toContain('display: flex')
    expect(css).toContain('.critic-comment-editor .ProseMirror')
    expect(css).toContain(".critic-review-card[data-editing='true']")
  })

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
        },
        {
          id: 'delete-1',
          kind: 'deletion',
          visibleText: 'old text',
          originalText: 'old text',
          start: 23,
          end: 31
        }
      ],
      markPositions: { 'comment-1': 24, 'add-1': 160, 'delete-1': 296 }
    })

    render(<ReviewRail review={review} />)

    expect(screen.getByLabelText('comments.railAria')).toBeInTheDocument()
    expect(screen.getByText('Needs a source')).toBeInTheDocument()
    expect(screen.queryByText('selected text')).not.toBeInTheDocument()
    expect(screen.queryByText('comments.kind.comment')).not.toBeInTheDocument()
    expect(screen.queryByText('comments.kind.addition')).not.toBeInTheDocument()
    expect(screen.queryByText('comments.kind.deletion')).not.toBeInTheDocument()

    const additionCard = document.querySelector('[data-critic-mark-id="add-1"]') as HTMLElement
    expect(within(additionCard).getByText('Add:')).toHaveClass(
      'critic-review-suggestion-label-addition'
    )
    expect(within(additionCard).getByText('“new text”')).toHaveClass(
      'critic-review-suggestion-text-addition'
    )

    const deletionCard = document.querySelector('[data-critic-mark-id="delete-1"]') as HTMLElement
    expect(within(deletionCard).getByText('Delete:')).toHaveClass(
      'critic-review-suggestion-label-deletion'
    )
    expect(within(deletionCard).getByText('“old text”')).toHaveClass(
      'critic-review-suggestion-text-deletion'
    )

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

    expect(screen.queryByText('comments.resolve')).not.toBeInTheDocument()
    expect(screen.queryByText('comments.accept')).not.toBeInTheDocument()
    expect(screen.queryByText('comments.reject')).not.toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('comments.resolve'))
    expect(review.resolveMark).toHaveBeenCalledWith('comment-1')

    fireEvent.click(within(additionCard).getByLabelText('comments.accept'))
    expect(review.acceptMark).toHaveBeenCalledWith('add-1')

    fireEvent.click(within(additionCard).getByLabelText('comments.reject'))
    expect(review.rejectMark).toHaveBeenCalledWith('add-1')
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
        },
        {
          id: 'delete-1',
          kind: 'deletion',
          visibleText: 'old text that is long enough to overflow the compact rail card',
          originalText: 'old text that is long enough to overflow the compact rail card',
          start: 14,
          end: 77
        }
      ],
      markPositions: { 'comment-1': 24, 'delete-1': 160 }
    })

    render(<ReviewRail review={review} />)

    const commentCard = document.querySelector('[data-critic-mark-id="comment-1"]') as HTMLElement
    const deletionCard = document.querySelector('[data-critic-mark-id="delete-1"]') as HTMLElement

    expect(commentCard).toHaveAttribute('aria-expanded', 'false')
    expect(deletionCard).toHaveAttribute('aria-expanded', 'false')
    expect(
      within(commentCard)
        .getByText(/This comment is long/)
        .closest('p')
    ).toHaveClass('critic-review-text-collapsible')
    expect(
      within(deletionCard)
        .getByText(/Delete:/)
        .closest('p')
    ).toHaveClass('critic-review-text-collapsible')

    fireEvent.click(within(deletionCard).getByLabelText('Expand review card'))
    expect(deletionCard).toHaveAttribute('aria-expanded', 'true')

    fireEvent.click(within(deletionCard).getByLabelText('comments.accept'))
    expect(review.acceptMark).toHaveBeenCalledWith('delete-1')
    expect(deletionCard).toHaveAttribute('aria-expanded', 'true')

    fireEvent.click(within(deletionCard).getByLabelText('Collapse review card'))
    expect(deletionCard).toHaveAttribute('aria-expanded', 'false')
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
      attachments: []
    })
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
      attachments: [expect.objectContaining({ path: 'attachments/note-1/spec.pdf' })]
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

  it('does not offer editing on suggestion cards', () => {
    const review = createReview({
      marks: [
        {
          id: 'addition-1',
          kind: 'addition',
          visibleText: 'added text',
          start: 0,
          end: 10
        }
      ]
    })

    render(<ReviewRail review={review} />)

    expect(screen.queryByRole('button', { name: 'comments.edit' })).not.toBeInTheDocument()
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

  it('renders creation dates on comment and suggestion cards and omits them when missing', () => {
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
        },
        {
          id: 'addition-dated',
          kind: 'addition',
          visibleText: 'new text',
          createdAt: new Date(2026, 5, 2, 9, 30, 0).getTime(),
          start: 24,
          end: 32
        },
        {
          id: 'addition-undated',
          kind: 'addition',
          visibleText: 'older text',
          start: 33,
          end: 43
        }
      ]
    })

    const { container } = render(<ReviewRail review={review} />)

    const dates = container.querySelectorAll('.critic-review-date')
    expect(dates).toHaveLength(2)
    expect(dates[0]).toHaveTextContent('26 May')
    expect(dates[1]).toHaveTextContent('2 Jun')
  })

  it('keeps suggestion createdAt when its own serialized markdown round-trips', () => {
    let markdown = 'Hello world'
    const onMarkdownChange = vi.fn((next: string) => {
      markdown = next
    })
    const { result, rerender } = renderHook(
      ({ md }) => useCriticMarkupReview({ markdown: md, onMarkdownChange }),
      { initialProps: { md: markdown } }
    )

    act(() => {
      result.current.addSuggestionMark({
        kind: 'deletion',
        visibleText: 'world',
        originalText: 'world',
        start: 6
      })
    })

    const createdAt = result.current.marks[0]?.createdAt
    expect(createdAt).toEqual(expect.any(Number))

    // Parent echoes the emitted markdown back as the prop (save round-trip).
    rerender({ md: markdown })

    expect(result.current.marks[0]?.createdAt).toBe(createdAt)
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

  it('keeps edits inside an active addition as one addition suggestion', () => {
    const { result } = renderHook(() =>
      useCriticMarkupReview({ markdown: 'base', onMarkdownChange: vi.fn() })
    )

    act(() => {
      result.current.startSuggestionMode()
    })
    act(() => {
      result.current.addSuggestionMark({
        kind: 'addition',
        visibleText: 'car needs to repait',
        start: 4
      })
    })

    let afterDelete = ''
    act(() => {
      afterDelete = result.current.handlePlainMarkdownChange('basecar needs to repai')
    })

    expect(result.current.marks).toHaveLength(1)
    expect(result.current.marks[0]).toMatchObject({
      kind: 'addition',
      visibleText: 'car needs to repai',
      start: 4,
      end: 22
    })
    expect(afterDelete).toBe('base{++car needs to repai++}')

    let afterRetype = ''
    act(() => {
      afterRetype = result.current.handlePlainMarkdownChange('basecar needs to repair')
    })

    expect(result.current.marks).toHaveLength(1)
    expect(result.current.marks[0]).toMatchObject({
      kind: 'addition',
      visibleText: 'car needs to repair',
      start: 4,
      end: 23
    })
    expect(afterRetype).toBe('base{++car needs to repair++}')
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
      result.current.openCommentComposer({ text: 'comment target', isEmpty: false, top: 72 })
    })
    expect(result.current.activeDraft).toMatchObject({ text: 'comment target', top: 72 })

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
      result.current.submitComment({ body: 'Needs work', mentions: [], attachments: [] })
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
      result.current.submitComment({ body: 'Needs work', mentions: [], attachments: [] })
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
        attachments: []
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
        ]
      })
    })

    expect(result.current.marks[0]).toMatchObject({
      id: commentId,
      kind: 'comment',
      body: 'Needs more work',
      attachments: [expect.objectContaining({ path: 'attachments/note-1/spec.pdf' })]
    })
    expect(result.current.marks[0].mentions).toBeUndefined()
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

  it('ignores comment updates for unknown ids, suggestion marks, or empty bodies', () => {
    const onMarkdownChange = vi.fn()
    const { result } = renderHook(() =>
      useCriticMarkupReview({ markdown: 'comment target', onMarkdownChange })
    )

    act(() => {
      result.current.openCommentComposer({ text: 'comment target', isEmpty: false })
    })
    act(() => {
      result.current.submitComment({ body: 'Needs work', mentions: [], attachments: [] })
    })
    const commentId = result.current.marks[0].id
    act(() => {
      result.current.addSuggestionMark({ kind: 'deletion', visibleText: 'comment', start: 0 })
    })
    const suggestionId = result.current.marks[1].id
    onMarkdownChange.mockClear()

    act(() => {
      result.current.updateComment('missing-id', { body: 'x', mentions: [], attachments: [] })
      result.current.updateComment(suggestionId, { body: 'x', mentions: [], attachments: [] })
      result.current.updateComment(commentId, { body: '   ', mentions: [], attachments: [] })
    })

    expect(onMarkdownChange).not.toHaveBeenCalled()
    expect(result.current.marks[0]).toMatchObject({ body: 'Needs work' })
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
