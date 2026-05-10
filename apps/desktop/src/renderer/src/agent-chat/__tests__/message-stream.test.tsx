import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { Message } from '@main/agent/storage/types'

import { MessageStream } from '../message-stream'

function message(input: {
  id: string
  role: Message['role']
  content: Message['content']
  toolCallId?: string | null
}): Message {
  return {
    id: input.id,
    conversationId: 'conversation-1',
    role: input.role,
    content: input.content,
    toolCallId: input.toolCallId ?? null,
    attachments: [],
    status: 'completed',
    vectorClock: {},
    createdAt: 100,
    updatedAt: 100,
    deletedAt: null
  }
}

describe('MessageStream', () => {
  it('renders all stored agent message roles', () => {
    render(
      <MessageStream
        messages={[
          message({
            id: 'user-1',
            role: 'user',
            content: { role: 'user', data: { text: 'Create a task' } }
          }),
          message({
            id: 'assistant-1',
            role: 'assistant',
            content: { role: 'assistant', data: { text: 'I can do that.' } }
          }),
          message({
            id: 'tool-call-1',
            role: 'tool_call',
            toolCallId: 'tool-1',
            content: {
              role: 'tool_call',
              data: {
                tool: 'vault_create_task',
                args: { title: 'Buy milk' },
                status: 'pending'
              }
            }
          }),
          message({
            id: 'tool-result-1',
            role: 'tool_result',
            toolCallId: 'tool-1',
            content: {
              role: 'tool_result',
              data: { ok: true, data: { id: 'task-1' } }
            }
          }),
          message({
            id: 'system-1',
            role: 'system',
            content: {
              role: 'system',
              data: { kind: 'context_attached', payload: { label: 'Today' } }
            }
          })
        ]}
      />
    )

    expect(screen.getByText('Create a task')).toBeInTheDocument()
    expect(screen.getByText('I can do that.')).toBeInTheDocument()
    expect(screen.getByText('vault_create_task')).toBeInTheDocument()
    expect(screen.getByText('Tool result')).toBeInTheDocument()
    expect(screen.getByText('context_attached')).toBeInTheDocument()
  })
})
