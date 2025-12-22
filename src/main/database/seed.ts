/**
 * Database seed functions.
 * Creates default data on first vault open.
 *
 * @module database/seed
 */

import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { projects, statuses, tasks } from '@shared/db/schema'
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

/**
 * Seed a "test" project with 1000+ tasks for performance testing.
 * Used to verify 60fps scrolling with large task lists.
 */
export function seedPerformanceTestProject(db: DrizzleDb, taskCount: number = 1200): void {
  const projectId = 'test-performance'
  const now = new Date().toISOString()

  // Check if test project already exists
  const existingProject = db.select().from(projects).where(eq(projects.id, projectId)).get()

  if (existingProject) {
    console.log('Test performance project already exists, skipping seed')
    return
  }

  console.log(`Seeding performance test project with ${taskCount} tasks...`)
  const startTime = Date.now()

  // Create test project
  db.insert(projects)
    .values({
      id: projectId,
      name: 'Test',
      description: 'Performance testing project with 1000+ tasks',
      color: '#ef4444',
      icon: '🧪',
      position: 999,
      isInbox: false,
      createdAt: now,
      modifiedAt: now
    })
    .run()

  // Create statuses for test project
  const statusIds = {
    backlog: `${projectId}-backlog`,
    inProgress: `${projectId}-in-progress`,
    review: `${projectId}-review`,
    done: `${projectId}-done`
  }

  db.insert(statuses)
    .values([
      {
        id: statusIds.backlog,
        projectId,
        name: 'Backlog',
        color: '#6b7280',
        position: 0,
        isDefault: true,
        isDone: false,
        createdAt: now
      },
      {
        id: statusIds.inProgress,
        projectId,
        name: 'In Progress',
        color: '#3b82f6',
        position: 1,
        isDefault: false,
        isDone: false,
        createdAt: now
      },
      {
        id: statusIds.review,
        projectId,
        name: 'Review',
        color: '#f59e0b',
        position: 2,
        isDefault: false,
        isDone: false,
        createdAt: now
      },
      {
        id: statusIds.done,
        projectId,
        name: 'Done',
        color: '#22c55e',
        position: 3,
        isDefault: false,
        isDone: true,
        createdAt: now
      }
    ])
    .run()

  // Generate tasks in batches for better performance
  // Priority is stored as integer: 0=none, 1=low, 2=medium, 3=high, 4=urgent
  const priorities = [0, 1, 2, 3, 4] as const
  const statusArray = [statusIds.backlog, statusIds.inProgress, statusIds.review, statusIds.done]
  const taskCategories = [
    'Feature', 'Bug', 'Enhancement', 'Refactor', 'Documentation',
    'Testing', 'DevOps', 'Design', 'Research', 'Review'
  ]
  const taskActions = [
    'Implement', 'Fix', 'Update', 'Add', 'Remove', 'Refactor',
    'Test', 'Document', 'Review', 'Optimize', 'Configure', 'Deploy'
  ]
  const taskSubjects = [
    'user authentication', 'data validation', 'error handling', 'API endpoints',
    'database queries', 'UI components', 'navigation flow', 'state management',
    'caching layer', 'logging system', 'notification service', 'search feature',
    'filtering logic', 'sorting algorithm', 'export functionality', 'import wizard',
    'settings panel', 'dashboard widgets', 'analytics tracking', 'performance metrics'
  ]

  const batchSize = 100
  const taskValues: Array<typeof tasks.$inferInsert> = []

  for (let i = 0; i < taskCount; i++) {
    const taskId = generateId()
    const category = taskCategories[i % taskCategories.length]
    const action = taskActions[Math.floor(Math.random() * taskActions.length)]
    const subject = taskSubjects[Math.floor(Math.random() * taskSubjects.length)]
    const priority = priorities[Math.floor(Math.random() * priorities.length)]
    const statusId = statusArray[Math.floor(Math.random() * statusArray.length)]
    const isDone = statusId === statusIds.done

    // Add some variety with due dates
    let dueDate: string | null = null
    let dueTime: string | null = null
    if (Math.random() > 0.4) {
      const daysOffset = Math.floor(Math.random() * 30) - 7 // -7 to +23 days
      const date = new Date()
      date.setDate(date.getDate() + daysOffset)
      dueDate = date.toISOString().split('T')[0]

      // 30% chance of having a time
      if (Math.random() > 0.7) {
        const hours = Math.floor(Math.random() * 12) + 8 // 8:00 - 19:00
        const minutes = [0, 15, 30, 45][Math.floor(Math.random() * 4)]
        dueTime = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`
      }
    }

    const taskDate = new Date()
    taskDate.setMinutes(taskDate.getMinutes() - i) // Stagger creation times

    const priorityNames = ['none', 'low', 'medium', 'high', 'urgent']
    taskValues.push({
      id: taskId,
      title: `[${category}] ${action} ${subject} #${i + 1}`,
      description: i % 3 === 0 ? `Detailed description for task ${i + 1}. This is a ${priorityNames[priority]} priority ${category.toLowerCase()} task that needs attention.` : null,
      priority,
      projectId,
      statusId,
      position: i,
      dueDate,
      dueTime,
      completedAt: isDone ? now : null,
      createdAt: taskDate.toISOString(),
      modifiedAt: taskDate.toISOString()
    })

    // Insert in batches
    if (taskValues.length >= batchSize || i === taskCount - 1) {
      db.insert(tasks).values(taskValues).run()
      taskValues.length = 0 // Clear array
    }
  }

  const elapsed = Date.now() - startTime
  console.log(`Seeded ${taskCount} tasks in ${elapsed}ms (${(taskCount / elapsed * 1000).toFixed(0)} tasks/sec)`)
}
