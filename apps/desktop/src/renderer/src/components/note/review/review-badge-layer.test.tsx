import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReviewBadgeLayer } from './review-badge-layer'
import type { CriticMarkupReviewController } from './use-critic-markup-review'

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

vi.mock('@/services/notes-service', () => ({
  notesService: { uploadAttachment: vi.fn() }
}))

let editorContainer: HTMLDivElement

beforeEach(() => {
  vi.clearAllMocks()
  document.getElementById('critic-mark-hover-style')?.remove()
  editorContainer = document.createElement('div')
  editorContainer.innerHTML = `
    <div class="bn-block" data-id="block-1">
      <div class="bn-block-content">
        <span data-critic-mark-kind="comment" data-critic-mark-id="comment-1">selected text</span>
        <span data-critic-mark-kind="addition" data-critic-mark-id="add-1">new text</span>
      </div>
    </div>
    <div class="bn-block" data-id="block-2">
      <div class="bn-block-content">
        <span data-critic-mark-kind="deletion" data-critic-mark-id="delete-1">old text</span>
      </div>
    </div>`
  document.body.appendChild(editorContainer)
})

afterEach(() => {
  editorContainer.remove()
})

function createReview(
  overrides: Partial<CriticMarkupReviewController> = {}
): CriticMarkupReviewController {
  return {
    editorInitialContent: '',
    plainMarkdown: '',
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

function renderLayer(review: CriticMarkupReviewController, active = true) {
  return render(
    <ReviewBadgeLayer
      review={review}
      targetId="note-1"
      containerRef={{ current: editorContainer }}
      active={active}
    />
  )
}

async function findBadges(): Promise<HTMLElement[]> {
  await waitFor(() => {
    expect(screen.getAllByLabelText('comments.badgeAria').length).toBeGreaterThan(0)
  })
  return screen.getAllByLabelText('comments.badgeAria')
}

describe('ReviewBadgeLayer', () => {
  it('renders nothing when inactive', async () => {
    const { container } = renderLayer(createReview(), false)

    await new Promise((resolve) => requestAnimationFrame(resolve))
    expect(container.querySelector('.critic-review-badge')).not.toBeInTheDocument()
  })

  it('renders one badge per block with the aggregated mark count', async () => {
    renderLayer(createReview())

    const badges = await findBadges()
    expect(badges).toHaveLength(2)
    expect(within(badges[0]).getByText('2')).toBeInTheDocument()
    expect(within(badges[1]).getByText('1')).toBeInTheDocument()
  })

  it('skips marks the controller no longer knows about', async () => {
    const review = createReview({
      marks: [
        {
          id: 'delete-1',
          kind: 'deletion',
          visibleText: 'old text',
          originalText: 'old text',
          start: 23,
          end: 31
        }
      ]
    })
    renderLayer(review)

    const badges = await findBadges()
    expect(badges).toHaveLength(1)
    expect(within(badges[0]).getByText('1')).toBeInTheDocument()
  })

  it('opens a flyout with review cards on badge click and drives controller actions', async () => {
    const review = createReview()
    renderLayer(review)

    const badges = await findBadges()
    fireEvent.click(badges[0])

    const flyout = document.querySelector<HTMLElement>('.critic-review-flyout') as HTMLElement
    expect(flyout).not.toBeNull()
    const commentCard = flyout.querySelector<HTMLElement>(
      '[data-critic-mark-id="comment-1"]'
    ) as HTMLElement
    const additionCard = flyout.querySelector<HTMLElement>(
      '[data-critic-mark-id="add-1"]'
    ) as HTMLElement
    expect(commentCard).not.toBeNull()
    expect(additionCard).not.toBeNull()
    expect(within(commentCard).getByText('Needs a source')).toBeInTheDocument()

    fireEvent.click(within(commentCard).getByLabelText('comments.resolve'))
    expect(review.resolveMark).toHaveBeenCalledWith('comment-1')
  })

  it('toggles the flyout closed when the open badge is clicked again', async () => {
    renderLayer(createReview())

    const badges = await findBadges()
    fireEvent.click(badges[0])
    expect(document.querySelector('.critic-review-flyout')).not.toBeNull()

    fireEvent.click(badges[0])
    expect(document.querySelector('.critic-review-flyout')).toBeNull()
  })

  it('opens the flyout under clicked marked text, showing only the clicked mark', async () => {
    renderLayer(createReview())
    await findBadges()

    const span = editorContainer.querySelector('[data-critic-mark-id="comment-1"]') as HTMLElement
    fireEvent.click(span)

    const flyout = document.querySelector<HTMLElement>('.critic-review-flyout') as HTMLElement
    expect(flyout).not.toBeNull()
    expect(flyout.querySelector('[data-critic-mark-id="comment-1"]')).not.toBeNull()
    expect(flyout.querySelector('[data-critic-mark-id="add-1"]')).toBeNull()
    expect(flyout.querySelector('[data-critic-mark-id="delete-1"]')).toBeNull()
  })

  it('lists every mark in the block when the badge is clicked after a text click', async () => {
    renderLayer(createReview())

    const badges = await findBadges()
    fireEvent.click(
      editorContainer.querySelector('[data-critic-mark-id="comment-1"]') as HTMLElement
    )
    expect(document.querySelector('.critic-review-flyout [data-critic-mark-id="add-1"]')).toBeNull()

    fireEvent.click(badges[0])
    const flyout = document.querySelector<HTMLElement>('.critic-review-flyout') as HTMLElement
    expect(flyout.querySelector('[data-critic-mark-id="comment-1"]')).not.toBeNull()
    expect(flyout.querySelector('[data-critic-mark-id="add-1"]')).not.toBeNull()
  })

  it('does not open the flyout from text clicks when inactive', async () => {
    renderLayer(createReview(), false)

    await new Promise((resolve) => requestAnimationFrame(resolve))
    fireEvent.click(
      editorContainer.querySelector('[data-critic-mark-id="comment-1"]') as HTMLElement
    )
    expect(document.querySelector('.critic-review-flyout')).toBeNull()
  })

  it('dismisses the flyout on outside press and on Escape', async () => {
    renderLayer(createReview())
    await findBadges()

    const span = editorContainer.querySelector('[data-critic-mark-id="comment-1"]') as HTMLElement
    fireEvent.click(span)
    expect(document.querySelector('.critic-review-flyout')).not.toBeNull()

    fireEvent.pointerDown(document.body)
    expect(document.querySelector('.critic-review-flyout')).toBeNull()

    fireEvent.click(span)
    expect(document.querySelector('.critic-review-flyout')).not.toBeNull()

    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(document.querySelector('.critic-review-flyout')).toBeNull()
  })

  it('hosts the comment composer in a flyout under the drafted selection', async () => {
    const review = createReview({
      activeDraft: { text: 'selected text' },
      getActiveDraftSelectionRect: vi.fn(() => ({ top: 10, bottom: 30, left: 0, right: 40 }))
    })
    const { rerender } = renderLayer(review)

    const flyout = await waitFor(() => {
      const element = document.querySelector<HTMLElement>('.critic-review-flyout')
      expect(element).not.toBeNull()
      return element as HTMLElement
    })
    expect(flyout).toHaveStyle({ top: '34px' })
    expect(within(flyout).getByLabelText('comments.commentPlaceholder')).toBeInTheDocument()

    // Giving up the draft removes the flyout again.
    rerender(
      <ReviewBadgeLayer
        review={createReview({ activeDraft: null })}
        targetId="note-1"
        containerRef={{ current: editorContainer }}
        active
      />
    )
    await waitFor(() => {
      expect(screen.queryByLabelText('comments.commentPlaceholder')).not.toBeInTheDocument()
    })
  })

  it('renders the draft flyout even when no marks exist yet', async () => {
    const review = createReview({
      marks: [],
      activeDraft: { text: 'selected text', top: 50 }
    })
    renderLayer(review)

    await waitFor(() => {
      expect(screen.getByLabelText('comments.commentPlaceholder')).toBeInTheDocument()
    })
    expect(document.querySelector('.critic-review-badge')).toBeNull()
  })

  it('paints the drafted selection via the CSS highlight registry and clears it on cancel', async () => {
    const highlightRegistry = new Map<string, unknown>()
    const cssGlobal = globalThis.CSS as unknown as { highlights?: unknown }
    const previousHighlights = cssGlobal.highlights
    const highlightGlobal = globalThis as { Highlight?: unknown }
    const previousHighlight = highlightGlobal.Highlight
    cssGlobal.highlights = highlightRegistry
    highlightGlobal.Highlight = class {
      constructor(public range: Range) {}
    }

    try {
      const range = document.createRange()
      range.selectNodeContents(
        editorContainer.querySelector('[data-critic-mark-id="comment-1"]') as HTMLElement
      )
      const review = createReview({
        activeDraft: { text: 'selected text' },
        getActiveDraftDomRange: vi.fn(() => range)
      })
      const { rerender } = renderLayer(review)

      await waitFor(() => {
        expect(highlightRegistry.has('critic-comment-draft')).toBe(true)
      })

      rerender(
        <ReviewBadgeLayer
          review={createReview({ activeDraft: null })}
          targetId="note-1"
          containerRef={{ current: editorContainer }}
          active
        />
      )
      await waitFor(() => {
        expect(highlightRegistry.has('critic-comment-draft')).toBe(false)
      })
    } finally {
      cssGlobal.highlights = previousHighlights
      highlightGlobal.Highlight = previousHighlight
    }
  })

  it('links badge hover to the inline mark highlight', async () => {
    const review = createReview()
    renderLayer(review)

    const badges = await findBadges()
    const inlineMark = editorContainer.querySelector(
      '[data-critic-mark-id="comment-1"]'
    ) as HTMLElement

    fireEvent.pointerEnter(badges[0])
    expect(review.setHoveredMarkId).toHaveBeenCalledWith('comment-1')
    expect(inlineMark).toHaveClass('critic-mark-hovered')

    fireEvent.pointerLeave(badges[0])
    expect(review.setHoveredMarkId).toHaveBeenCalledWith(null)
    expect(inlineMark).not.toHaveClass('critic-mark-hovered')
  })
})
