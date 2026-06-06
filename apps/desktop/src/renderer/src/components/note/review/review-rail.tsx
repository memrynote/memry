import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CriticMarkupReviewController } from './use-critic-markup-review'
import { useT } from '@memry/i18n/renderer'
import { CommentComposer } from './comment-composer'
import { ReviewCard } from './review-card'
import { syncInlineHoverClass } from './inline-hover'

interface ReviewRailProps {
  review: CriticMarkupReviewController
  targetId?: string
}

const REVIEW_RAIL_ITEM_GAP = 10
const REVIEW_RAIL_DRAFT_ID = '__review-draft__'

interface RailItem {
  id: string
  desiredTop: number
  order: number
}

export function ReviewRail({ review, targetId }: ReviewRailProps) {
  const { t } = useT('notes')
  const [expandedMarkIds, setExpandedMarkIds] = useState<Set<string>>(() => new Set())
  const [editingMarkId, setEditingMarkId] = useState<string | null>(null)
  const itemRefs = useRef<Record<string, HTMLElement | null>>({})
  const [itemHeights, setItemHeights] = useState<Record<string, number>>({})
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
  const railItemPositions = useMemo(() => {
    const items: RailItem[] = []
    if (review.activeDraft) {
      items.push({
        id: REVIEW_RAIL_DRAFT_ID,
        desiredTop: review.activeDraft.top ?? 0,
        order: -1
      })
    }
    review.marks.forEach((mark, index) => {
      items.push({
        id: mark.id,
        desiredTop: review.markPositions[mark.id] ?? index * REVIEW_RAIL_ITEM_GAP,
        order: index
      })
    })

    items.sort((a, b) => a.desiredTop - b.desiredTop || a.order - b.order)

    const positions: Record<string, number> = {}
    let previousBottom = 0
    items.forEach((item, index) => {
      const top = Math.max(item.desiredTop, index === 0 ? 0 : previousBottom + REVIEW_RAIL_ITEM_GAP)
      positions[item.id] = top
      previousBottom = top + (itemHeights[item.id] ?? 0)
    })
    return positions
  }, [itemHeights, review.activeDraft, review.markPositions, review.marks])
  const positionedMarks = useMemo(
    () =>
      review.marks.map((mark) => ({
        mark,
        top: railItemPositions[mark.id] ?? review.markPositions[mark.id] ?? 0
      })),
    [railItemPositions, review.markPositions, review.marks]
  )
  const activeDraftTop = railItemPositions[REVIEW_RAIL_DRAFT_ID] ?? review.activeDraft?.top ?? 0

  useLayoutEffect(() => {
    const nextHeights: Record<string, number> = {}
    if (review.activeDraft) {
      const draftElement = itemRefs.current[REVIEW_RAIL_DRAFT_ID]
      if (draftElement) nextHeights[REVIEW_RAIL_DRAFT_ID] = draftElement.offsetHeight
    }
    review.marks.forEach((mark) => {
      const element = itemRefs.current[mark.id]
      if (element) nextHeights[mark.id] = element.offsetHeight
    })

    setItemHeights((previous) => {
      if (areNumberRecordsEqual(previous, nextHeights)) return previous
      return nextHeights
    })
  }, [editingMarkId, expandedMarkIds, review.activeDraft, review.marks])

  useEffect(() => {
    syncInlineHoverClass(review.hoveredMarkId)
    return () => syncInlineHoverClass(null)
  }, [review.hoveredMarkId])

  useEffect(() => {
    if (editingMarkId && !review.marks.some((mark) => mark.id === editingMarkId)) {
      setEditingMarkId(null)
    }
  }, [editingMarkId, review.marks])

  return (
    <aside aria-label={t('comments.railAria')} data-marquee-ignore className="review-rail">
      <div className="review-rail-inner">
        {review.activeDraft && (
          <div
            ref={(element) => {
              itemRefs.current[REVIEW_RAIL_DRAFT_ID] = element
            }}
            className="critic-review-draft"
            style={{ top: activeDraftTop }}
          >
            <CommentComposer
              targetId={targetId}
              onSubmit={review.submitComment}
              onCancel={review.cancelCommentDraft}
            />
          </div>
        )}

        {positionedMarks.map(({ mark, top }) => (
          <ReviewCard
            key={mark.id}
            mark={mark}
            review={review}
            targetId={targetId}
            isExpanded={expandedMarkIds.has(mark.id)}
            isEditing={editingMarkId === mark.id}
            onToggleExpand={toggleExpandedMark}
            onEditingChange={setEditingMarkId}
            style={{ top }}
            cardRef={(element) => {
              itemRefs.current[mark.id] = element
            }}
          />
        ))}
      </div>
    </aside>
  )
}

function areNumberRecordsEqual(
  previous: Record<string, number>,
  next: Record<string, number>
): boolean {
  const previousKeys = Object.keys(previous)
  const nextKeys = Object.keys(next)
  return (
    previousKeys.length === nextKeys.length && nextKeys.every((key) => previous[key] === next[key])
  )
}
