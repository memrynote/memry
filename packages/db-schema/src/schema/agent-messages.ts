import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import type { VectorClock } from '@memry/contracts/sync-api'

export const agentMessages = sqliteTable(
  'agent_messages',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id').notNull(),
    role: text('role').notNull(),
    contentCiphertext: text('content_ciphertext').notNull(),
    attachmentsCiphertext: text('attachments_ciphertext').notNull(),
    toolCallId: text('tool_call_id'),
    status: text('status').notNull(),
    vectorClock: text('vector_clock', { mode: 'json' }).$type<VectorClock>().notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at')
  },
  (table) => [index('agent_messages_by_conversation').on(table.conversationId, table.createdAt)]
)

export type AgentMessageRow = typeof agentMessages.$inferSelect
export type NewAgentMessageRow = typeof agentMessages.$inferInsert
