import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockUseAgentOptional = vi.hoisted(() => vi.fn())

vi.mock('../agent-context', () => ({
  useAgentOptional: mockUseAgentOptional
}))

import { ApprovalModal } from '../approval-modal'

const mockApproveTool = vi.fn()

describe('ApprovalModal', () => {
  beforeEach(() => {
    mockApproveTool.mockReset()
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
  })

  it('allows a pending tool once', async () => {
    render(<ApprovalModal />)

    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))

    await waitFor(() => {
      expect(mockApproveTool).toHaveBeenCalledWith({
        conversationId: 'conversation-1',
        toolCallId: 'tool-1',
        decision: { kind: 'allow' }
      })
    })
  })

  it('submits edited tool args', async () => {
    render(<ApprovalModal />)

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

  it('does not render without a pending approval', () => {
    mockUseAgentOptional.mockReturnValue({
      state: { pendingApprovals: [] },
      approveTool: mockApproveTool
    })

    render(<ApprovalModal />)

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
