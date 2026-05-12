import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import type { FieldClocks, VectorClock } from '@memry/contracts/sync-api'

export const agentConversations = sqliteTable(
  'agent_conversations',
  {
    id: text('id').primaryKey(),
    vaultId: text('vault_id').notNull(),
    titleCiphertext: text('title_ciphertext').notNull(),
    backend: text('backend').notNull(),
    backendModel: text('backend_model'),
    trustList: text('trust_list', { mode: 'json' }).$type<string[]>().notNull().default([]),
    pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
    vectorClock: text('vector_clock', { mode: 'json' }).$type<VectorClock>().notNull(),
    fieldClocks: text('field_clocks', { mode: 'json' }).$type<FieldClocks>().notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
    lastSyncedAt: integer('last_synced_at')
  },
  (table) => [
    index('agent_conversations_by_vault').on(table.vaultId),
    index('agent_conversations_by_updated').on(table.vaultId, table.updatedAt)
  ]
)

export type AgentConversationRow = typeof agentConversations.$inferSelect
export type NewAgentConversationRow = typeof agentConversations.$inferInsert
