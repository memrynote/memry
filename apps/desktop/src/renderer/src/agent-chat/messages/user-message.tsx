import type { Message, MessageAttachment } from '@memry/contracts/ipc-agent'
import type { MouseEvent } from 'react'

import { Message as AIMessage, MessageContent } from '@/components/ai-elements/message'
import { cn } from '@/lib/utils'

import { mentionColorForKind } from '../mention-icons'
import { MemryLinkIcon, useMemryLinkNavigation } from './memry-links'

// Match the composer mention chip: per-kind color so it stays readable on the primary bubble.
const userMentionTagBaseClassName =
  'mx-0.5 inline-flex max-w-full items-center gap-1 rounded-full px-1.5 py-0.5 align-baseline text-xs font-medium ring-1 transition-colors focus-visible:outline-none focus-visible:ring-2'
const memryHrefKinds: Partial<Record<MessageAttachment['kind'], string>> = {
  note: 'note',
  task: 'task',
  inbox: 'inbox',
  journal: 'journal',
  project: 'project',
  folder: 'folder'
}

export function UserMessage({ message }: { message: Message }): React.JSX.Element | null {
  const navigateMemryLink = useMemryLinkNavigation()

  if (message.content.role !== 'user') return null

  const renderedText = renderUserTextWithMentions({
    text: message.content.data.text,
    attachments: message.attachments,
    navigateMemryLink
  })
  const remainingAttachments = message.attachments.filter(
    (attachment) => !renderedText.inlinedAttachmentKeys.has(attachmentKey(attachment))
  )

  return (
    <AIMessage from="user" className="max-w-[85%]">
      <MessageContent className="bg-primary text-primary-foreground">
        <p className="whitespace-pre-wrap break-words">{renderedText.content}</p>
        {remainingAttachments.length > 0 && (
          <div className="mt-2 flex flex-wrap justify-end gap-1">
            {remainingAttachments.map((attachment) => (
              <UserAttachmentTag
                key={attachmentKey(attachment)}
                attachment={attachment}
                label={attachment.label}
                navigateMemryLink={navigateMemryLink}
              />
            ))}
          </div>
        )}
      </MessageContent>
    </AIMessage>
  )
}

function renderUserTextWithMentions({
  text,
  attachments,
  navigateMemryLink
}: {
  text: string
  attachments: MessageAttachment[]
  navigateMemryLink: (href: string, title?: string) => boolean
}): {
  content: string | Array<string | React.JSX.Element>
  inlinedAttachmentKeys: Set<string>
} {
  const inlinedAttachmentKeys = new Set<string>()
  let content: Array<string | React.JSX.Element> = [text]

  for (const attachment of [...attachments].sort((a, b) => b.label.length - a.label.length)) {
    const href = hrefForAttachment(attachment)
    if (!href) continue

    const label = `@${attachment.label}`
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
        <UserAttachmentTag
          key={attachmentKey(attachment)}
          attachment={attachment}
          label={label}
          navigateMemryLink={navigateMemryLink}
        />
      )
      if (start + label.length < part.length) {
        nextContent.push(part.slice(start + label.length))
      }

      inlinedAttachmentKeys.add(attachmentKey(attachment))
      replaced = true
    }

    content = nextContent
  }

  return {
    content: content.length === 1 && typeof content[0] === 'string' ? content[0] : content,
    inlinedAttachmentKeys
  }
}

function UserAttachmentTag({
  attachment,
  label,
  navigateMemryLink
}: {
  attachment: MessageAttachment
  label: string
  navigateMemryLink: (href: string, title?: string) => boolean
}): React.JSX.Element {
  const href = hrefForAttachment(attachment)
  const tagClassName = cn(userMentionTagBaseClassName, mentionColorForKind(attachment.kind))

  if (!href) {
    return <span className={tagClassName}>{label}</span>
  }
  const targetHref = href

  function handleClick(event: MouseEvent<HTMLAnchorElement>): void {
    event.preventDefault()
    navigateMemryLink(targetHref, attachment.label)
  }

  return (
    <a href={targetHref} className={tagClassName} onClick={handleClick}>
      <MemryLinkIcon href={targetHref} className="text-current" />
      <span className="min-w-0">{label}</span>
    </a>
  )
}

function hrefForAttachment(attachment: MessageAttachment): string | null {
  const id = encodeURIComponent(attachment.refId)
  if (attachment.kind === 'calendar_event') return `memry://calendar/event/${id}`

  const hrefKind = memryHrefKinds[attachment.kind]
  return hrefKind ? `memry://${hrefKind}/${id}` : null
}

function attachmentKey(attachment: MessageAttachment): string {
  return `${attachment.kind}:${attachment.refId}`
}
