import { eq } from 'drizzle-orm'
import { projects, statuses } from '@memry/db-schema/schema'
import type { DataDb } from './types'
import { createLogger } from '../lib/logger'

const logger = createLogger('DatabaseDefaults')

function getNow(): string {
  return new Date().toISOString()
}

export function ensureDefaultTaskProject(db: DataDb): void {
  const existingInbox = db.select().from(projects).where(eq(projects.id, 'inbox')).get()

  if (existingInbox) {
    logger.debug('Default inbox project already exists')
    return
  }

  const now = getNow()

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

  logger.info('Initialized default inbox project with statuses')
}
