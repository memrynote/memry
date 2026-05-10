import { useEffect, useRef } from 'react'

import type { Message } from '@main/agent/storage/types'

import { AssistantMessage } from './messages/assistant-message'
import { SystemMessage } from './messages/system-message'
import { ToolCallMessage } from './messages/tool-call-message'
import { ToolResultMessage } from './messages/tool-result-message'
import { UserMessage } from './messages/user-message'

interface MessageStreamProps {
  messages: Message[]
}

export function MessageStream({ messages }: MessageStreamProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo?.({ top: scrollRef.current.scrollHeight })
  }, [messages])

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
      {messages.map((message) => {
        if (message.role === 'user') return <UserMessage key={message.id} message={message} />
        if (message.role === 'assistant') {
          return <AssistantMessage key={message.id} message={message} />
        }
        if (message.role === 'tool_call') {
          return <ToolCallMessage key={message.id} message={message} />
        }
        if (message.role === 'tool_result') {
          return <ToolResultMessage key={message.id} message={message} />
        }
        if (message.role === 'system') {
          return <SystemMessage key={message.id} message={message} />
        }
        return null
      })}
    </div>
  )
}
