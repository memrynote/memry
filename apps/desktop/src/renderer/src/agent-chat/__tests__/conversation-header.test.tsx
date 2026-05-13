import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

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
  it('renders the active conversation title', () => {
    render(<ConversationHeader conversation={conversations[0]} />)

    const title = screen.getByText('Planning')
    const header = title.closest('header')

    expect(title).toBeInTheDocument()
    expect(header).toHaveClass('border-t')
    expect(header).not.toHaveClass('border-b')
    expect(screen.queryByRole('button', { name: 'Conversation history' })).not.toBeInTheDocument()
  })
})
