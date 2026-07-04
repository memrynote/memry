import { customType } from 'drizzle-orm/sqlite-core'

/**
 * Case-insensitive text column (SQLite COLLATE NOCASE).
 * Tag identity is case-insensitive; stored value preserves the case the user typed.
 */
export const nocaseText = customType<{ data: string }>({
  dataType() {
    return 'text COLLATE NOCASE'
  }
})
