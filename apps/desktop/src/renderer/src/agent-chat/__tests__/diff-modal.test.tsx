import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockUseAgentOptional = vi.hoisted(() => vi.fn())

vi.mock('../agent-context', () => ({
  useAgentOptional: mockUseAgentOptional
}))

import { DiffModal } from '../diff-modal'

const mockApproveTool = vi.fn()
const mockPreviewDiff = vi.fn()

describe('DiffModal', () => {
  beforeEach(() => {
    mockApproveTool.mockReset()
    mockPreviewDiff.mockReset()
    mockPreviewDiff.mockResolvedValue({
      title: 'Planning note',
      current: 'old',
      candidate: 'old\n\nnew'
    })
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
    ;(window.api as typeof window.api & { agent?: { previewDiff: typeof mockPreviewDiff } }).agent =
      {
        previewDiff: mockPreviewDiff
      }
  })

  it('loads and applies an edited note candidate', async () => {
    render(<DiffModal />)

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

  it('does not render for non-diff approvals', () => {
    mockUseAgentOptional.mockReturnValue({
      state: {
        pendingApprovals: [
          {
            kind: 'tool_call_pending_approval',
            conversationId: 'conversation-1',
            toolCallId: 'tool-1',
            name: 'vault_create_task',
            args: { title: 'Follow up' },
            requiresDiff: false
          }
        ]
      },
      approveTool: mockApproveTool
    })

    render(<DiffModal />)

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
