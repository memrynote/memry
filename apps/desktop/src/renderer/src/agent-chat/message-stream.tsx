import type { Message } from '@memry/contracts/ipc-agent'

import { Conversation, ConversationContent } from '@/components/ai-elements/conversation'

import { AssistantMessage } from './messages/assistant-message'
import { SystemMessage } from './messages/system-message'
import { ToolCallMessage } from './messages/tool-call-message'
import { ToolResultMessage } from './messages/tool-result-message'
import { UserMessage } from './messages/user-message'

interface MessageStreamProps {
  messages: Message[]
}

export function MessageStream({ messages }: MessageStreamProps): React.JSX.Element {
  return (
    <Conversation className="select-text">
      <ConversationContent>
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
      </ConversationContent>
    </Conversation>
  )
}
