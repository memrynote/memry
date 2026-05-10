import { eq, inArray } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import * as schema from '@memry/db-schema/data-schema'
import { TERMINAL_STATUSES, type MessageStatus } from '../storage/types'
import type { AgentSyncEnqueueRequest } from './entitlement-gate'

export interface BackfillProgress {
  done: number
  total: number
}

interface BackfillDeps {
  db: BetterSQLite3Database<typeof schema>
  vaultId: string
  enqueue: (req: AgentSyncEnqueueRequest) => void
  onProgress?: (progress: BackfillProgress) => void
}

export function backfillAgentChatRows(deps: BackfillDeps): void {
  const conversations = deps.db
    .select({ id: schema.agentConversations.id })
    .from(schema.agentConversations)
    .where(eq(schema.agentConversations.vaultId, deps.vaultId))
    .all()

  const conversationIds = conversations.map((conversation) => conversation.id)
  const messages =
    conversationIds.length > 0
      ? deps.db
          .select({ id: schema.agentMessages.id, status: schema.agentMessages.status })
          .from(schema.agentMessages)
          .where(inArray(schema.agentMessages.conversationId, conversationIds))
          .all()
      : []
  const terminalMessages = messages.filter((message) =>
    TERMINAL_STATUSES.has(message.status as MessageStatus)
  )

  const total = conversations.length + terminalMessages.length
  let done = 0
  const report = (): void => {
    done += 1
    deps.onProgress?.({ done, total })
  }

  for (const conversation of conversations) {
    deps.enqueue({ type: 'agent_conversation', id: conversation.id })
    report()
  }

  for (const message of terminalMessages) {
    deps.enqueue({ type: 'agent_message', id: message.id, status: message.status as MessageStatus })
    report()
  }
}
