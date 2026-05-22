import type { Comment, CommentMentionKind, CommentMentionRef } from '@/services/comments-service'
import { MentionIcon, mentionColorForKind, type MentionIconSpec } from '@/agent-chat/mention-icons'
import { cn } from '@/lib/utils'

function mentionIconForKind(kind: CommentMentionKind): MentionIconSpec {
  switch (kind) {
    case 'note':
      return { kind: 'note' }
    case 'journal':
      return { kind: 'journal' }
    case 'task':
      return { kind: 'task' }
    case 'inbox':
      return { kind: 'inbox' }
    case 'calendar_event':
      return { kind: 'calendar_event' }
    case 'project':
      return { kind: 'project' }
    case 'folder':
      return { kind: 'folder' }
  }
}

function mentionHref(mention: CommentMentionRef): string {
  const id = encodeURIComponent(mention.refId)
  if (mention.kind === 'calendar_event') return `memry://calendar/event/${id}`
  return `memry://${mention.kind}/${id}`
}

function renderMentionInlineLink({
  elementKey,
  mention,
  onNavigate
}: {
  elementKey: string
  mention: CommentMentionRef
  onNavigate?: () => void
}): React.JSX.Element {
  const content = (
    <>
      <MentionIcon icon={mentionIconForKind(mention.kind)} className="size-3" />
      <span className="min-w-0 truncate">@{mention.label}</span>
    </>
  )

  const className = cn(
    'mx-0.5 inline-flex max-w-full items-center gap-1 rounded-full px-1.5 py-0.5 align-baseline text-[0.9em] font-medium leading-none ring-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
    mentionColorForKind(mention.kind)
  )

  if (onNavigate) {
    return (
      <button
        key={elementKey}
        type="button"
        className={className}
        onClick={(event) => {
          event.stopPropagation()
          onNavigate()
        }}
      >
        {content}
      </button>
    )
  }

  return (
    <span key={elementKey} className={className}>
      {content}
    </span>
  )
}

export function renderCommentBodyWithMentions({
  comment,
  navigate
}: {
  comment: Comment
  navigate: (href: string, title?: string) => boolean
}): Array<string | React.JSX.Element> {
  const inlined = new Set<string>()
  let content: Array<string | React.JSX.Element> = [comment.body]

  for (const mention of [...comment.mentionRefs].sort((a, b) => b.label.length - a.label.length)) {
    const key = `${mention.kind}:${mention.refId}`
    const label = `@${mention.label}`
    const nextContent: Array<string | React.JSX.Element> = []
    let replaced = false

    for (const part of content) {
      if (replaced || typeof part !== 'string') {
        nextContent.push(part)
        continue
      }

      const start = part.indexOf(label)
      if (start < 0) {
        nextContent.push(part)
        continue
      }

      if (start > 0) nextContent.push(part.slice(0, start))
      nextContent.push(
        renderMentionInlineLink({
          elementKey: key,
          mention,
          onNavigate: () => navigate(mentionHref(mention), mention.label)
        })
      )
      if (start + label.length < part.length) {
        nextContent.push(part.slice(start + label.length))
      }

      inlined.add(key)
      replaced = true
    }

    content = nextContent
  }

  const remainingMentions = comment.mentionRefs.filter(
    (mention) => !inlined.has(`${mention.kind}:${mention.refId}`)
  )
  if (remainingMentions.length > 0 && comment.body.trim().length > 0) content.push(' ')
  for (const mention of remainingMentions) {
    const key = `${mention.kind}:${mention.refId}`
    content.push(
      renderMentionInlineLink({
        elementKey: key,
        mention,
        onNavigate: () => navigate(mentionHref(mention), mention.label)
      })
    )
  }

  return content
}
