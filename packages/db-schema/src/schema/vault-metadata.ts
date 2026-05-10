import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const vaultMetadata = sqliteTable('vault_metadata', {
  id: text('id').primaryKey(),
  vaultUuid: text('vault_uuid').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull()
})

export type VaultMetadata = typeof vaultMetadata.$inferSelect
export type NewVaultMetadata = typeof vaultMetadata.$inferInsert
