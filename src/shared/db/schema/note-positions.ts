import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'

export const notePositions = sqliteTable(
  'note_positions',
  {
    path: text('path').primaryKey(),
    folderPath: text('folder_path').notNull(),
    position: integer('position').notNull().default(0)
  },
  (table) => [
    index('idx_note_positions_folder').on(table.folderPath),
    index('idx_note_positions_order').on(table.folderPath, table.position)
  ]
)

export type NotePosition = typeof notePositions.$inferSelect
export type NewNotePosition = typeof notePositions.$inferInsert
