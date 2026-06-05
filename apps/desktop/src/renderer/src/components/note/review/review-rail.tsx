import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { MentionIcon, mentionColorForKind, type MentionIconSpec } from '@/agent-chat/mention-icons'
import { useMemryLinkNavigation } from '@/agent-chat/messages/memry-links'
import { Check, Paperclip, Trash, X } from '@/lib/icons'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { CriticMarkupReviewController } from './use-critic-markup-review'
import { useT } from '@memry/i18n/renderer'
import type { CriticMarkupCommentMentionRef, CriticMarkupMark } from '@memry/shared'
import { CommentComposer } from './comment-composer'

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
  const itemRefs = useRef<Record<string, HTMLElement | null>>({})
  const [itemHeights, setItemHeights] = useState<Record<string, number>>({})
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
  }, [expandedMarkIds, review.activeDraft, review.marks])

  useEffect(() => {
    syncInlineHoverClass(review.hoveredMarkId)
    return () => syncInlineHoverClass(null)
  }, [review.hoveredMarkId])

  if (review.marks.length === 0 && !review.activeDraft) {
    return (
      <aside
        aria-label={t('comments.railAria')}
        data-marquee-ignore
        className="review-rail-empty"
      />
    )
  }

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

        {positionedMarks.map(({ mark, top }) => {
          const isSuggestion = mark.kind !== 'comment'
          const isExpanded = expandedMarkIds.has(mark.id)
          return (
            <div
              ref={(element) => {
                itemRefs.current[mark.id] = element
              }}
              key={mark.id}
              className={cn('critic-review-card', `critic-review-card-${mark.kind}`)}
              data-critic-mark-id={mark.id}
              data-hovered={review.hoveredMarkId === mark.id ? 'true' : 'false'}
              data-expanded={isExpanded ? 'true' : 'false'}
              aria-expanded={isExpanded ? 'true' : 'false'}
              style={{ top }}
              onPointerOver={() => setHoveredMark(mark.id)}
              onPointerOut={(event) => {
                if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
                setHoveredMark(null)
              }}
              onFocus={() => setHoveredMark(mark.id)}
              onBlur={(event) => {
                if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
                setHoveredMark(null)
              }}
            >
              <button
                type="button"
                className="critic-review-expand-toggle"
                aria-label={isExpanded ? 'Collapse review card' : 'Expand review card'}
                aria-expanded={isExpanded ? 'true' : 'false'}
                onClick={() => toggleExpandedMark(mark.id)}
              />
              <div className="critic-review-content">
                {isSuggestion && <SuggestionPreview mark={mark} />}
                <CommentBody mark={mark} />
                <CommentAttachments mark={mark} />
              </div>
              <div className="critic-review-actions">
                {isSuggestion ? (
                  <>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="critic-review-action-button"
                      aria-label={t('comments.accept')}
                      onPointerDown={(event) => {
                        event.preventDefault()
                        review.acceptMark(mark.id)
                      }}
                      onClick={() => review.acceptMark(mark.id)}
                    >
                      <Check className="size-3.5" aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="critic-review-action-button"
                      aria-label={t('comments.reject')}
                      onPointerDown={(event) => {
                        event.preventDefault()
                        review.rejectMark(mark.id)
                      }}
                      onClick={() => review.rejectMark(mark.id)}
                    >
                      <X className="size-3.5" aria-hidden="true" />
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="critic-review-action-button"
                      aria-label={t('comments.resolve')}
                      onPointerDown={(event) => {
                        event.preventDefault()
                        review.resolveMark(mark.id)
                      }}
                      onClick={() => review.resolveMark(mark.id)}
                    >
                      <Check className="size-3.5" aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="critic-review-action-button"
                      aria-label={t('comments.delete')}
                      onPointerDown={(event) => {
                        event.preventDefault()
                        review.deleteMark(mark.id)
                      }}
                      onClick={() => review.deleteMark(mark.id)}
                    >
                      <Trash className="size-3.5" aria-hidden="true" />
                    </Button>
                  </>
                )}
              </div>
            </div>
          )
        })}
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

function SuggestionPreview({ mark }: { mark: CriticMarkupMark }): React.JSX.Element | null {
  if (mark.kind === 'addition') {
    return (
      <p className="critic-review-suggestion-preview critic-review-text-collapsible">
        <span className="critic-review-suggestion-label-addition">Add:</span>{' '}
        <span className="critic-review-suggestion-text-addition">
          &ldquo;{mark.visibleText}&rdquo;
        </span>
      </p>
    )
  }

  if (mark.kind === 'deletion') {
    return (
      <p className="critic-review-suggestion-preview critic-review-text-collapsible">
        <span className="critic-review-suggestion-label-deletion">Delete:</span>{' '}
        <span className="critic-review-suggestion-text-deletion">
          &ldquo;{mark.visibleText}&rdquo;
        </span>
      </p>
    )
  }

  if (mark.kind === 'substitution') {
    return (
      <p className="critic-review-suggestion-preview critic-review-text-collapsible">
        <span className="critic-review-suggestion-label-substitution">Replace:</span>{' '}
        <span className="critic-review-suggestion-text-substitution">
          {mark.originalText}
          {' -> '}
          {mark.visibleText}
        </span>
      </p>
    )
  }

  return null
}

function CommentBody({ mark }: { mark: CriticMarkupMark }): React.JSX.Element | null {
  if (!mark.body) return null

  const parts = splitCommentBody(mark.body, mark.mentions ?? [])
  return (
    <p className="critic-review-body critic-review-text-collapsible">
      {parts.map((part, index) =>
        part.kind === 'mention' ? (
          <CommentMentionLink
            key={`${part.mention.kind}-${part.mention.refId}-${index}`}
            mention={part.mention}
          />
        ) : (
          <span key={`text-${index}`}>{part.text}</span>
        )
      )}
    </p>
  )
}

function CommentMentionLink({
  mention
}: {
  mention: CriticMarkupCommentMentionRef
}): React.JSX.Element {
  const navigate = useMemryLinkNavigation()
  const href = hrefForMention(mention)

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    navigate(href, mention.label)
  }

  return (
    <a
      href={href}
      className={cn(
        'mx-0.5 inline-flex max-w-full items-center gap-1 rounded-full px-1.5 py-0.5 text-[0.9em] font-medium leading-none ring-1',
        mentionColorForKind(mention.kind)
      )}
      onClick={handleClick}
    >
      <MentionIcon icon={iconForMention(mention)} className="size-3 text-current" />
      <span className="truncate">@{mention.label}</span>
    </a>
  )
}

function CommentAttachments({ mark }: { mark: CriticMarkupMark }): React.JSX.Element | null {
  if (!mark.attachments?.length) return null
  return (
    <div className="critic-review-attachments">
      {mark.attachments.map((attachment) => (
        <a
          key={attachment.id}
          href={attachment.path}
          className="inline-flex max-w-full items-center gap-1 rounded-full bg-muted px-2 py-1 text-xs text-muted-foreground"
        >
          <Paperclip className="size-3 shrink-0" aria-hidden="true" />
          <span className="truncate">{attachment.name}</span>
        </a>
      ))}
    </div>
  )
}

type CommentBodyPart =
  | { kind: 'text'; text: string }
  | { kind: 'mention'; mention: CriticMarkupCommentMentionRef }

function splitCommentBody(
  body: string,
  mentions: CriticMarkupCommentMentionRef[]
): CommentBodyPart[] {
  const parts: CommentBodyPart[] = []
  const used = new Set<string>()
  let cursor = 0

  while (cursor < body.length) {
    let next: {
      start: number
      end: number
      key: string
      mention: CriticMarkupCommentMentionRef
    } | null = null

    for (const mention of mentions) {
      const key = `${mention.kind}:${mention.refId}`
      if (used.has(key)) continue
      const token = `@${mention.label}`
      const start = body.indexOf(token, cursor)
      if (start === -1) continue
      if (!next || start < next.start) {
        next = { start, end: start + token.length, key, mention }
      }
    }

    if (!next) break
    if (next.start > cursor) parts.push({ kind: 'text', text: body.slice(cursor, next.start) })
    parts.push({ kind: 'mention', mention: next.mention })
    used.add(next.key)
    cursor = next.end
  }

  if (cursor < body.length) parts.push({ kind: 'text', text: body.slice(cursor) })
  return parts
}

function hrefForMention(mention: CriticMarkupCommentMentionRef): string {
  const encodedId = encodeURIComponent(mention.refId)
  if (mention.kind === 'calendar_event') return `memry://calendar/event/${encodedId}`
  return `memry://${mention.kind}/${encodedId}`
}

function iconForMention(mention: CriticMarkupCommentMentionRef): MentionIconSpec {
  switch (mention.kind) {
    case 'note':
      return { kind: 'note', emoji: null }
    case 'task':
      return { kind: 'task' }
    case 'journal':
      return { kind: 'journal' }
    case 'inbox':
      return { kind: 'inbox', itemType: null }
    case 'calendar_event':
      return { kind: 'calendar_event' }
  }
}

function syncInlineHoverClass(id: string | null): void {
  document
    .querySelectorAll<HTMLElement>('[data-critic-mark-kind][data-critic-mark-id]')
    .forEach((element) => {
      element.classList.toggle(
        'critic-mark-hovered',
        id !== null && element.dataset.criticMarkId === id
      )
    })

  const styleId = 'critic-mark-hover-style'
  let style = document.getElementById(styleId) as HTMLStyleElement | null
  if (!style) {
    style = document.createElement('style')
    style.id = styleId
    document.head.appendChild(style)
  }

  if (!id) {
    style.textContent = ''
    return
  }

  const escapedId = id.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  style.textContent = `[data-critic-mark-kind][data-critic-mark-id="${escapedId}"] { background: color-mix(in srgb, var(--accent-orange) 30%, transparent) !important; }`
}
