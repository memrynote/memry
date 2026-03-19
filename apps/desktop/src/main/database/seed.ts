/**
 * Database seed functions.
 * Creates default data on first vault open + rich sample data for dev/demo.
 *
 * @module database/seed
 */

import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { projects, statuses, tasks, taskTags, tagDefinitions } from '@memry/db-schema/schema'
import * as schema from '@memry/db-schema/schema'
import { createLogger } from '../lib/logger'

const logger = createLogger('Seed')

type DrizzleDb = BetterSQLite3Database<typeof schema>

// ============================================================================
// Date Utilities
// ============================================================================

function getRelativeDate(daysFromToday: number): string {
  const date = new Date()
  date.setDate(date.getDate() + daysFromToday)
  return date.toISOString().split('T')[0]
}

function getNow(): string {
  return new Date().toISOString()
}

function completedAt(daysAgo: number): string {
  return getRelativeDate(-daysAgo) + 'T10:00:00.000Z'
}

// ============================================================================
// Defaults (Inbox)
// ============================================================================

export function seedDefaults(db: DrizzleDb): void {
  seedInboxProject(db)
}

function seedInboxProject(db: DrizzleDb): void {
  const existingInbox = db.select().from(projects).where(eq(projects.id, 'inbox')).get()

  if (existingInbox) {
    logger.debug('Inbox project already exists, skipping seed')
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

  logger.info('Seeded default inbox project with statuses')
}

// ============================================================================
// Tag Definitions
// ============================================================================

const TAG_COLORS: Record<string, string> = {
  marketing: '#ec4899',
  engineering: '#3b82f6',
  design: '#8b5cf6',
  research: '#06b6d4',
  strategy: '#f59e0b',
  content: '#f97316',
  qa: '#ef4444',
  launch: '#10b981',
  devops: '#6366f1',
  security: '#dc2626',
  finance: '#84cc16',
  branding: '#a855f7',
  kitchen: '#d97706',
  bathroom: '#0ea5e9',
  electrical: '#eab308',
  plumbing: '#64748b',
  permits: '#78716c',
  flooring: '#a16207',
  outdoor: '#16a34a',
  budget: '#ca8a04',
  contractor: '#737373',
  demolition: '#b91c1c',
  cardio: '#ef4444',
  strength: '#7c3aed',
  nutrition: '#22c55e',
  recovery: '#06b6d4',
  goals: '#f59e0b',
  mobility: '#14b8a6',
  sleep: '#6366f1',
  supplements: '#84cc16',
  frontend: '#3b82f6',
  backend: '#10b981',
  ux: '#ec4899',
  mvp: '#f97316',
  api: '#8b5cf6',
  database: '#0ea5e9',
  testing: '#ef4444',
  deployment: '#6366f1'
}

// ============================================================================
// Project Configs
// ============================================================================

const PROJECT_CONFIGS = [
  {
    id: 'project-launch',
    name: 'Product Launch',
    description: 'Q2 product launch planning and execution',
    color: '#2563eb',
    icon: '🚀',
    position: 1,
    statuses: ['To Do', 'In Progress', 'Done']
  },
  {
    id: 'project-renovation',
    name: 'Home Renovation',
    description: 'Kitchen and bathroom renovation project',
    color: '#d97706',
    icon: '🏡',
    position: 2,
    statuses: ['To Do', 'In Progress', 'Done']
  },
  {
    id: 'project-fitness',
    name: 'Fitness & Wellness',
    description: 'Health goals and workout tracking',
    color: '#059669',
    icon: '💪',
    position: 3,
    statuses: ['To Do', 'In Progress', 'Done']
  },
  {
    id: 'project-sideproject',
    name: 'Side Project',
    description: 'Indie app development',
    color: '#7c3aed',
    icon: '⚡',
    position: 4,
    statuses: ['To Do', 'In Progress', 'Done']
  }
] as const

// ============================================================================
// Repeat Config Presets
// ============================================================================

interface RepeatConfig {
  frequency: 'daily' | 'weekly' | 'monthly' | 'yearly'
  interval: number
  daysOfWeek?: number[]
  monthlyType?: 'dayOfMonth' | 'weekPattern'
  dayOfMonth?: number
  endType: 'never' | 'date' | 'count'
  completedCount: number
  createdAt: string
}

function dailyRepeat(): RepeatConfig {
  return {
    frequency: 'daily',
    interval: 1,
    endType: 'never',
    completedCount: 0,
    createdAt: getNow()
  }
}

function weekdayRepeat(): RepeatConfig {
  return {
    frequency: 'weekly',
    interval: 1,
    daysOfWeek: [1, 2, 3, 4, 5],
    endType: 'never',
    completedCount: 0,
    createdAt: getNow()
  }
}

function weeklyRepeat(): RepeatConfig {
  return {
    frequency: 'weekly',
    interval: 1,
    endType: 'never',
    completedCount: 0,
    createdAt: getNow()
  }
}

function monthlyRepeat(day: number): RepeatConfig {
  return {
    frequency: 'monthly',
    interval: 1,
    monthlyType: 'dayOfMonth',
    dayOfMonth: day,
    endType: 'never',
    completedCount: 0,
    createdAt: getNow()
  }
}

// ============================================================================
// Compact Task Data
// ============================================================================

type Status = 'todo' | 'progress' | 'done'

interface SeedTask {
  id: string
  s: Status
  title: string
  desc?: string
  p: number
  due?: number
  dueTime?: string
  startDate?: number
  parentId?: string
  tags?: string[]
  repeat?: RepeatConfig
  repeatFrom?: 'due' | 'completion'
  done?: number
}

function statusId(projectId: string, s: Status): string {
  const map: Record<Status, string> = { todo: 'todo', progress: 'in-progress', done: 'done' }
  return `${projectId}-${map[s]}`
}

// — Product Launch ——————————————————————————————————————

const LAUNCH_TASKS: SeedTask[] = [
  {
    id: 'lnch-01',
    s: 'todo',
    title: 'Define target audience personas',
    desc: 'Research demographics, pain points, and buying behaviors for primary segments',
    p: 3,
    due: 3,
    tags: ['research', 'marketing']
  },
  {
    id: 'lnch-02',
    s: 'todo',
    title: 'Write press release draft',
    p: 2,
    due: 5,
    tags: ['marketing', 'content']
  },
  {
    id: 'lnch-03',
    s: 'todo',
    title: 'Design landing page mockups',
    desc: 'Hero section, feature grid, pricing table, and footer',
    p: 2,
    due: 7,
    tags: ['design', 'marketing']
  },
  {
    id: 'lnch-04',
    s: 'todo',
    title: 'Set up analytics tracking',
    p: 1,
    due: 10,
    tags: ['engineering']
  },
  {
    id: 'lnch-05',
    s: 'todo',
    title: 'Finalize pricing strategy',
    desc: 'Compare competitor pricing, model unit economics',
    p: 3,
    due: 2,
    tags: ['strategy', 'finance']
  },
  {
    id: 'lnch-06',
    s: 'todo',
    title: 'Create onboarding email sequence',
    p: 1,
    due: 12,
    tags: ['marketing', 'content']
  },
  { id: 'lnch-07', s: 'todo', title: 'Prepare demo video script', p: 2, due: 8, tags: ['content'] },
  {
    id: 'lnch-08',
    s: 'todo',
    title: 'Book venue for launch event',
    p: 0,
    due: 14,
    tags: ['launch']
  },
  {
    id: 'lnch-09',
    s: 'progress',
    title: 'Build checkout flow',
    desc: 'Stripe integration with coupon support',
    p: 3,
    due: 1,
    tags: ['engineering']
  },
  {
    id: 'lnch-10',
    s: 'progress',
    title: 'QA regression testing',
    p: 2,
    due: 0,
    tags: ['qa', 'engineering'],
    repeat: weekdayRepeat(),
    repeatFrom: 'due'
  },
  {
    id: 'lnch-11',
    s: 'progress',
    title: 'Write API documentation',
    p: 1,
    due: 5,
    tags: ['engineering', 'content']
  },
  {
    id: 'lnch-12',
    s: 'progress',
    title: 'Social media content calendar',
    desc: 'Plan 30 days of launch content across Twitter, LinkedIn, Instagram',
    p: 2,
    due: 4,
    tags: ['marketing', 'content']
  },
  {
    id: 'lnch-13',
    s: 'progress',
    title: 'Fix critical payment bug',
    p: 3,
    due: -1,
    tags: ['engineering']
  },
  {
    id: 'lnch-14',
    s: 'progress',
    title: 'Weekly stakeholder update',
    p: 2,
    due: 0,
    dueTime: '09:00',
    tags: ['strategy'],
    repeat: weeklyRepeat(),
    repeatFrom: 'due'
  },
  {
    id: 'lnch-15',
    s: 'done',
    title: 'Set up CI/CD pipeline',
    p: 3,
    tags: ['engineering', 'devops'],
    done: 4
  },
  {
    id: 'lnch-16',
    s: 'done',
    title: 'Brand identity finalization',
    p: 2,
    tags: ['design', 'branding'],
    done: 6
  },
  {
    id: 'lnch-17',
    s: 'done',
    title: 'Market research report',
    p: 1,
    tags: ['research', 'strategy'],
    done: 8
  },
  {
    id: 'lnch-18',
    s: 'done',
    title: 'Security audit',
    desc: 'OWASP top 10 review, dependency scan, pen testing',
    p: 3,
    tags: ['engineering', 'security'],
    done: 2
  },
  {
    id: 'lnch-19',
    s: 'done',
    title: 'Competitor feature matrix',
    p: 1,
    tags: ['research'],
    done: 10
  },
  {
    id: 'lnch-20',
    s: 'done',
    title: 'Investor pitch deck v2',
    p: 2,
    tags: ['strategy', 'finance'],
    done: 3
  }
]

// — Home Renovation ————————————————————————————————————

const RENOVATION_TASKS: SeedTask[] = [
  {
    id: 'reno-01',
    s: 'todo',
    title: 'Get plumbing inspection',
    p: 3,
    due: 1,
    tags: ['plumbing', 'permits']
  },
  {
    id: 'reno-02',
    s: 'todo',
    title: 'Choose kitchen backsplash tiles',
    desc: 'Visit 3 showrooms, compare subway vs mosaic styles',
    p: 2,
    due: 5,
    tags: ['kitchen', 'design']
  },
  {
    id: 'reno-03',
    s: 'todo',
    title: 'Research smart thermostats',
    p: 1,
    due: 10,
    tags: ['electrical']
  },
  {
    id: 'reno-04',
    s: 'todo',
    title: 'Schedule electrician for rewiring',
    p: 2,
    due: 4,
    tags: ['electrical']
  },
  {
    id: 'reno-05',
    s: 'todo',
    title: 'Order custom cabinets',
    desc: 'Lead time 6-8 weeks, confirm measurements first',
    p: 3,
    due: 2,
    tags: ['kitchen']
  },
  {
    id: 'reno-06',
    s: 'todo',
    title: 'Paint color samples for bedroom',
    p: 0,
    due: 14,
    tags: ['design']
  },
  {
    id: 'reno-07',
    s: 'todo',
    title: 'Get quotes for window replacement',
    p: 1,
    due: 12,
    tags: ['budget']
  },
  {
    id: 'reno-08',
    s: 'todo',
    title: 'Weekly progress photos',
    p: 1,
    due: 0,
    tags: ['budget'],
    repeat: weeklyRepeat(),
    repeatFrom: 'due'
  },
  {
    id: 'reno-09',
    s: 'todo',
    title: 'Monthly contractor payment',
    p: 2,
    due: 30,
    tags: ['budget', 'contractor'],
    repeat: monthlyRepeat(1),
    repeatFrom: 'due'
  },
  {
    id: 'reno-10',
    s: 'progress',
    title: 'Kitchen countertop installation',
    desc: 'Granite slab install — 3-day job',
    p: 3,
    due: -1,
    tags: ['kitchen']
  },
  {
    id: 'reno-10a',
    s: 'done',
    title: 'Measure countertop dimensions',
    p: 0,
    parentId: 'reno-10',
    done: 3
  },
  { id: 'reno-10b', s: 'progress', title: 'Remove old countertops', p: 0, parentId: 'reno-10' },
  { id: 'reno-10c', s: 'todo', title: 'Install granite slabs', p: 0, parentId: 'reno-10' },
  {
    id: 'reno-11',
    s: 'progress',
    title: 'Bathroom tile grouting',
    p: 2,
    due: 1,
    tags: ['bathroom']
  },
  {
    id: 'reno-12',
    s: 'progress',
    title: 'Sand and refinish hardwood floors',
    p: 2,
    due: 3,
    tags: ['flooring']
  },
  {
    id: 'reno-13',
    s: 'progress',
    title: 'Install recessed lighting',
    p: 1,
    due: 6,
    tags: ['electrical']
  },
  {
    id: 'reno-14',
    s: 'done',
    title: 'Demolish old kitchen wall',
    p: 3,
    tags: ['kitchen', 'demolition'],
    done: 7
  },
  { id: 'reno-15', s: 'done', title: 'Obtain building permits', p: 3, tags: ['permits'], done: 14 },
  {
    id: 'reno-16',
    s: 'done',
    title: 'Hire general contractor',
    p: 2,
    tags: ['contractor'],
    done: 21
  },
  { id: 'reno-17', s: 'done', title: 'Fix roof leak', p: 3, tags: ['outdoor'], done: 5 }
]

// — Fitness & Wellness —————————————————————————————————

const FITNESS_TASKS: SeedTask[] = [
  { id: 'fit-01', s: 'todo', title: 'Book annual physical exam', p: 2, due: 14, tags: ['goals'] },
  {
    id: 'fit-02',
    s: 'todo',
    title: 'Research protein powder brands',
    desc: 'Compare whey isolate vs plant-based options',
    p: 1,
    due: 7,
    tags: ['nutrition', 'supplements']
  },
  { id: 'fit-03', s: 'todo', title: 'Buy new running shoes', p: 1, due: 10, tags: ['cardio'] },
  {
    id: 'fit-04',
    s: 'todo',
    title: 'Set up home gym corner',
    desc: 'Adjustable dumbbells, pull-up bar, yoga mat',
    p: 2,
    due: 5,
    tags: ['strength']
  },
  {
    id: 'fit-05',
    s: 'todo',
    title: 'Create stretching routine',
    p: 0,
    due: 8,
    tags: ['mobility', 'recovery']
  },
  {
    id: 'fit-06',
    s: 'todo',
    title: 'Find a swimming pool nearby',
    p: 0,
    due: 12,
    tags: ['cardio']
  },
  {
    id: 'fit-07',
    s: 'todo',
    title: 'Daily morning workout',
    p: 3,
    due: 0,
    dueTime: '07:00',
    tags: ['strength', 'cardio'],
    repeat: dailyRepeat(),
    repeatFrom: 'completion'
  },
  {
    id: 'fit-08',
    s: 'todo',
    title: 'Weekly meal prep',
    p: 2,
    due: 0,
    tags: ['nutrition'],
    repeat: weeklyRepeat(),
    repeatFrom: 'due'
  },
  {
    id: 'fit-09',
    s: 'todo',
    title: 'Monthly body measurements',
    p: 1,
    due: 30,
    tags: ['goals'],
    repeat: monthlyRepeat(1),
    repeatFrom: 'due'
  },
  {
    id: 'fit-10',
    s: 'progress',
    title: 'Complete C25K program',
    desc: 'Couch to 5K — currently on week 5',
    p: 2,
    due: 21,
    tags: ['cardio', 'goals']
  },
  {
    id: 'fit-10a',
    s: 'done',
    title: 'Weeks 1-3: Walk/run intervals',
    p: 0,
    parentId: 'fit-10',
    done: 14
  },
  { id: 'fit-10b', s: 'progress', title: 'Weeks 4-6: Extended runs', p: 0, parentId: 'fit-10' },
  { id: 'fit-10c', s: 'todo', title: 'Weeks 7-9: Full 5K distance', p: 0, parentId: 'fit-10' },
  {
    id: 'fit-11',
    s: 'progress',
    title: 'Track daily water intake',
    p: 1,
    due: 0,
    tags: ['nutrition'],
    repeat: dailyRepeat(),
    repeatFrom: 'completion'
  },
  {
    id: 'fit-12',
    s: 'progress',
    title: 'Foam rolling routine',
    p: 1,
    due: 1,
    tags: ['recovery', 'mobility']
  },
  {
    id: 'fit-13',
    s: 'progress',
    title: 'Sleep schedule optimization',
    desc: 'Target 10:30pm bedtime, track with app',
    p: 2,
    due: 3,
    tags: ['sleep', 'goals']
  },
  {
    id: 'fit-14',
    s: 'done',
    title: 'Complete beginner yoga series',
    p: 1,
    tags: ['mobility', 'recovery'],
    done: 5
  },
  { id: 'fit-15', s: 'done', title: 'Get blood work done', p: 3, tags: ['goals'], done: 10 },
  {
    id: 'fit-16',
    s: 'done',
    title: 'Set macro targets',
    desc: 'Protein 150g, carbs 200g, fat 70g',
    p: 2,
    tags: ['nutrition', 'goals'],
    done: 12
  },
  { id: 'fit-17', s: 'done', title: 'Buy resistance bands set', p: 0, tags: ['strength'], done: 8 }
]

// — Side Project ———————————————————————————————————————

const SIDEPROJECT_TASKS: SeedTask[] = [
  {
    id: 'side-01',
    s: 'todo',
    title: 'Design database schema',
    desc: 'Users, teams, invitations, audit log tables',
    p: 3,
    due: 3,
    tags: ['database', 'backend']
  },
  {
    id: 'side-02',
    s: 'todo',
    title: 'Set up Tailwind design tokens',
    p: 2,
    due: 5,
    tags: ['frontend', 'ux']
  },
  {
    id: 'side-03',
    s: 'todo',
    title: 'Write user stories for MVP',
    p: 2,
    due: 2,
    tags: ['ux', 'mvp']
  },
  {
    id: 'side-04',
    s: 'todo',
    title: 'Research hosting options',
    desc: 'Compare Vercel vs Fly.io vs Railway for cost and DX',
    p: 1,
    due: 7,
    tags: ['deployment']
  },
  {
    id: 'side-05',
    s: 'todo',
    title: 'Create error boundary components',
    p: 1,
    due: 10,
    tags: ['frontend']
  },
  {
    id: 'side-06',
    s: 'todo',
    title: 'Plan monetization strategy',
    p: 0,
    due: 21,
    tags: ['mvp', 'strategy']
  },
  {
    id: 'side-07',
    s: 'todo',
    title: 'Weekly code review session',
    p: 2,
    due: 0,
    tags: ['engineering'],
    repeat: weeklyRepeat(),
    repeatFrom: 'due'
  },
  {
    id: 'side-08',
    s: 'todo',
    title: 'Monthly analytics review',
    p: 1,
    due: 30,
    tags: ['strategy'],
    repeat: monthlyRepeat(15),
    repeatFrom: 'due'
  },
  {
    id: 'side-09',
    s: 'progress',
    title: 'Build authentication system',
    desc: 'Email/password + OAuth with Google',
    p: 3,
    due: 1,
    tags: ['backend', 'security']
  },
  {
    id: 'side-09a',
    s: 'done',
    title: 'Set up Lucia auth library',
    p: 0,
    parentId: 'side-09',
    done: 3
  },
  { id: 'side-09b', s: 'progress', title: 'Email/password flow', p: 0, parentId: 'side-09' },
  { id: 'side-09c', s: 'todo', title: 'Google OAuth integration', p: 0, parentId: 'side-09' },
  {
    id: 'side-10',
    s: 'progress',
    title: 'REST API scaffolding',
    p: 2,
    due: 2,
    tags: ['api', 'backend']
  },
  {
    id: 'side-11',
    s: 'progress',
    title: 'Dashboard layout',
    desc: 'Sidebar nav, header with user menu, main content area',
    p: 2,
    due: 4,
    tags: ['frontend', 'ux']
  },
  {
    id: 'side-12',
    s: 'progress',
    title: 'Write integration tests',
    p: 1,
    due: 6,
    tags: ['testing', 'backend']
  },
  {
    id: 'side-13',
    s: 'progress',
    title: 'Daily standup notes',
    p: 1,
    due: 0,
    tags: ['engineering'],
    repeat: weekdayRepeat(),
    repeatFrom: 'due'
  },
  {
    id: 'side-14',
    s: 'done',
    title: 'Initialize monorepo structure',
    p: 3,
    tags: ['engineering', 'devops'],
    done: 14
  },
  {
    id: 'side-15',
    s: 'done',
    title: 'Choose tech stack',
    desc: 'Next.js 15, Drizzle ORM, PostgreSQL, Tailwind',
    p: 3,
    tags: ['engineering'],
    done: 21
  },
  { id: 'side-16', s: 'done', title: 'Create wireframes', p: 2, tags: ['ux', 'design'], done: 10 },
  {
    id: 'side-17',
    s: 'done',
    title: 'Set up GitHub repo with CI',
    p: 1,
    tags: ['devops', 'deployment'],
    done: 18
  }
]

// ============================================================================
// All task groups mapped to their project
// ============================================================================

const TASK_GROUPS: ReadonlyArray<{ projectId: string; tasks: SeedTask[] }> = [
  { projectId: 'project-launch', tasks: LAUNCH_TASKS },
  { projectId: 'project-renovation', tasks: RENOVATION_TASKS },
  { projectId: 'project-fitness', tasks: FITNESS_TASKS },
  { projectId: 'project-sideproject', tasks: SIDEPROJECT_TASKS }
]

// ============================================================================
// Seed Functions
// ============================================================================

export function seedSampleTasks(db: DrizzleDb): void {
  seedTagDefs(db)
  seedProjects(db)
  seedTaskData(db)
}

function seedTagDefs(db: DrizzleDb): void {
  for (const [name, color] of Object.entries(TAG_COLORS)) {
    const existing = db.select().from(tagDefinitions).where(eq(tagDefinitions.name, name)).get()
    if (existing) continue

    db.insert(tagDefinitions).values({ name, color, createdAt: getNow() }).run()
  }

  logger.info(`Seeded ${Object.keys(TAG_COLORS).length} tag definitions`)
}

function seedProjects(db: DrizzleDb): void {
  for (const config of PROJECT_CONFIGS) {
    const existing = db.select().from(projects).where(eq(projects.id, config.id)).get()
    if (existing) continue

    const now = getNow()

    db.insert(projects)
      .values({
        id: config.id,
        name: config.name,
        description: config.description,
        color: config.color,
        icon: config.icon,
        position: config.position,
        isInbox: false,
        createdAt: now,
        modifiedAt: now
      })
      .run()

    db.insert(statuses)
      .values([
        {
          id: `${config.id}-todo`,
          projectId: config.id,
          name: 'To Do',
          color: '#6b7280',
          position: 0,
          isDefault: true,
          isDone: false,
          createdAt: now
        },
        {
          id: `${config.id}-in-progress`,
          projectId: config.id,
          name: 'In Progress',
          color: '#F59E0B',
          position: 1,
          isDefault: false,
          isDone: false,
          createdAt: now
        },
        {
          id: `${config.id}-done`,
          projectId: config.id,
          name: 'Done',
          color: '#22c55e',
          position: 2,
          isDefault: false,
          isDone: true,
          createdAt: now
        }
      ])
      .run()

    logger.info(`Seeded project "${config.name}" with statuses`)
  }
}

function seedTaskData(db: DrizzleDb): void {
  let totalSeeded = 0

  for (const { projectId, tasks: seedTasks } of TASK_GROUPS) {
    for (let i = 0; i < seedTasks.length; i++) {
      const t = seedTasks[i]
      const fullId = `task-${t.id}`

      const existing = db.select().from(tasks).where(eq(tasks.id, fullId)).get()
      if (existing) continue

      const now = getNow()
      const dueDate = t.due !== undefined ? getRelativeDate(t.due) : null
      const parentId = t.parentId ? `task-${t.parentId}` : null

      db.insert(tasks)
        .values({
          id: fullId,
          projectId: parentId
            ? (db.select().from(tasks).where(eq(tasks.id, parentId)).get()?.projectId ?? projectId)
            : projectId,
          statusId: statusId(projectId, t.s),
          parentId,
          title: t.title,
          description: t.desc ?? null,
          priority: t.p,
          position: i,
          dueDate,
          dueTime: t.dueTime ?? null,
          startDate: t.startDate !== undefined ? getRelativeDate(t.startDate) : null,
          repeatConfig: t.repeat ?? null,
          repeatFrom: t.repeatFrom ?? null,
          completedAt: t.done !== undefined ? completedAt(t.done) : null,
          createdAt: now,
          modifiedAt: now
        })
        .run()

      if (t.tags && t.tags.length > 0) {
        db.insert(taskTags)
          .values(t.tags.map((tag) => ({ taskId: fullId, tag })))
          .run()
      }

      totalSeeded++
    }
  }

  logger.info(`Seeded ${totalSeeded} sample tasks across ${TASK_GROUPS.length} projects`)
}
