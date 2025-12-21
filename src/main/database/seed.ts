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
import { generateId } from '../lib/id'

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

/**
 * Create a sample project for demonstration.
 * Only used in development or for onboarding.
 */
export function seedSampleProject(db: DrizzleDb): void {
  const projectId = generateId()
  const now = new Date().toISOString()

  // Check if we already have more than just inbox
  const projectCount = db.select().from(projects).all().length
  if (projectCount > 1) {
    console.log('Sample data already exists, skipping')
    return
  }

  // Create sample project
  db.insert(projects)
    .values({
      id: projectId,
      name: 'Getting Started',
      description: 'Learn how to use Memry',
      color: '#8b5cf6',
      icon: '🚀',
      position: 1,
      isInbox: false,
      createdAt: now,
      modifiedAt: now
    })
    .run()

  // Create statuses for sample project
  db.insert(statuses)
    .values([
      {
        id: `${projectId}-backlog`,
        projectId,
        name: 'Backlog',
        color: '#6b7280',
        position: 0,
        isDefault: true,
        isDone: false,
        createdAt: now
      },
      {
        id: `${projectId}-doing`,
        projectId,
        name: 'Doing',
        color: '#3b82f6',
        position: 1,
        isDefault: false,
        isDone: false,
        createdAt: now
      },
      {
        id: `${projectId}-done`,
        projectId,
        name: 'Done',
        color: '#22c55e',
        position: 2,
        isDefault: false,
        isDone: true,
        createdAt: now
      }
    ])
    .run()

  console.log('Seeded sample project with statuses')
}
