import userEvent from '@testing-library/user-event'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { Conversation } from '@memry/contracts/ipc-agent'

import { ConversationHeader } from '../conversation-header'

const conversations: Conversation[] = [
  {
    id: 'conversation-1',
    vaultId: 'vault-1',
    title: 'Planning',
    backend: 'claude_cli',
    backendModel: null,
    trustList: [],
    pinned: false,
    vectorClock: {},
    fieldClocks: {},
    createdAt: 100,
    updatedAt: 100,
    deletedAt: null,
    lastSyncedAt: null
  },
  {
    id: 'conversation-2',
    vaultId: 'vault-1',
    title: 'Inbox cleanup',
    backend: 'claude_cli',
    backendModel: null,
    trustList: [],
    pinned: false,
    vectorClock: {},
    fieldClocks: {},
    createdAt: 200,
    updatedAt: 200,
    deletedAt: null,
    lastSyncedAt: null
  }
]

describe('ConversationHeader', () => {
  it('opens the switcher and selects another conversation', async () => {
    const user = userEvent.setup()
    const onSelectConversation = vi.fn()

    render(
      <ConversationHeader
        conversation={conversations[0]}
        conversations={conversations}
        onCreateConversation={vi.fn()}
        onSelectConversation={onSelectConversation}
      />
    )

    await user.click(screen.getByRole('button', { name: /Planning/ }))
    await user.click(screen.getByRole('button', { name: 'Inbox cleanup' }))

    expect(onSelectConversation).toHaveBeenCalledWith('conversation-2')
  })

  it('creates a new conversation from the switcher', async () => {
    const user = userEvent.setup()
    const onCreateConversation = vi.fn()

    render(
      <ConversationHeader
        conversation={conversations[0]}
        conversations={conversations}
        onCreateConversation={onCreateConversation}
        onSelectConversation={vi.fn()}
      />
    )

    await user.click(screen.getByRole('button', { name: /Planning/ }))
    await user.click(screen.getByRole('button', { name: 'New conversation' }))

    expect(onCreateConversation).toHaveBeenCalledTimes(1)
  })
})
