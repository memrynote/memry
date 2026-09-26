/**
 * Notes and journals whose server CRDT body this device knows it has not
 * merged (#2297).
 *
 * A row is written before any `LAST_CURSOR` write that moves past the evidence
 * of the debt, and deleted only by a pull that walked the note's whole server
 * body clean, or when the note has no row left to pull into. It survives a
 * crash, so the next sync engine start pulls the note again and keeps its
 * snapshot pushes off the pruning endpoint until then.
 *
 * @module db/schema/crdt-body-debts
 */

import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

export const crdtBodyDebts = sqliteTable('crdt_body_debts', {
  /** Note or journal id: the CRDT document id. */
  noteId: text('note_id').primaryKey(),

  /** Why the standing debt was first raised. Logs and tests only. */
  reason: text('reason').notNull(),

  /**
   * Lowest change-feed cursor of a body row this note may lack. NULL: the
   * whole body is owed and no cursor is known.
   */
  lowestCursor: integer('lowest_cursor'),

  /**
   * Rises with every debt raised in this database. A pull settles only debts
   * at or below the generation it started at, so one raised mid-pull stands.
   */
  generation: integer('generation').notNull(),

  /** Failed pulls since the debt was raised; spaces out the drain's retries. */
  failures: integer('failures').notNull().default(0),

  /** Epoch milliseconds of the last failed pull; the backoff runs from here. */
  lastFailedAt: integer('last_failed_at'),

  /**
   * 1 when the debt's cause showed the snapshot watermark ahead of the doc: a
   * batch probe may not settle it, only a full walk.
   */
  needsWalk: integer('needs_walk').notNull().default(0),

  /** Epoch milliseconds. */
  createdAt: integer('created_at').notNull(),

  /** Epoch milliseconds of the latest debt raised for this note. Logs only. */
  updatedAt: integer('updated_at').notNull()
})

export type CrdtBodyDebtRow = typeof crdtBodyDebts.$inferSelect
