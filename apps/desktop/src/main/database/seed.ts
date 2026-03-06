/**
 * Database seed functions.
 * Creates default data on first vault open.
 *
 * @module database/seed
 */

import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { projects, statuses, tasks, taskTags } from '@memry/db-schema/schema'
import * as schema from '@memry/db-schema/schema'
import { createLogger } from '../lib/logger'

const logger = createLogger('Seed')

type DrizzleDb = BetterSQLite3Database<typeof schema>

// ============================================================================
// Date Utilities for Realistic Seeding
// ============================================================================

/**
 * Get today's date in ISO format (YYYY-MM-DD)
 */
function getToday(): string {
  return new Date().toISOString().split('T')[0]
}

/**
 * Get a date relative to today
 */
function getRelativeDate(daysFromToday: number): string {
  const date = new Date()
  date.setDate(date.getDate() + daysFromToday)
  return date.toISOString().split('T')[0]
}

function getNow(): string {
  return new Date().toISOString()
}

/**
 * Seed default data on first vault open.
 * This function is idempotent - safe to run multiple times.
 */
export function seedDefaults(db: DrizzleDb): void {
  seedInboxProject(db)
}

/**
 * Seed sample tasks for development/demo purposes.
 * Creates sample projects, statuses, and tasks with realistic data.
 * This function is idempotent - safe to run multiple times.
 */
export function seedSampleTasks(db: DrizzleDb): void {
  seedSampleProjects(db)
  seedSampleTaskData(db)
}

/**
 * Create the default inbox project if it doesn't exist.
 */
function seedInboxProject(db: DrizzleDb): void {
  // Check if inbox already exists
  const existingInbox = db.select().from(projects).where(eq(projects.id, 'inbox')).get()

  if (existingInbox) {
    logger.debug('Inbox project already exists, skipping seed')
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

  logger.info('Seeded default inbox project with statuses')
}

// ============================================================================
// Sample Data Seeding (for development/demo)
// ============================================================================

const SAMPLE_PROJECTS = [
  {
    id: 'project-work',
    name: 'Work',
    description: 'Work-related tasks and projects',
    color: '#3b82f6',
    icon: '💼',
    position: 1
  },
  {
    id: 'project-personal',
    name: 'Personal',
    description: 'Personal life and household tasks',
    color: '#22c55e',
    icon: '🏠',
    position: 2
  },
  {
    id: 'project-learning',
    name: 'Learning',
    description: 'Education and skill development',
    color: '#a855f7',
    icon: '📚',
    position: 3
  }
] as const

function seedSampleProjects(db: DrizzleDb): void {
  for (const project of SAMPLE_PROJECTS) {
    const existing = db.select().from(projects).where(eq(projects.id, project.id)).get()
    if (existing) {
      logger.debug(`Project "${project.name}" already exists, skipping`)
      continue
    }

    const now = getNow()

    db.insert(projects)
      .values({
        ...project,
        isInbox: false,
        createdAt: now,
        modifiedAt: now
      })
      .run()

    db.insert(statuses)
      .values([
        {
          id: `${project.id}-todo`,
          projectId: project.id,
          name: 'To Do',
          color: '#6b7280',
          position: 0,
          isDefault: true,
          isDone: false,
          createdAt: now
        },
        {
          id: `${project.id}-in-progress`,
          projectId: project.id,
          name: 'In Progress',
          color: '#3b82f6',
          position: 1,
          isDefault: false,
          isDone: false,
          createdAt: now
        },
        {
          id: `${project.id}-done`,
          projectId: project.id,
          name: 'Done',
          color: '#22c55e',
          position: 2,
          isDefault: false,
          isDone: true,
          createdAt: now
        }
      ])
      .run()

    logger.info(`Seeded project "${project.name}" with statuses`)
  }
}

interface SampleTask {
  id: string
  projectId: string
  statusId: string
  parentId?: string
  title: string
  description?: string
  priority: number
  position: number
  dueDateOffset?: number
  dueTime?: string
  completedAt?: string
  tags?: string[]
}

function getSampleTasks(): SampleTask[] {
  const today = getToday()

  return [
    // Work Project Tasks
    {
      id: 'task-work-1',
      projectId: 'project-work',
      statusId: 'project-work-todo',
      title: 'Review Q4 budget proposal',
      description: 'Analyze department spending and prepare recommendations for leadership review',
      priority: 3,
      position: 0,
      dueDateOffset: 0,
      dueTime: '14:00',
      tags: ['urgent', 'finance']
    },
    {
      id: 'task-work-2',
      projectId: 'project-work',
      statusId: 'project-work-todo',
      title: 'Schedule team meeting',
      description: 'Coordinate with team leads for weekly sync',
      priority: 2,
      position: 1,
      dueDateOffset: 1,
      tags: ['meetings']
    },
    {
      id: 'task-work-3',
      projectId: 'project-work',
      statusId: 'project-work-in-progress',
      title: 'Update project documentation',
      description: 'Refresh API docs and deployment guides',
      priority: 1,
      position: 2,
      dueDateOffset: 3,
      tags: ['docs']
    },
    {
      id: 'task-work-4',
      projectId: 'project-work',
      statusId: 'project-work-done',
      title: 'Code review PR #42',
      description: 'Review authentication refactor pull request',
      priority: 2,
      position: 3,
      completedAt: getRelativeDate(-1) + 'T10:30:00.000Z',
      tags: ['code-review']
    },
    {
      id: 'task-work-5',
      projectId: 'project-work',
      statusId: 'project-work-todo',
      title: 'Prepare sprint retrospective',
      priority: 1,
      position: 4,
      dueDateOffset: 5,
      tags: ['agile']
    },

    // Personal Project Tasks
    {
      id: 'task-personal-1',
      projectId: 'project-personal',
      statusId: 'project-personal-todo',
      title: 'Grocery shopping',
      description: 'Weekly groceries from the farmers market',
      priority: 2,
      position: 0,
      dueDateOffset: 0,
      tags: ['errands', 'shopping']
    },
    {
      id: 'task-personal-1-sub-1',
      projectId: 'project-personal',
      statusId: 'project-personal-todo',
      parentId: 'task-personal-1',
      title: 'Buy fresh vegetables',
      priority: 0,
      position: 0
    },
    {
      id: 'task-personal-1-sub-2',
      projectId: 'project-personal',
      statusId: 'project-personal-todo',
      parentId: 'task-personal-1',
      title: 'Get milk and eggs',
      priority: 0,
      position: 1
    },
    {
      id: 'task-personal-1-sub-3',
      projectId: 'project-personal',
      statusId: 'project-personal-done',
      parentId: 'task-personal-1',
      title: 'Pick up bread',
      priority: 0,
      position: 2,
      completedAt: today + 'T09:00:00.000Z'
    },
    {
      id: 'task-personal-2',
      projectId: 'project-personal',
      statusId: 'project-personal-todo',
      title: 'Call mom',
      description: 'Weekly catch-up call',
      priority: 1,
      position: 1,
      dueDateOffset: 2,
      tags: ['family']
    },
    {
      id: 'task-personal-3',
      projectId: 'project-personal',
      statusId: 'project-personal-todo',
      title: 'Book dentist appointment',
      description: 'Schedule 6-month checkup',
      priority: 2,
      position: 2,
      dueDateOffset: -2,
      tags: ['health']
    },
    {
      id: 'task-personal-4',
      projectId: 'project-personal',
      statusId: 'project-personal-in-progress',
      title: 'Plan weekend trip',
      description: 'Research destinations and accommodations',
      priority: 1,
      position: 3,
      dueDateOffset: 4,
      tags: ['travel', 'planning']
    },

    // Learning Project Tasks
    {
      id: 'task-learning-1',
      projectId: 'project-learning',
      statusId: 'project-learning-in-progress',
      title: 'Complete TypeScript course',
      description: 'Finish advanced TypeScript patterns course on Udemy',
      priority: 2,
      position: 0,
      dueDateOffset: 7,
      tags: ['typescript', 'courses']
    },
    {
      id: 'task-learning-1-sub-1',
      projectId: 'project-learning',
      statusId: 'project-learning-done',
      parentId: 'task-learning-1',
      title: 'Finish generics chapter',
      priority: 0,
      position: 0,
      completedAt: getRelativeDate(-1) + 'T16:00:00.000Z'
    },
    {
      id: 'task-learning-1-sub-2',
      projectId: 'project-learning',
      statusId: 'project-learning-in-progress',
      parentId: 'task-learning-1',
      title: 'Practice type inference exercises',
      priority: 0,
      position: 1
    },
    {
      id: 'task-learning-2',
      projectId: 'project-learning',
      statusId: 'project-learning-todo',
      title: "Read 'Clean Code' book",
      description: 'Robert C. Martin classic on software craftsmanship',
      priority: 1,
      position: 1,
      dueDateOffset: 14,
      tags: ['books', 'best-practices']
    },
    {
      id: 'task-learning-3',
      projectId: 'project-learning',
      statusId: 'project-learning-todo',
      title: 'Write blog post about React hooks',
      description: 'Share learnings about custom hooks patterns',
      priority: 1,
      position: 2,
      dueDateOffset: 10,
      tags: ['writing', 'react']
    }
  ]
}

function seedSampleTaskData(db: DrizzleDb): void {
  const sampleTasks = getSampleTasks()

  for (const task of sampleTasks) {
    const existing = db.select().from(tasks).where(eq(tasks.id, task.id)).get()
    if (existing) {
      continue
    }

    const now = getNow()
    const dueDate = task.dueDateOffset !== undefined ? getRelativeDate(task.dueDateOffset) : null

    db.insert(tasks)
      .values({
        id: task.id,
        projectId: task.projectId,
        statusId: task.statusId,
        parentId: task.parentId ?? null,
        title: task.title,
        description: task.description ?? null,
        priority: task.priority,
        position: task.position,
        dueDate,
        dueTime: task.dueTime ?? null,
        completedAt: task.completedAt ?? null,
        createdAt: now,
        modifiedAt: now
      })
      .run()

    if (task.tags && task.tags.length > 0) {
      db.insert(taskTags)
        .values(task.tags.map((tag) => ({ taskId: task.id, tag })))
        .run()
    }
  }

  logger.info(`Seeded ${sampleTasks.length} sample tasks`)
}
