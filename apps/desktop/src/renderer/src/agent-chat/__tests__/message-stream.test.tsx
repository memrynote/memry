import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Message } from '@memry/contracts/ipc-agent'

const mockUseAgentOptional = vi.hoisted(() => vi.fn())
const mockOpenTab = vi.hoisted(() => vi.fn())

vi.mock('../agent-context', () => ({
  useAgentOptional: mockUseAgentOptional
}))

vi.mock('@/contexts/tabs', () => ({
  useTabActions: () => ({ openTab: mockOpenTab })
}))

import { MessageStream } from '../message-stream'

const mockApproveTool = vi.fn()
const mockPreviewDiff = vi.fn()

function message(input: {
  id: string
  role: Message['role']
  content: Message['content']
  status?: Message['status']
  toolCallId?: string | null
}): Message {
  return {
    id: input.id,
    conversationId: 'conversation-1',
    role: input.role,
    content: input.content,
    toolCallId: input.toolCallId ?? null,
    attachments: [],
    status: input.status ?? 'completed',
    vectorClock: {},
    createdAt: 100,
    updatedAt: 100,
    deletedAt: null
  }
}

describe('MessageStream', () => {
  beforeEach(() => {
    mockApproveTool.mockReset()
    mockOpenTab.mockReset()
    mockPreviewDiff.mockReset()
    mockPreviewDiff.mockResolvedValue({
      title: 'Planning note',
      current: 'old',
      candidate: 'old\n\nnew'
    })
    mockUseAgentOptional.mockReturnValue(null)
    ;(window.api as typeof window.api & { agent?: { previewDiff: typeof mockPreviewDiff } }).agent =
      {
        previewDiff: mockPreviewDiff
      }
  })

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

  it('allows chat text selection', () => {
    render(
      <MessageStream
        messages={[
          message({
            id: 'assistant-1',
            role: 'assistant',
            content: { role: 'assistant', data: { text: 'Highlight me' } }
          })
        ]}
      />
    )

    expect(screen.getByRole('log')).toHaveClass('select-text')
  })

  it('renders assistant markdown as rich message content', () => {
    render(
      <MessageStream
        messages={[
          message({
            id: 'assistant-1',
            role: 'assistant',
            content: { role: 'assistant', data: { text: '# Plan\n\n- Create the task' } }
          })
        ]}
      />
    )

    expect(screen.getByRole('heading', { name: 'Plan' })).toBeInTheDocument()
    expect(screen.getByText('Create the task')).toBeInTheDocument()
  })

  it('renders assistant Memry refs as clickable links with a sources footer', () => {
    render(
      <MessageStream
        messages={[
          message({
            id: 'assistant-1',
            role: 'assistant',
            content: {
              role: 'assistant',
              data: {
                text: 'See [Movies](memry://note/note-1).',
                sources: [
                  {
                    kind: 'note',
                    id: 'note-1',
                    title: 'Movies',
                    href: 'memry://note/note-1'
                  }
                ]
              }
            }
          })
        ]}
      />
    )

    const link = screen.getByRole('link', { name: 'Movies' })
    expect(link).toHaveAttribute('href', 'memry://note/note-1')
    expect(link).toHaveClass('text-[#81B4E5]')
    expect(link).toHaveClass('hover:decoration-dotted')
    const sourcesTrigger = screen.getByRole('button', { name: /Used 1 source/i })
    expect(sourcesTrigger).toBeInTheDocument()

    fireEvent.click(link)

    expect(mockOpenTab).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'note',
        title: 'Movies',
        path: '/note/note-1',
        entityId: 'note-1'
      })
    )

    fireEvent.click(sourcesTrigger)
    expect(screen.getAllByRole('link', { name: 'Movies' })).toHaveLength(2)
  })

  it('omits the assistant sources footer when no Memry refs exist', () => {
    render(
      <MessageStream
        messages={[
          message({
            id: 'assistant-1',
            role: 'assistant',
            content: { role: 'assistant', data: { text: 'No linked items here.' } }
          })
        ]}
      />
    )

    expect(screen.queryByRole('button', { name: /sources/i })).not.toBeInTheDocument()
  })

  it('renders a waiting indicator for an empty streaming assistant message', () => {
    render(
      <MessageStream
        messages={[
          message({
            id: 'assistant-1',
            role: 'assistant',
            status: 'streaming',
            content: { role: 'assistant', data: { text: '' } }
          })
        ]}
      />
    )

    expect(screen.getByRole('status', { name: 'Agent is thinking' })).toBeInTheDocument()
  })

  it('renders tool calls as collapsed tool details by default', () => {
    render(
      <MessageStream
        messages={[
          message({
            id: 'tool-call-1',
            role: 'tool_call',
            toolCallId: 'tool-1',
            content: {
              role: 'tool_call',
              data: {
                tool: 'vault_create_task',
                args: { title: 'Buy milk' },
                status: 'input-available'
              }
            }
          })
        ]}
      />
    )

    expect(screen.getByRole('button', { name: /vault_create_task/i })).toBeInTheDocument()
    expect(screen.queryByText('Parameters')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /vault_create_task/i }))

    expect(screen.getByText('Parameters')).toBeInTheDocument()
  })

  it('renders completed tool output in the same collapsed tool block', () => {
    render(
      <MessageStream
        messages={[
          message({
            id: 'tool-call-1',
            role: 'tool_call',
            toolCallId: 'tool-1',
            content: {
              role: 'tool_call',
              data: {
                tool: 'vault_read_note',
                args: { id: 'note-1' },
                status: 'output-available',
                output: { title: 'Planning' }
              }
            }
          })
        ]}
      />
    )

    expect(screen.getByRole('button', { name: /vault_read_note/i })).toBeInTheDocument()
    expect(screen.queryByText('Planning')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /vault_read_note/i }))

    expect(screen.getByText(/Planning/)).toBeInTheDocument()
  })

  it('approves pending tool calls inline without a dialog', async () => {
    mockUseAgentOptional.mockReturnValue({
      state: {
        pendingApprovals: [
          {
            kind: 'tool_call_pending_approval',
            conversationId: 'conversation-1',
            toolCallId: 'tool-1',
            name: 'vault_create_task',
            args: { title: 'Buy milk' },
            requiresDiff: false
          }
        ]
      },
      approveTool: mockApproveTool
    })

    render(
      <MessageStream
        messages={[
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
          })
        ]}
      />
    )

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /vault_create_task/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))

    await waitFor(() => {
      expect(mockApproveTool).toHaveBeenCalledWith({
        conversationId: 'conversation-1',
        toolCallId: 'tool-1',
        decision: { kind: 'allow' }
      })
    })
  })

  it('submits edited pending tool args inline', async () => {
    mockUseAgentOptional.mockReturnValue({
      state: {
        pendingApprovals: [
          {
            kind: 'tool_call_pending_approval',
            conversationId: 'conversation-1',
            toolCallId: 'tool-1',
            name: 'vault_create_task',
            args: { title: 'Buy milk' },
            requiresDiff: false
          }
        ]
      },
      approveTool: mockApproveTool
    })

    render(
      <MessageStream
        messages={[
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
          })
        ]}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /vault_create_task/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit and allow' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '{"title":"Edited"}' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply edits' }))

    await waitFor(() => {
      expect(mockApproveTool).toHaveBeenCalledWith({
        conversationId: 'conversation-1',
        toolCallId: 'tool-1',
        decision: { kind: 'edit_allow', editedArgs: { title: 'Edited' } }
      })
    })
  })

  it('loads and applies diff approvals inline without a dialog', async () => {
    mockUseAgentOptional.mockReturnValue({
      state: {
        pendingApprovals: [
          {
            kind: 'tool_call_pending_approval',
            conversationId: 'conversation-1',
            toolCallId: 'tool-1',
            name: 'vault_update_note',
            args: {
              id: 'note-1',
              mode: 'append',
              content_markdown: 'new'
            },
            requiresDiff: true
          }
        ]
      },
      approveTool: mockApproveTool
    })

    render(
      <MessageStream
        messages={[
          message({
            id: 'tool-call-1',
            role: 'tool_call',
            toolCallId: 'tool-1',
            content: {
              role: 'tool_call',
              data: {
                tool: 'vault_update_note',
                args: {
                  id: 'note-1',
                  mode: 'append',
                  content_markdown: 'new'
                },
                status: 'pending'
              }
            }
          })
        ]}
      />
    )

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /vault_update_note/i }))
    const candidate = await screen.findByRole('textbox', { name: 'Candidate' })
    fireEvent.change(candidate, { target: { value: 'edited full note' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply edited' }))

    expect(mockPreviewDiff).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      toolCallId: 'tool-1'
    })
    await waitFor(() => {
      expect(mockApproveTool).toHaveBeenCalledWith({
        conversationId: 'conversation-1',
        toolCallId: 'tool-1',
        decision: {
          kind: 'edit_allow',
          editedArgs: {
            id: 'note-1',
            mode: 'replace',
            content_markdown: 'edited full note'
          }
        }
      })
    })
  })
})
