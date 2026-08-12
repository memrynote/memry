import type { CSSProperties, MouseEvent } from 'react'
import { MentionIcon, mentionColorForKind } from '@/agent-chat/mention-icons'
import { useMemryLinkNavigation } from '@/agent-chat/messages/memry-links'
import { Check, Pencil, Trash } from '@/lib/icons'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useGeneralSettings } from '@/hooks/use-general-settings'
import type { ClockFormat } from '@/lib/time-format'
import { cn } from '@/lib/utils'
import type { CriticMarkupReviewController } from './use-critic-markup-review'
import { useT } from '@memry/i18n/renderer'
import type {
  CriticMarkupCommentFormatMark,
  CriticMarkupCommentMentionRef,
  CriticMarkupMark
} from '@memry/shared'
import { CommentAttachments } from './comment-attachments'
import { iconForMention, splitCommentBodyWithFormat } from './comment-body'
import { CommentComposer } from './comment-composer'
import { syncInlineHoverClass } from './inline-hover'

interface ReviewCardProps {
  mark: CriticMarkupMark
  review: CriticMarkupReviewController
  targetId?: string
  isExpanded: boolean
  isEditing: boolean
  onToggleExpand: (id: string) => void
  onEditingChange: (id: string | null) => void
  className?: string
  style?: CSSProperties
  cardRef?: (element: HTMLElement | null) => void
}

export function ReviewCard({
  mark,
  review,
  targetId,
  isExpanded,
  isEditing,
  onToggleExpand,
  onEditingChange,
  className,
  style,
  cardRef
}: ReviewCardProps) {
  const { t } = useT('notes')
  const { settings } = useGeneralSettings()
  const setHoveredMark = (id: string | null) => {
    review.setHoveredMarkId(id)
    syncInlineHoverClass(id)
  }

  return (
    <div
      ref={cardRef}
      className={cn('critic-review-card', `critic-review-card-${mark.kind}`, className)}
      data-critic-mark-id={mark.id}
      data-hovered={review.hoveredMarkId === mark.id ? 'true' : 'false'}
      data-editing={isEditing ? 'true' : 'false'}
      data-expanded={isExpanded ? 'true' : 'false'}
      aria-expanded={isExpanded ? 'true' : 'false'}
      style={style}
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
      {isEditing ? (
        <CommentComposer
          targetId={targetId}
          initialValue={{
            body: mark.body ?? '',
            mentions: mark.mentions ?? [],
            attachments: mark.attachments ?? [],
            formatRanges: mark.formatRanges ?? []
          }}
          onSubmit={(input) => {
            review.updateComment(mark.id, input)
            onEditingChange(null)
          }}
          onCancel={() => onEditingChange(null)}
        />
      ) : (
        <>
          <button
            type="button"
            className="critic-review-expand-toggle"
            aria-label={isExpanded ? 'Collapse review card' : 'Expand review card'}
            aria-expanded={isExpanded ? 'true' : 'false'}
            onClick={() => onToggleExpand(mark.id)}
          />
          <div className="critic-review-content">
            {mark.createdAt !== undefined && (
              <CommentDate createdAt={mark.createdAt} clockFormat={settings.clockFormat} />
            )}
            <CommentBody mark={mark} />
            <CommentAttachments mark={mark} />
          </div>
          <div className="critic-review-actions">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="critic-review-action-button"
              aria-label={t('comments.edit')}
              onPointerDown={(event) => {
                event.preventDefault()
                onEditingChange(mark.id)
              }}
              onClick={() => onEditingChange(mark.id)}
            >
              <Pencil className="size-3.5" aria-hidden="true" />
            </Button>
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
          </div>
        </>
      )}
    </div>
  )
}

function CommentDate({
  createdAt,
  clockFormat
}: {
  createdAt: number
  clockFormat: ClockFormat
}): React.JSX.Element {
  const { t, i18n } = useT('notes')
  const date = new Date(createdAt)
  const monthShort = new Intl.DateTimeFormat(i18n.language, { month: 'short' }).format(date)
  const dayMonth = `${date.getDate()} ${monthShort}`
  const tooltipTime = new Intl.DateTimeFormat(i18n.language, {
    hour: clockFormat === '12h' ? 'numeric' : '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: clockFormat === '12h'
  }).format(date)

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="critic-review-date">{dayMonth}</span>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="start">
          {t('comments.createdTooltip', {
            date: `${dayMonth} ${date.getFullYear()}`,
            time: tooltipTime
          })}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function CommentBody({ mark }: { mark: CriticMarkupMark }): React.JSX.Element | null {
  if (!mark.body) return null

  const parts = splitCommentBodyWithFormat(mark.body, mark.mentions ?? [], mark.formatRanges ?? [])
  return (
    <p className="critic-review-body critic-review-text-collapsible">
      {parts.map((part, index) => (
        <FormattedCommentPart key={`part-${index}`} marks={part.marks}>
          {part.kind === 'mention' ? (
            <CommentMentionLink mention={part.mention} />
          ) : (
            <span>{part.text}</span>
          )}
        </FormattedCommentPart>
      ))}
    </p>
  )
}

const MARK_ELEMENTS: Record<CriticMarkupCommentFormatMark, 'strong' | 'em' | 'u' | 's' | 'code'> = {
  bold: 'strong',
  italic: 'em',
  underline: 'u',
  strikethrough: 's',
  code: 'code'
}

/**
 * Wraps a part in its marks outermost-first, so the same mark set always
 * produces the same DOM. Everything stays inline — the collapsed card clamps
 * the body with `text-overflow: ellipsis`.
 */
function FormattedCommentPart({
  marks,
  children
}: {
  marks: CriticMarkupCommentFormatMark[]
  children: React.ReactNode
}): React.JSX.Element {
  return marks.reduceRight<React.JSX.Element>(
    (wrapped, mark) => {
      const Element = MARK_ELEMENTS[mark]
      return <Element className="critic-review-body-mark">{wrapped}</Element>
    },
    <>{children}</>
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

function hrefForMention(mention: CriticMarkupCommentMentionRef): string {
  const encodedId = encodeURIComponent(mention.refId)
  if (mention.kind === 'calendar_event') return `memry://calendar/event/${encodedId}`
  return `memry://${mention.kind}/${encodedId}`
}
