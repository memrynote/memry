/**
 * Templates Schema
 *
 * Custom note templates. Stored in data.db (source of truth, not rebuildable).
 *
 * Built-in templates are code constants (see BUILT_IN_TEMPLATES in
 * main/vault/templates.ts) and never appear here — they have fixed ids, are
 * identical on every device, and are immutable, so syncing them would only
 * create duplicates.
 *
 * Sync: whole-row LWW via `clock` (no field clocks).
 *
 * @module db/schema/templates
 */

import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'
import type { VectorClock } from '@memry/contracts/sync-api'

export const templates = sqliteTable('templates', {
  /** Unique identifier. Preserved from legacy file frontmatter on migration. */
  id: text('id').primaryKey(),

  /** Display name */
  name: text('name').notNull(),

  /** Optional short description shown in the template picker */
  description: text('description'),

  /** Optional emoji icon */
  icon: text('icon'),

  /** Tags applied to notes created from this template */
  tags: text('tags', { mode: 'json' }).$type<string[]>().notNull().default([]),

  /** Note properties seeded by this template */
  properties: text('properties', { mode: 'json' }).$type<unknown[]>().notNull().default([]),

  /** Markdown body */
  content: text('content').notNull().default(''),

  /** Vector clock for sync conflict resolution */
  clock: text('clock', { mode: 'json' }).$type<VectorClock>(),

  /** When this row was last synced to the server */
  syncedAt: text('synced_at'),

  createdAt: text('created_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),

  modifiedAt: text('modified_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
})

export type TemplateRow = typeof templates.$inferSelect
export type NewTemplateRow = typeof templates.$inferInsert
