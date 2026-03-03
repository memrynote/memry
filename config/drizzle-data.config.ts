import type { Config } from 'drizzle-kit'

/**
 * Drizzle config for data.db (tasks, projects, inbox)
 * Source of truth for non-file data.
 */
export default {
  schema: './src/shared/db/schema/data-schema.ts',
  out: './src/main/database/drizzle-data',
  dialect: 'sqlite',
  dbCredentials: {
    url: './test-data.db'
  }
} satisfies Config
