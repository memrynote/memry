import { memo, useMemo } from 'react'

import type { Message } from '@memry/contracts/ipc-agent'

import { Conversation, ConversationContent } from '@/components/ai-elements/conversation'
import { cn } from '@/lib/utils'

import { AssistantMessage } from './messages/assistant-message'
import { SystemMessage } from './messages/system-message'
import { ToolActivityGroup } from './messages/tool-activity-group'
import { ToolCallMessage } from './messages/tool-call-message'
import { ToolResultMessage } from './messages/tool-result-message'
import { UserMessage } from './messages/user-message'

interface MessageStreamProps {
  messages: Message[]
  /** True while the conversation has a turn running; only then can a tool group be live. */
  inFlight?: boolean
  contentClassName?: string
  messageListClassName?: string
}

function isToolMessage(message: Message): boolean {
  return message.role === 'tool_call' || message.role === 'tool_result'
}

/**
 * A streamed delta rebuilds the message array but every message object except
 * the one being streamed keeps its identity, so memoised rows turn a token into
 * a single row commit instead of re-rendering the whole transcript. Wrapped
 * here rather than at each definition: this is the only caller that re-renders
 * per token, and the rows stay plain components everywhere else.
 */
const AssistantMessageRow = memo(AssistantMessage)
const SystemMessageRow = memo(SystemMessage)
const ToolCallMessageRow = memo(ToolCallMessage)
const ToolResultMessageRow = memo(ToolResultMessage)
const UserMessageRow = memo(UserMessage)

function renderMessage(message: Message): React.JSX.Element | null {
  if (message.role === 'user') return <UserMessageRow key={message.id} message={message} />
  if (message.role === 'assistant') {
    return <AssistantMessageRow key={message.id} message={message} />
  }
  if (message.role === 'tool_call') {
    return <ToolCallMessageRow key={message.id} message={message} />
  }
  if (message.role === 'tool_result') {
    return <ToolResultMessageRow key={message.id} message={message} />
  }
  if (message.role === 'system') {
    return <SystemMessageRow key={message.id} message={message} />
  }
  return null
}

/** Consecutive tool messages become one collapsible run; everything else stays inline. */
function groupMessages(messages: Message[]): Message[][] {
  const groups: Message[][] = []

  for (const message of messages) {
    const previous = groups[groups.length - 1]
    if (previous && isToolMessage(message) && isToolMessage(previous[0])) {
      previous.push(message)
      continue
    }
    groups.push([message])
  }

  return groups
}

export function MessageStream({
  messages,
  inFlight = false,
  contentClassName,
  messageListClassName
}: MessageStreamProps): React.JSX.Element {
  const groups = useMemo(() => groupMessages(messages), [messages])
  const renderedMessages = groups.map((group, index) => {
    const first = group[0]
    if (group.length < 2) return renderMessage(first)
    return (
      <ToolActivityGroup
        key={first.id}
        messages={group}
        live={inFlight && index === groups.length - 1}
      >
        {group.map(renderMessage)}
      </ToolActivityGroup>
    )
  })

  return (
    <Conversation className="select-text">
      <ConversationContent className={contentClassName}>
        {messageListClassName ? (
          <div className={cn('flex flex-col gap-3', messageListClassName)}>{renderedMessages}</div>
        ) : (
          renderedMessages
        )}
      </ConversationContent>
    </Conversation>
  )
}
