/**
 * Calendar Database Seed
 *
 * Populates the calendar page with every visualType branch the projection
 * can emit (event, task, reminder, snooze, external_event) so the calendar
 * week/day views render a rich, tweet-ready demo.
 *
 * @module database/seed-calendar
 */

import { eq } from 'drizzle-orm'
import {
  calendarEvents,
  calendarExternalEvents,
  calendarSources,
  inboxItems,
  reminders,
  tasks,
  projects,
  statuses
} from '@memry/db-schema/schema'
import type { DataDb } from './types'
import { createLogger } from '../lib/logger'

const logger = createLogger('Seed:Calendar')

// ============================================================================
// Date helpers (all "local intent" — JS Date honors the machine TZ)
// ============================================================================

function localIso(offsetDays: number, hours: number, minutes = 0): string {
  const date = new Date()
  date.setDate(date.getDate() + offsetDays)
  date.setHours(hours, minutes, 0, 0)
  return date.toISOString()
}

function localDateStr(offsetDays: number): string {
  const date = new Date()
  date.setDate(date.getDate() + offsetDays)
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function allDayStart(offsetDays: number): string {
  return localIso(offsetDays, 0, 0)
}

function allDayEnd(offsetDays: number): string {
  return localIso(offsetDays + 1, 0, 0)
}

function now(): string {
  return new Date().toISOString()
}

// ============================================================================
// Entry point
// ============================================================================

export function seedSampleCalendar(db: DataDb): void {
  seedCalendarSources(db)
  seedNativeEvents(db)
  seedExternalEvents(db)
  seedCalendarTasks(db)
  seedReminders(db)
  seedInboxSnoozes(db)
}

// ============================================================================
// Calendar sources (required by calendar_external_events FK)
// ============================================================================

const SOURCE_GOOGLE_ACCOUNT = 'seed-cal-src-google-account'
const SOURCE_GOOGLE_PRIMARY = 'seed-cal-src-google-primary'
const SOURCE_GOOGLE_PERSONAL = 'seed-cal-src-google-personal'

function seedCalendarSources(db: DataDb): void {
  const rows = [
    {
      id: SOURCE_GOOGLE_ACCOUNT,
      provider: 'google',
      kind: 'account' as const,
      accountId: null,
      remoteId: 'kaan@memry.demo',
      title: 'Google (kaan@memry.demo)',
      timezone: 'America/Los_Angeles',
      color: '#4285F4',
      isPrimary: true,
      isSelected: true,
      isMemryManaged: false
    },
    {
      id: SOURCE_GOOGLE_PRIMARY,
      provider: 'google',
      kind: 'calendar' as const,
      accountId: SOURCE_GOOGLE_ACCOUNT,
      remoteId: 'primary',
      title: 'Work',
      timezone: 'America/Los_Angeles',
      color: '#1a73e8',
      isPrimary: true,
      isSelected: true,
      isMemryManaged: false
    },
    {
      id: SOURCE_GOOGLE_PERSONAL,
      provider: 'google',
      kind: 'calendar' as const,
      accountId: SOURCE_GOOGLE_ACCOUNT,
      remoteId: 'kaan.personal@gmail.com',
      title: 'Personal',
      timezone: 'America/Los_Angeles',
      color: '#f4511e',
      isPrimary: false,
      isSelected: true,
      isMemryManaged: false
    }
  ]

  for (const row of rows) {
    const existing = db.select().from(calendarSources).where(eq(calendarSources.id, row.id)).get()
    if (existing) continue

    db.insert(calendarSources)
      .values({ ...row, createdAt: now(), modifiedAt: now() })
      .run()
  }

  logger.info(`Seeded ${rows.length} calendar sources`)
}

// ============================================================================
// Native Memry events — full visual variety
// ============================================================================

interface SeedEvent {
  id: string
  title: string
  description?: string
  location?: string
  startAt: string
  endAt: string | null
  isAllDay?: boolean
  attendees?: Array<{
    email: string
    displayName?: string
    responseStatus?: 'accepted' | 'declined' | 'tentative' | 'needsAction'
    optional?: boolean
    organizer?: boolean
    self?: boolean
  }>
  meetUri?: string
  reminders?: {
    useDefault: boolean
    overrides: Array<{ method: 'popup' | 'email'; minutes: number }>
  }
  visibility?: 'default' | 'public' | 'private' | 'confidential'
  colorId?: string
  recurrenceRule?: Record<string, unknown>
}

function nativeEvents(): SeedEvent[] {
  return [
    {
      id: 'seed-cal-evt-01-launch-week',
      title: '🚀 Product Launch Week',
      description: 'All hands on deck — ship campaigns Mon through Fri.',
      startAt: allDayStart(-1),
      endAt: allDayEnd(4),
      isAllDay: true,
      colorId: '11'
    },
    {
      id: 'seed-cal-evt-02-standup',
      title: 'Team standup',
      description: 'Daily 15-min sync: what shipped, what is blocked.',
      location: 'Google Meet',
      startAt: localIso(0, 9, 0),
      endAt: localIso(0, 9, 15),
      attendees: [
        {
          email: 'kaan@memry.demo',
          displayName: 'Kaan',
          responseStatus: 'accepted',
          self: true,
          organizer: true
        },
        { email: 'sarah@memry.demo', displayName: 'Sarah Chen', responseStatus: 'accepted' },
        { email: 'ethan@memry.demo', displayName: 'Ethan Park', responseStatus: 'accepted' },
        { email: 'ria@memry.demo', displayName: 'Ria Patel', responseStatus: 'tentative' }
      ],
      meetUri: 'https://meet.google.com/demo-stnd-up',
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 5 }] },
      recurrenceRule: { freq: 'weekly', byDay: ['MO', 'TU', 'WE', 'TH', 'FR'] }
    },
    {
      id: 'seed-cal-evt-03-design-review',
      title: 'Design review — calendar v2',
      description:
        'Walk through week/day view specs. Focus on chip density, color tokens, and overlap stacking.',
      location: 'Figma — Calendar v2 board',
      startAt: localIso(0, 11, 0),
      endAt: localIso(0, 12, 0),
      attendees: [
        {
          email: 'kaan@memry.demo',
          displayName: 'Kaan',
          responseStatus: 'accepted',
          self: true,
          organizer: true
        },
        { email: 'design@memry.demo', displayName: 'Design team', responseStatus: 'accepted' }
      ],
      meetUri: 'https://meet.google.com/demo-design',
      reminders: { useDefault: true, overrides: [] }
    },
    {
      id: 'seed-cal-evt-04-discovery',
      title: 'Customer discovery — Acme Corp',
      description: 'Interview: calendar pain points, workflow around recurring events.',
      startAt: localIso(0, 14, 0),
      endAt: localIso(0, 15, 30),
      attendees: [
        {
          email: 'kaan@memry.demo',
          displayName: 'Kaan',
          responseStatus: 'accepted',
          self: true,
          organizer: true
        },
        { email: 'jane@acme.example', displayName: 'Jane Doe (Acme)', responseStatus: 'accepted' },
        {
          email: 'advisor@memry.demo',
          displayName: 'Advisor',
          responseStatus: 'tentative',
          optional: true
        }
      ]
    },
    {
      id: 'seed-cal-evt-05-quick-sync',
      title: 'Quick sync w/ Sarah',
      description: 'Overlaps on purpose — demonstrates stacked chip layout.',
      startAt: localIso(0, 15, 0),
      endAt: localIso(0, 15, 30),
      attendees: [
        {
          email: 'sarah@memry.demo',
          displayName: 'Sarah Chen',
          responseStatus: 'accepted',
          organizer: true
        },
        { email: 'kaan@memry.demo', displayName: 'Kaan', responseStatus: 'accepted', self: true }
      ]
    },
    {
      id: 'seed-cal-evt-06-dinner',
      title: 'Dinner w/ investors',
      description: 'Quince, 8 guests, reservation under Karaca.',
      location: 'Quince — 470 Pacific Ave, SF',
      startAt: localIso(0, 18, 30),
      endAt: localIso(0, 20, 0),
      visibility: 'private',
      colorId: '5'
    },
    {
      id: 'seed-cal-evt-07-one-on-one',
      title: '1:1 with manager',
      startAt: localIso(1, 10, 0),
      endAt: localIso(1, 11, 0),
      attendees: [
        {
          email: 'manager@memry.demo',
          displayName: 'Manager',
          responseStatus: 'accepted',
          organizer: true
        },
        { email: 'kaan@memry.demo', displayName: 'Kaan', responseStatus: 'accepted', self: true }
      ],
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] }
    },
    {
      id: 'seed-cal-evt-08-lunch',
      title: 'Lunch break 🥗',
      startAt: localIso(1, 13, 0),
      endAt: localIso(1, 14, 0),
      visibility: 'private'
    },
    {
      id: 'seed-cal-evt-09-offsite',
      title: 'Company offsite — Q3 planning',
      description: 'Breakout sessions: growth, platform, design. Lunch catered.',
      location: 'Mission Bay Conference Center',
      startAt: localIso(2, 9, 0),
      endAt: localIso(2, 17, 0),
      attendees: [
        { email: 'kaan@memry.demo', displayName: 'Kaan', responseStatus: 'accepted', self: true },
        {
          email: 'everyone@memry.demo',
          displayName: 'Everyone @ Memry',
          responseStatus: 'accepted'
        }
      ],
      meetUri: 'https://meet.google.com/demo-offsite'
    },
    {
      id: 'seed-cal-evt-10-birthday',
      title: "🎂 Sam's birthday",
      startAt: allDayStart(3),
      endAt: allDayEnd(3),
      isAllDay: true,
      colorId: '6'
    },
    {
      id: 'seed-cal-evt-11-retro',
      title: 'Weekly retro',
      description: 'What went well, what to improve, what to keep doing.',
      startAt: localIso(-1, 16, 0),
      endAt: localIso(-1, 17, 0),
      attendees: [
        {
          email: 'kaan@memry.demo',
          displayName: 'Kaan',
          responseStatus: 'accepted',
          self: true,
          organizer: true
        },
        { email: 'team@memry.demo', displayName: 'Core team', responseStatus: 'accepted' }
      ],
      recurrenceRule: { freq: 'weekly', byDay: ['WE'] }
    }
  ]
}

function seedNativeEvents(db: DataDb): void {
  let count = 0

  for (const evt of nativeEvents()) {
    const existing = db.select().from(calendarEvents).where(eq(calendarEvents.id, evt.id)).get()
    if (existing) continue

    const conferenceData = evt.meetUri
      ? {
          conferenceId: `demo-${evt.id}`,
          conferenceSolution: { name: 'Google Meet', key: { type: 'hangoutsMeet' } },
          entryPoints: [{ entryPointType: 'video', uri: evt.meetUri, label: 'meet.google.com' }]
        }
      : null

    db.insert(calendarEvents)
      .values({
        id: evt.id,
        title: evt.title,
        description: evt.description ?? null,
        location: evt.location ?? null,
        startAt: evt.startAt,
        endAt: evt.endAt,
        timezone: 'America/Los_Angeles',
        isAllDay: evt.isAllDay ?? false,
        recurrenceRule: evt.recurrenceRule ?? null,
        recurrenceExceptions: null,
        attendees: evt.attendees ?? null,
        reminders: evt.reminders ?? null,
        visibility: evt.visibility ?? null,
        colorId: evt.colorId ?? null,
        conferenceData,
        parentEventId: null,
        originalStartTime: null,
        targetCalendarId: null,
        archivedAt: null,
        createdAt: now(),
        modifiedAt: now()
      })
      .run()

    count++
  }

  logger.info(`Seeded ${count} native calendar events`)
}

// ============================================================================
// External (Google) events
// ============================================================================

interface SeedExternalEvent {
  id: string
  sourceId: string
  title: string
  description?: string
  location?: string
  startAt: string
  endAt: string | null
  isAllDay?: boolean
  colorId?: string
  attendees?: Array<{
    email: string
    displayName?: string
    responseStatus?: 'accepted' | 'tentative'
  }>
  recurrenceRule?: Record<string, unknown>
}

function externalEvents(): SeedExternalEvent[] {
  return [
    {
      id: 'seed-cal-ext-01-lunch',
      sourceId: SOURCE_GOOGLE_PRIMARY,
      title: 'Lunch @ Tartine',
      location: 'Tartine Bakery, 600 Guerrero St',
      startAt: localIso(0, 12, 0),
      endAt: localIso(0, 13, 0),
      attendees: [
        { email: 'alex@friends.example', displayName: 'Alex', responseStatus: 'accepted' }
      ]
    },
    {
      id: 'seed-cal-ext-02-gym',
      sourceId: SOURCE_GOOGLE_PERSONAL,
      title: '🏋️ Gym — lifting',
      startAt: localIso(1, 8, 0),
      endAt: localIso(1, 8, 45),
      recurrenceRule: { freq: 'weekly', byDay: ['TU', 'TH', 'SA'] },
      colorId: '10'
    },
    {
      id: 'seed-cal-ext-03-flight',
      sourceId: SOURCE_GOOGLE_PERSONAL,
      title: '✈️ Flight SFO → JFK (UA 58)',
      description: 'Terminal 3, gate B20. Check in online.',
      startAt: allDayStart(4),
      endAt: allDayEnd(4),
      isAllDay: true,
      colorId: '9'
    },
    {
      id: 'seed-cal-ext-04-board',
      sourceId: SOURCE_GOOGLE_PRIMARY,
      title: 'Board update call',
      description: 'Monthly board sync — metrics deck + runway update.',
      startAt: localIso(2, 15, 0),
      endAt: localIso(2, 16, 0),
      attendees: [{ email: 'board@memry.demo', displayName: 'Board', responseStatus: 'accepted' }]
    }
  ]
}

function seedExternalEvents(db: DataDb): void {
  let count = 0

  for (const evt of externalEvents()) {
    const existing = db
      .select()
      .from(calendarExternalEvents)
      .where(eq(calendarExternalEvents.id, evt.id))
      .get()
    if (existing) continue

    db.insert(calendarExternalEvents)
      .values({
        id: evt.id,
        sourceId: evt.sourceId,
        remoteEventId: evt.id,
        remoteEtag: `"demo-etag-${evt.id}"`,
        remoteUpdatedAt: now(),
        title: evt.title,
        description: evt.description ?? null,
        location: evt.location ?? null,
        startAt: evt.startAt,
        endAt: evt.endAt,
        timezone: 'America/Los_Angeles',
        isAllDay: evt.isAllDay ?? false,
        status: 'confirmed',
        recurrenceRule: evt.recurrenceRule ?? null,
        attendees: evt.attendees ?? null,
        reminders: null,
        visibility: null,
        colorId: evt.colorId ?? null,
        conferenceData: null,
        rawPayload: null,
        archivedAt: null,
        createdAt: now(),
        modifiedAt: now()
      })
      .run()

    count++
  }

  logger.info(`Seeded ${count} external calendar events`)
}

// ============================================================================
// Tasks that surface on the calendar via due date
// ============================================================================

interface SeedCalendarTask {
  id: string
  title: string
  description?: string
  dueDayOffset: number
  dueTime: string | null
  priority: number
}

function calendarTasks(): SeedCalendarTask[] {
  return [
    {
      id: 'seed-cal-task-01',
      title: 'Review PR #1234 — calendar chips',
      description: 'Feedback on overlap stacking algorithm.',
      dueDayOffset: 0,
      dueTime: '16:00',
      priority: 2
    },
    {
      id: 'seed-cal-task-02',
      title: 'Draft launch tweet',
      dueDayOffset: 0,
      dueTime: null,
      priority: 3
    },
    {
      id: 'seed-cal-task-03',
      title: 'Send invoice to Acme Corp',
      dueDayOffset: 1,
      dueTime: '17:00',
      priority: 1
    },
    {
      id: 'seed-cal-task-04',
      title: 'Pack for NYC trip',
      dueDayOffset: 3,
      dueTime: null,
      priority: 2
    },
    {
      id: 'seed-cal-task-05',
      title: 'Submit expense report',
      dueDayOffset: -1,
      dueTime: '09:00',
      priority: 1
    }
  ]
}

function ensureInboxProject(db: DataDb): void {
  const existing = db.select().from(projects).where(eq(projects.id, 'inbox')).get()
  if (existing) return

  db.insert(projects)
    .values({
      id: 'inbox',
      name: 'Inbox',
      description: 'Quick capture for tasks',
      color: '#6366f1',
      icon: '📥',
      position: 0,
      isInbox: true,
      createdAt: now(),
      modifiedAt: now()
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
        createdAt: now()
      },
      {
        id: 'inbox-done',
        projectId: 'inbox',
        name: 'Done',
        color: '#22c55e',
        position: 1,
        isDefault: false,
        isDone: true,
        createdAt: now()
      }
    ])
    .run()
}

function seedCalendarTasks(db: DataDb): void {
  ensureInboxProject(db)
  let count = 0

  for (const [index, task] of calendarTasks().entries()) {
    const existing = db.select().from(tasks).where(eq(tasks.id, task.id)).get()
    if (existing) continue

    db.insert(tasks)
      .values({
        id: task.id,
        projectId: 'inbox',
        statusId: 'inbox-todo',
        parentId: null,
        title: task.title,
        description: task.description ?? null,
        priority: task.priority,
        position: 1000 + index,
        dueDate: localDateStr(task.dueDayOffset),
        dueTime: task.dueTime,
        startDate: null,
        repeatConfig: null,
        repeatFrom: null,
        completedAt: null,
        createdAt: now(),
        modifiedAt: now()
      })
      .run()

    count++
  }

  logger.info(`Seeded ${count} calendar-visible tasks`)
}

// ============================================================================
// Reminders
// ============================================================================

interface SeedReminder {
  id: string
  targetType: 'note' | 'journal' | 'highlight'
  targetId: string
  title: string
  note?: string
  highlightText?: string
  remindAt: string
  status: 'pending' | 'snoozed'
  snoozedUntil?: string
}

function seededReminders(): SeedReminder[] {
  return [
    {
      id: 'seed-cal-rem-01',
      targetType: 'note',
      targetId: 'demo-note-proposal',
      title: 'Follow up with Ethan on proposal',
      note: 'Ping him if no reply by end of day.',
      remindAt: localIso(0, 15, 30),
      status: 'pending'
    },
    {
      id: 'seed-cal-rem-02',
      targetType: 'highlight',
      targetId: 'demo-note-patterns',
      title: 'Revisit highlight',
      highlightText: 'The best code is no code at all.',
      remindAt: localIso(1, 9, 0),
      status: 'pending'
    },
    {
      id: 'seed-cal-rem-03',
      targetType: 'journal',
      targetId: localDateStr(2),
      title: 'Plan Q3 OKRs',
      note: 'Open the journal entry and draft the top 3.',
      remindAt: localIso(2, 8, 0),
      status: 'pending'
    },
    {
      id: 'seed-cal-rem-04',
      targetType: 'note',
      targetId: 'demo-note-book',
      title: 'Finish reading chapter 4',
      note: 'Snoozed from this morning — try again tonight.',
      remindAt: localIso(0, 8, 0),
      snoozedUntil: localIso(0, 21, 0),
      status: 'snoozed'
    }
  ]
}

function seedReminders(db: DataDb): void {
  let count = 0

  for (const rem of seededReminders()) {
    const existing = db.select().from(reminders).where(eq(reminders.id, rem.id)).get()
    if (existing) continue

    db.insert(reminders)
      .values({
        id: rem.id,
        targetType: rem.targetType,
        targetId: rem.targetId,
        remindAt: rem.remindAt,
        highlightText: rem.highlightText ?? null,
        highlightStart: rem.highlightText ? 0 : null,
        highlightEnd: rem.highlightText ? rem.highlightText.length : null,
        title: rem.title,
        note: rem.note ?? null,
        status: rem.status,
        triggeredAt: null,
        dismissedAt: null,
        snoozedUntil: rem.snoozedUntil ?? null,
        createdAt: now(),
        modifiedAt: now()
      })
      .run()

    count++
  }

  logger.info(`Seeded ${count} reminders`)
}

// ============================================================================
// Inbox snoozes
// ============================================================================

interface SeedInboxSnooze {
  id: string
  type: 'link' | 'voice' | 'pdf' | 'note' | 'image'
  title: string
  content?: string
  sourceUrl?: string
  snoozeOffsetDays: number
  snoozeHour: number
  snoozeMinute?: number
  snoozeReason?: string
}

function seededSnoozes(): SeedInboxSnooze[] {
  return [
    {
      id: 'seed-cal-inbox-01',
      type: 'link',
      title: 'Linear product launch post',
      content: 'How Linear builds in public — great write-up on launch cadence.',
      sourceUrl: 'https://linear.app/blog/launch',
      snoozeOffsetDays: 0,
      snoozeHour: 20,
      snoozeReason: 'Read after dinner'
    },
    {
      id: 'seed-cal-inbox-02',
      type: 'voice',
      title: '🎙️ Podcast brainstorm',
      content: 'Voice memo: topics for next episode — calendar UX deep dive.',
      snoozeOffsetDays: 1,
      snoozeHour: 11,
      snoozeReason: 'Listen tomorrow morning'
    },
    {
      id: 'seed-cal-inbox-03',
      type: 'pdf',
      title: '📄 YC application draft v2',
      content: 'Second pass of the YC W27 application with founder videos script.',
      snoozeOffsetDays: 3,
      snoozeHour: 9,
      snoozeReason: 'Review before deadline'
    }
  ]
}

function seedInboxSnoozes(db: DataDb): void {
  let count = 0

  for (const item of seededSnoozes()) {
    const existing = db.select().from(inboxItems).where(eq(inboxItems.id, item.id)).get()
    if (existing) continue

    db.insert(inboxItems)
      .values({
        id: item.id,
        type: item.type,
        title: item.title,
        content: item.content ?? null,
        createdAt: now(),
        modifiedAt: now(),
        filedAt: null,
        filedTo: null,
        filedAction: null,
        snoozedUntil: localIso(item.snoozeOffsetDays, item.snoozeHour, item.snoozeMinute ?? 0),
        snoozeReason: item.snoozeReason ?? null,
        viewedAt: null,
        processingStatus: 'complete',
        processingError: null,
        metadata: null,
        attachmentPath: null,
        thumbnailPath: null,
        transcription: null,
        transcriptionStatus: null,
        sourceUrl: item.sourceUrl ?? null,
        sourceTitle: null,
        captureSource: 'quick-capture',
        archivedAt: null
      })
      .run()

    count++
  }

  logger.info(`Seeded ${count} inbox snoozes`)
}
