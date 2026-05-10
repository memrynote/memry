import { useState } from 'react'

import type { Conversation } from '@main/agent/storage/types'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ChevronDown } from '@/lib/icons'
import { ConversationList } from './conversation-list'

interface ConversationHeaderProps {
  conversation: Conversation
  conversations: Conversation[]
  onCreateConversation: () => void | Promise<void>
  onSelectConversation: (id: string) => void | Promise<void>
}

export function ConversationHeader({
  conversation,
  conversations,
  onCreateConversation,
  onSelectConversation
}: ConversationHeaderProps): React.JSX.Element {
  const [open, setOpen] = useState(false)

  async function handleCreateConversation(): Promise<void> {
    await onCreateConversation()
    setOpen(false)
  }

  async function handleSelectConversation(id: string): Promise<void> {
    await onSelectConversation(id)
    setOpen(false)
  }

  return (
    <header className="border-b border-sidebar-border px-3 py-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 max-w-full justify-start gap-1.5 px-2 text-sm font-semibold"
          >
            <span className="min-w-0 truncate">{conversation.title}</span>
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 p-0">
          <ConversationList
            conversations={conversations}
            activeConversationId={conversation.id}
            onCreateConversation={handleCreateConversation}
            onSelectConversation={handleSelectConversation}
          />
        </PopoverContent>
      </Popover>
    </header>
  )
}
