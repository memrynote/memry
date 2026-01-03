/**
 * Database seed functions.
 * Creates default data on first vault open.
 *
 * @module database/seed
 */

import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { projects, statuses } from '@shared/db/schema'
import * as schema from '@shared/db/schema'

type DrizzleDb = BetterSQLite3Database<typeof schema>

/**
 * Seed default data on first vault open.
 * This function is idempotent - safe to run multiple times.
 */
export function seedDefaults(db: DrizzleDb): void {
  seedInboxProject(db)
}

/**
 * Create the default inbox project if it doesn't exist.
 */
function seedInboxProject(db: DrizzleDb): void {
  // Check if inbox already exists
  const existingInbox = db.select().from(projects).where(eq(projects.id, 'inbox')).get()

  if (existingInbox) {
    console.log('Inbox project already exists, skipping seed')
    return
  }

  const now = new Date().toISOString()

  // Create inbox project
  db.insert(projects)
    .values({
      id: 'inbox',
      name: 'Inbox',
      description: 'Quick capture for tasks',
      color: '#6366f1',
      icon: '📥',
      position: 0,
      isInbox: true,
      createdAt: now,
      modifiedAt: now
    })
    .run()

  // Create default statuses for inbox
  db.insert(statuses)
    .values([
      {
        id: 'inbox-todo',
        projectId: 'inbox',
        name: 'To Do',
        color: '#6b7280',
        position: 0,
        isDefault: true,
        isDone: false,
        createdAt: now
      },
      {
        id: 'inbox-done',
        projectId: 'inbox',
        name: 'Done',
        color: '#22c55e',
        position: 1,
        isDefault: false,
        isDone: true,
        createdAt: now
      }
    ])
    .run()

  console.log('Seeded default inbox project with statuses')
}
