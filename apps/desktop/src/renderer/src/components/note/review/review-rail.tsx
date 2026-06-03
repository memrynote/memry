import { useEffect, useMemo, type MouseEvent } from 'react'
import { MentionIcon, mentionColorForKind, type MentionIconSpec } from '@/agent-chat/mention-icons'
import { useMemryLinkNavigation } from '@/agent-chat/messages/memry-links'
import { Check, MessageCircle, Paperclip, PenLine, Trash, X } from '@/lib/icons'
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

export function ReviewRail({ review, targetId }: ReviewRailProps) {
  const { t } = useT('notes')
  const setHoveredMark = (id: string | null) => {
    review.setHoveredMarkId(id)
    syncInlineHoverClass(id)
  }
  const positionedMarks = useMemo(() => {
    let lastTop = 0
    return review.marks.map((mark, index) => {
      const desiredTop = review.markPositions[mark.id] ?? index * 116
      const top = Math.max(desiredTop, index === 0 ? 0 : lastTop + 12)
      lastTop = top + 104
      return { mark, top }
    })
  }, [review.markPositions, review.marks])

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
          <div className="critic-review-card critic-review-card-draft">
            <div className="critic-review-card-header">
              <MessageCircle className="size-3.5" aria-hidden="true" />
              <span>{t('comments.newComment')}</span>
            </div>
            <p className="critic-review-quote">{review.activeDraft.text}</p>
            <CommentComposer
              targetId={targetId}
              onSubmit={review.submitComment}
              onCancel={review.cancelCommentDraft}
            />
          </div>
        )}

        {positionedMarks.map(({ mark, top }) => {
          const isSuggestion = mark.kind !== 'comment'
          return (
            <div
              key={mark.id}
              className={cn('critic-review-card', `critic-review-card-${mark.kind}`)}
              data-critic-mark-id={mark.id}
              data-hovered={review.hoveredMarkId === mark.id ? 'true' : 'false'}
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
              <div className="critic-review-card-header">
                {isSuggestion ? (
                  <PenLine className="size-3.5" aria-hidden="true" />
                ) : (
                  <MessageCircle className="size-3.5" aria-hidden="true" />
                )}
                <span>
                  {isSuggestion ? t(`comments.kind.${mark.kind}`) : t('comments.kind.comment')}
                </span>
              </div>
              {mark.kind === 'substitution' && (
                <p className="critic-review-quote">
                  {mark.originalText}
                  {' -> '}
                  {mark.visibleText}
                </p>
              )}
              {mark.kind !== 'substitution' && (
                <p className="critic-review-quote">{mark.visibleText}</p>
              )}
              <CommentBody mark={mark} />
              <CommentAttachments mark={mark} />
              <div className="critic-review-actions">
                {isSuggestion ? (
                  <>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onPointerDown={() => review.acceptMark(mark.id)}
                      onClick={() => review.acceptMark(mark.id)}
                    >
                      <Check className="me-1 size-3.5" aria-hidden="true" />
                      {t('comments.accept')}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onPointerDown={() => review.rejectMark(mark.id)}
                      onClick={() => review.rejectMark(mark.id)}
                    >
                      <X className="me-1 size-3.5" aria-hidden="true" />
                      {t('comments.reject')}
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onPointerDown={() => review.resolveMark(mark.id)}
                      onClick={() => review.resolveMark(mark.id)}
                    >
                      <Check className="me-1 size-3.5" aria-hidden="true" />
                      {t('comments.resolve')}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('comments.delete')}
                      onPointerDown={() => review.deleteMark(mark.id)}
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

function CommentBody({ mark }: { mark: CriticMarkupMark }): React.JSX.Element | null {
  if (!mark.body) return null

  const parts = splitCommentBody(mark.body, mark.mentions ?? [])
  return (
    <p className="critic-review-body">
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
