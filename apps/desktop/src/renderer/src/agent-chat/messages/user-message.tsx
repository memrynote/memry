import type { Message, MessageAttachment } from '@memry/contracts/ipc-agent'
import type { MouseEvent } from 'react'

import { Message as AIMessage, MessageContent } from '@/components/ai-elements/message'
import { formatBytes } from '@/lib/format'
import { ChevronDown, FileText } from '@/lib/icons'
import { cn } from '@/lib/utils'

import { splitMemryFileBlocks } from '../memry-file-block'
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

  const inlinedAttachmentKeys = new Set<string>()
  const segments = splitMemryFileBlocks(message.content.data.text).map((segment, index) => {
    if (segment.kind === 'file') {
      return (
        <UserFileCard key={index} name={segment.name} bytes={segment.bytes}>
          {segment.content}
        </UserFileCard>
      )
    }
    const renderedText = renderUserTextWithMentions({
      text: segment.text,
      attachments: message.attachments,
      navigateMemryLink
    })
    renderedText.inlinedAttachmentKeys.forEach((key) => inlinedAttachmentKeys.add(key))
    return (
      <p key={index} className="whitespace-pre-wrap break-words">
        {renderedText.content}
      </p>
    )
  })
  const remainingAttachments = message.attachments.filter(
    (attachment) => !inlinedAttachmentKeys.has(attachmentKey(attachment))
  )

  return (
    <AIMessage from="user" className="max-w-[85%]">
      <MessageContent className="bg-primary text-primary-foreground">
        {segments}
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

function UserFileCard({
  name,
  bytes,
  children
}: {
  name: string
  bytes: number
  children: string
}): React.JSX.Element {
  return (
    <details className="group mt-2 min-w-0 rounded-md border border-primary-foreground/20 text-xs first:mt-0">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2 py-1.5 [&::-webkit-details-marker]:hidden">
        <ChevronDown
          className="size-3 shrink-0 -rotate-90 transition-transform group-open:rotate-0 rtl:rotate-90 rtl:group-open:rotate-0 motion-reduce:transition-none"
          aria-hidden="true"
        />
        <FileText className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate font-medium">{name}</span>
        <span className="ms-auto shrink-0 tabular-nums opacity-70">{formatBytes(bytes)}</span>
      </summary>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words border-t border-primary-foreground/20 px-2 py-1.5 text-start font-mono text-[11px]">
        {children}
      </pre>
    </details>
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
