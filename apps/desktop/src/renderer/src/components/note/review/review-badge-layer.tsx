import { useCallback, useEffect, useLayoutEffect, useMemo, useState, type RefObject } from 'react'
import { MessageCircle } from '@/lib/icons'
import type { CriticMarkupReviewController } from './use-critic-markup-review'
import { useT } from '@memry/i18n/renderer'
import { CommentComposer } from './comment-composer'
import { ReviewCard } from './review-card'
import { syncInlineHoverClass } from './inline-hover'

interface ReviewBadgeLayerProps {
  review: CriticMarkupReviewController
  targetId?: string
  /** Editor container the inline mark spans live in; badges position relative to it. */
  containerRef: RefObject<HTMLElement | null>
  /** True when the review rail is hidden and badges should take over. */
  active: boolean
}

interface BadgeGroup {
  blockId: string
  markIds: string[]
  top: number
  insetInlineStart: number
}

interface PanelState {
  blockId: string
  /** Marks shown in the flyout: the whole block for badge clicks, just the clicked mark for text clicks. */
  markIds: string[]
  source: 'badge' | 'text'
  top: number
  insetInlineStart: number
}

const BADGE_INLINE_GAP = 6
const PANEL_WIDTH = 340
const PANEL_ANCHOR_GAP = 4
const DRAFT_HIGHLIGHT_NAME = 'critic-comment-draft'

/**
 * Fallback for narrow windows: when the review rail no longer
 * fits, each block containing review marks gets an inline badge (icon +
 * count) at its logical end. Clicking the badge or the marked text opens a
 * flyout panel under the anchor listing the block's review cards.
 */
export function ReviewBadgeLayer({
  review,
  targetId,
  containerRef,
  active
}: ReviewBadgeLayerProps) {
  const { t } = useT('notes')
  const [groups, setGroups] = useState<BadgeGroup[]>([])
  const [panel, setPanel] = useState<PanelState | null>(null)
  const [draftPanel, setDraftPanel] = useState<{
    top: number
    insetInlineStart: number
  } | null>(null)
  const [expandedMarkIds, setExpandedMarkIds] = useState<Set<string>>(() => new Set())
  const [editingMarkId, setEditingMarkId] = useState<string | null>(null)

  const marksById = useMemo(
    () => new Map(review.marks.map((mark) => [mark.id, mark])),
    [review.marks]
  )

  const openPanelForAnchor = useCallback(
    (blockId: string, markIds: string[], source: 'badge' | 'text', anchorElement: HTMLElement) => {
      const container = containerRef.current
      if (!container) return
      const containerRect = container.getBoundingClientRect()
      const anchorRect = anchorElement.getBoundingClientRect()
      const isRtl = getComputedStyle(container).direction === 'rtl'
      const rawStart = isRtl
        ? containerRect.right - anchorRect.right
        : anchorRect.left - containerRect.left
      const maxStart = Math.max(0, containerRect.width - PANEL_WIDTH)
      setPanel({
        blockId,
        markIds,
        source,
        top: anchorRect.bottom - containerRect.top + PANEL_ANCHOR_GAP,
        insetInlineStart: Math.min(Math.max(0, rawStart), maxStart)
      })
    },
    [containerRef]
  )

  useEffect(() => {
    if (!active) return
    const container = containerRef.current
    if (!container) return

    let frame: number | null = null
    const compute = () => {
      frame = null
      const containerRect = container.getBoundingClientRect()
      const isRtl = getComputedStyle(container).direction === 'rtl'
      const byBlock = new Map<string, { blockElement: HTMLElement; markIds: string[] }>()
      const seenMarkIds = new Set<string>()
      container.querySelectorAll<HTMLElement>('[data-critic-mark-id]').forEach((element) => {
        const id = element.dataset.criticMarkId
        if (!id || seenMarkIds.has(id) || !marksById.has(id)) return
        if (element.closest('.critic-review-flyout')) return
        seenMarkIds.add(id)
        const blockElement = element.closest<HTMLElement>('.bn-block[data-id]')
        const blockId = blockElement?.dataset.id
        if (!blockElement || !blockId) return
        const entry = byBlock.get(blockId)
        if (entry) {
          entry.markIds.push(id)
        } else {
          byBlock.set(blockId, { blockElement, markIds: [id] })
        }
      })

      const next: BadgeGroup[] = []
      byBlock.forEach(({ blockElement, markIds }, blockId) => {
        const content =
          blockElement.querySelector<HTMLElement>(':scope > .bn-block-content') ?? blockElement
        const rect = content.getBoundingClientRect()
        next.push({
          blockId,
          markIds,
          top: Math.max(0, rect.top - containerRect.top),
          insetInlineStart: isRtl
            ? containerRect.right - rect.left + BADGE_INLINE_GAP
            : rect.right - containerRect.left + BADGE_INLINE_GAP
        })
      })
      setGroups((previous) => (areBadgeGroupsEqual(previous, next) ? previous : next))
    }
    const schedule = () => {
      if (frame !== null) return
      frame = requestAnimationFrame(compute)
    }

    const observer = new ResizeObserver(schedule)
    observer.observe(container)
    schedule()
    return () => {
      observer.disconnect()
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [active, containerRef, marksById, review.plainMarkdown])

  // Clicking marked text opens the panel right under the clicked span.
  useEffect(() => {
    if (!active) return
    const container = containerRef.current
    if (!container) return

    const handleClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      const span = target?.closest<HTMLElement>('[data-critic-mark-id]')
      if (!span || !container.contains(span) || span.closest('.critic-review-flyout')) return
      const markId = span.dataset.criticMarkId
      if (!markId || !marksById.has(markId)) return
      const blockId = span.closest<HTMLElement>('.bn-block[data-id]')?.dataset.id
      if (!blockId) return
      // Text clicks show only the clicked mark; the badge lists the whole block.
      openPanelForAnchor(blockId, [markId], 'text', span)
    }

    container.addEventListener('click', handleClick)
    return () => container.removeEventListener('click', handleClick)
  }, [active, containerRef, marksById, openPanelForAnchor])

  // Dismiss the panel on outside press or Escape (no popover primitive).
  useEffect(() => {
    if (!panel) return

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null
      if (target) {
        if (target.closest('.critic-review-flyout')) return
        if (target.closest('.critic-review-badge')) return
        // The mention picker portals to document.body, outside the flyout.
        if (target.closest('[data-ref-picker]')) return
        const span = target.closest('[data-critic-mark-id]')
        if (span && containerRef.current?.contains(span)) return
      }
      setPanel(null)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      // Let the comment composer consume Escape to cancel editing first.
      if ((event.target as HTMLElement | null)?.closest('.critic-comment-composer')) return
      setPanel(null)
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [containerRef, panel])

  // While the rail is hidden, host the comment composer in a flyout placed
  // under the selected text instead of the (invisible) rail. This positions a
  // flyout from live DOM rects, so it runs as a layout effect (measured before
  // paint, the correct hook for reading geometry).
  useLayoutEffect(() => {
    if (!active || !review.activeDraft) {
      setDraftPanel(null)
      return
    }
    const container = containerRef.current
    if (!container) return
    const containerRect = container.getBoundingClientRect()
    const isRtl = getComputedStyle(container).direction === 'rtl'
    const maxStart = Math.max(0, containerRect.width - PANEL_WIDTH)
    const rect = review.getActiveDraftSelectionRect()
    if (rect) {
      const rawStart = isRtl ? containerRect.right - rect.right : rect.left - containerRect.left
      setDraftPanel({
        top: rect.bottom - containerRect.top + PANEL_ANCHOR_GAP,
        insetInlineStart: Math.min(Math.max(0, rawStart), maxStart)
      })
      return
    }
    // Fallback: the draft's marquee-zone-relative top (same source the rail uses).
    const root = container.closest<HTMLElement>('.marquee-zone') ?? container
    const containerOffset = containerRect.top - root.getBoundingClientRect().top
    setDraftPanel({
      top: Math.max(0, (review.activeDraft.top ?? 0) - containerOffset + 24),
      insetInlineStart: 0
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- review identity changes every render; activeDraft is the trigger
  }, [active, containerRef, review.activeDraft])

  // Paint the drafted selection like an existing comment while composing.
  useEffect(() => {
    if (!active || !review.activeDraft) return
    if (typeof CSS === 'undefined' || !CSS.highlights || typeof Highlight === 'undefined') return
    const range = review.getActiveDraftDomRange()
    if (!range) return
    CSS.highlights.set(DRAFT_HIGHLIGHT_NAME, new Highlight(range))
    return () => {
      CSS.highlights.delete(DRAFT_HIGHLIGHT_NAME)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- review identity changes every render; activeDraft is the trigger
  }, [active, review.activeDraft])

  // Mirror the rail's inline-hover sync while it is unmounted.
  useEffect(() => {
    if (!active) return
    syncInlineHoverClass(review.hoveredMarkId)
    return () => syncInlineHoverClass(null)
  }, [active, review.hoveredMarkId])

  // Adjust stale state during render instead of via effects: drop computed badge
  // state while inactive, and close the panel once its block or marks disappear.
  if (!active && (groups.length > 0 || panel !== null)) {
    setGroups([])
    setPanel(null)
  } else if (
    panel &&
    (!groups.some((group) => group.blockId === panel.blockId) ||
      panel.markIds.every((id) => !marksById.has(id)))
  ) {
    setPanel(null)
  }
  // If the mark being edited was removed, fall back to no active editor.
  const activeEditingMarkId =
    editingMarkId !== null && review.marks.some((mark) => mark.id === editingMarkId)
      ? editingMarkId
      : null

  const showDraftFlyout = Boolean(review.activeDraft && draftPanel)
  if (!active || (groups.length === 0 && !showDraftFlyout)) return null

  const setHoveredMark = (id: string | null) => {
    review.setHoveredMarkId(id)
    syncInlineHoverClass(id)
  }
  const toggleExpandedMark = (id: string) => {
    setExpandedMarkIds((current) => {
      const next = new Set(current)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }
  const panelMarks = panel
    ? panel.markIds.map((id) => marksById.get(id)).filter((mark) => mark !== undefined)
    : []

  return (
    <div className="critic-review-badge-layer" data-marquee-ignore>
      {groups.map((group) => {
        const count = group.markIds.filter((id) => marksById.has(id)).length
        if (count === 0) return null
        const isOpen = panel?.blockId === group.blockId && panel.source === 'badge'
        return (
          <button
            key={group.blockId}
            type="button"
            className="critic-review-badge"
            data-state={isOpen ? 'open' : 'closed'}
            aria-expanded={isOpen ? 'true' : 'false'}
            aria-label={t('comments.badgeAria', { count })}
            style={{ top: group.top, insetInlineStart: group.insetInlineStart }}
            onClick={(event) => {
              if (isOpen) {
                setPanel(null)
              } else {
                openPanelForAnchor(group.blockId, group.markIds, 'badge', event.currentTarget)
              }
            }}
            onPointerEnter={() => setHoveredMark(group.markIds[0] ?? null)}
            onPointerLeave={() => setHoveredMark(null)}
          >
            <MessageCircle className="critic-review-badge-icon" aria-hidden="true" />
            <span className="critic-review-badge-count">{count}</span>
          </button>
        )
      })}

      {showDraftFlyout && draftPanel && (
        <div
          className="critic-review-flyout critic-review-flyout-draft"
          role="dialog"
          aria-label={t('comments.railAria')}
          style={{ top: draftPanel.top, insetInlineStart: draftPanel.insetInlineStart }}
        >
          <CommentComposer
            targetId={targetId}
            onSubmit={review.submitComment}
            onCancel={review.cancelCommentDraft}
          />
        </div>
      )}

      {panel && panelMarks.length > 0 && (
        <div
          className="critic-review-flyout"
          role="dialog"
          aria-label={t('comments.railAria')}
          style={{ top: panel.top, insetInlineStart: panel.insetInlineStart }}
        >
          {panelMarks.map((mark) => (
            <ReviewCard
              key={mark.id}
              mark={mark}
              review={review}
              targetId={targetId}
              isExpanded={expandedMarkIds.has(mark.id)}
              isEditing={activeEditingMarkId === mark.id}
              onToggleExpand={toggleExpandedMark}
              onEditingChange={setEditingMarkId}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function areBadgeGroupsEqual(previous: BadgeGroup[], next: BadgeGroup[]): boolean {
  if (previous.length !== next.length) return false
  return previous.every((group, index) => {
    const other = next[index]
    return (
      group.blockId === other.blockId &&
      group.top === other.top &&
      group.insetInlineStart === other.insetInlineStart &&
      group.markIds.length === other.markIds.length &&
      group.markIds.every((id, markIndex) => id === other.markIds[markIndex])
    )
  })
}
