import type { Config } from 'drizzle-kit'

/**
 * Drizzle config for index.db (note cache)
 * Rebuildable cache for note metadata from markdown files.
 */
export default {
  schema: './src/shared/db/schema/index-schema.ts',
  out: './src/main/database/drizzle-index',
  dialect: 'sqlite',
  dbCredentials: {
    url: './test-index.db'
  }
} satisfies Config
