import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockUseAgentOptional = vi.hoisted(() => vi.fn())
const mockUseActiveTab = vi.hoisted(() => vi.fn())

vi.mock('../agent-context', () => ({
  useAgentOptional: mockUseAgentOptional
}))

vi.mock('@/contexts/tabs', () => ({
  useActiveTab: mockUseActiveTab
}))

import { Composer } from '../composer'

const mockSendTurn = vi.fn()
const mockSearchQuery = vi.fn()

describe('Composer', () => {
  beforeEach(() => {
    mockSendTurn.mockReset()
    mockSearchQuery.mockReset()
    mockSearchQuery.mockResolvedValue({
      groups: [],
      totalCount: 0,
      queryTimeMs: 0
    })
    mockUseActiveTab.mockReturnValue(null)
    mockUseAgentOptional.mockReturnValue({
      state: {
        inFlight: {}
      },
      sendTurn: mockSendTurn
    })
    vi.mocked(window.api.search.query).mockImplementation(mockSearchQuery)
  })

  it('submits on Cmd+Enter', () => {
    render(<Composer conversationId="conversation-1" sourceWindowId="window-1" />)

    const textbox = screen.getByRole('textbox')
    fireEvent.change(textbox, { target: { value: 'hello' } })
    fireEvent.keyDown(textbox, { key: 'Enter', metaKey: true })

    expect(mockSendTurn).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      sourceWindowId: 'window-1',
      text: 'hello',
      attachments: []
    })
  })

  it('does not submit on plain Enter', () => {
    render(<Composer conversationId="conversation-1" sourceWindowId="window-1" />)

    const textbox = screen.getByRole('textbox')
    fireEvent.change(textbox, { target: { value: 'hello' } })
    fireEvent.keyDown(textbox, { key: 'Enter' })

    expect(mockSendTurn).not.toHaveBeenCalled()
  })

  it('adds picked refs to the submitted attachments', async () => {
    mockSearchQuery.mockResolvedValue({
      groups: [
        {
          type: 'note',
          totalInGroup: 1,
          results: [
            {
              id: 'note-1',
              type: 'note',
              title: 'Planning note',
              snippet: '',
              score: 1,
              normalizedScore: 1,
              matchType: 'title',
              modifiedAt: '2026-05-10T00:00:00.000Z',
              metadata: { type: 'note', path: '/Planning note', tags: [] }
            }
          ]
        }
      ],
      totalCount: 1,
      queryTimeMs: 1
    })
    render(<Composer conversationId="conversation-1" sourceWindowId="window-1" />)

    const textbox = screen.getByRole('textbox')
    fireEvent.change(textbox, { target: { value: 'summarize @plan' } })
    fireEvent.click(await screen.findByRole('option', { name: /planning note/i }))
    fireEvent.change(textbox, { target: { value: 'summarize this' } })
    fireEvent.keyDown(textbox, { key: 'Enter', metaKey: true })

    expect(mockSearchQuery).toHaveBeenCalledWith({ text: 'plan', limit: 20 })
    expect(mockSendTurn).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      sourceWindowId: 'window-1',
      text: 'summarize this',
      attachments: [{ kind: 'note', ref_id: 'note-1', label: 'Planning note' }]
    })
  })

  it('auto-attaches the current note', () => {
    mockUseActiveTab.mockReturnValue({
      id: 'tab-1',
      type: 'note',
      title: 'Current brief',
      entityId: 'note-2'
    })
    render(<Composer conversationId="conversation-1" sourceWindowId="window-1" />)

    const textbox = screen.getByRole('textbox')
    fireEvent.change(textbox, { target: { value: 'summarize' } })
    fireEvent.keyDown(textbox, { key: 'Enter', metaKey: true })

    expect(mockSendTurn).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      sourceWindowId: 'window-1',
      text: 'summarize',
      attachments: [{ kind: 'current_note', ref_id: '__current__', label: 'Current brief' }]
    })
  })
})
