import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const mockUseAgentOptional = vi.hoisted(() => vi.fn())
const mockUpdateTabTitle = vi.hoisted(() => vi.fn())

vi.mock('../agent-context', () => ({
  useAgentOptional: mockUseAgentOptional
}))

vi.mock('@/contexts/tabs', () => ({
  // The transcript keeps its scroll position in tab state; these tests render
  // it outside a tab, where that degrades to no persistence at all.
  useTabActionsOptional: () => null,
  useTabs: () => ({
    state: {
      tabGroups: {
        main: {
          id: 'main',
          activeTabId: 'agent-tab',
          isActive: true,
          back: [],
          forward: [],
          tabs: [
            {
              id: 'agent-tab',
              type: 'agent-chat',
              title: 'New conversation',
              icon: 'bot',
              path: '/agent-chat/conversation-1',
              entityId: 'conversation-1',
              isPinned: false,
              isModified: false,
              isPreview: false,
              isDeleted: false,
              openedAt: 1,
              lastAccessedAt: 1
            },
            {
              id: 'note-tab',
              type: 'note',
              title: 'New conversation',
              icon: 'file-text',
              path: '/note/conversation-1',
              entityId: 'conversation-1',
              isPinned: false,
              isModified: false,
              isPreview: false,
              isDeleted: false,
              openedAt: 1,
              lastAccessedAt: 1
            }
          ]
        }
      }
    },
    updateTabTitle: mockUpdateTabTitle
  })
}))

import { AgentTabTitleSync } from '../agent-tab-title-sync'

describe('AgentTabTitleSync', () => {
  it('keeps agent chat tab titles aligned to generated conversation titles', () => {
    mockUseAgentOptional.mockReturnValue({
      state: {
        conversations: {
          'conversation-1': {
            id: 'conversation-1',
            vaultId: 'vault-1',
            title: 'Project roadmap',
            backend: 'claude_cli',
            backendModel: null,
            trustList: [],
            pinned: false,
            vectorClock: {},
            fieldClocks: {},
            createdAt: 100,
            updatedAt: 200,
            deletedAt: null,
            lastSyncedAt: null
          }
        }
      }
    })

    render(<AgentTabTitleSync />)

    expect(mockUpdateTabTitle).toHaveBeenCalledTimes(1)
    expect(mockUpdateTabTitle).toHaveBeenCalledWith('agent-tab', 'Project roadmap', 'main')
  })
})
