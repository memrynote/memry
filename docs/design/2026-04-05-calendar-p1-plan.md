# Calendar Integration — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a fully functional local calendar with week/month/agenda views, event CRUD, and memry-to-memry sync — no external providers yet.

**Architecture:** New `calendars` + `calendar_events` Drizzle tables, new sync handlers following the existing strategy pattern, IPC channels for renderer↔main, React calendar page with three switchable views. Calendar events are a new first-class entity, separate from tasks but visible alongside them.

**Tech Stack:** Drizzle ORM (SQLite), Zod validation, Electron IPC, React 19, Tailwind CSS 4, Radix UI, date-fns.

**Design Spec:** `docs/design/2026-04-05-calendar-integration-design.md`

---

## File Map

### New Files

```
packages/db-schema/src/schema/calendars.ts              — calendars table
packages/db-schema/src/schema/calendar-events.ts         — calendar_events table
packages/contracts/src/calendar-api.ts                    — Zod schemas + types
packages/contracts/src/calendar-sync-payloads.ts          — sync payload schemas

apps/desktop/src/main/calendar/
  ├── calendar-service.ts                                — CRUD for calendars + events
  └── calendar-query.ts                                  — date-range queries, task joining

apps/desktop/src/main/ipc/calendar-handlers.ts           — IPC handler registration
apps/desktop/src/main/sync/item-handlers/calendar-handler.ts
apps/desktop/src/main/sync/item-handlers/calendar-event-handler.ts
apps/desktop/src/main/sync/calendar-field-merge.ts       — syncable fields + merge

apps/desktop/src/renderer/src/services/calendar-service.ts
apps/desktop/src/renderer/src/pages/calendar.tsx
apps/desktop/src/renderer/src/components/calendar/
  ├── calendar-header.tsx                                — nav, view toggle, filters
  ├── calendar-week-view.tsx                             — 7-day time grid
  ├── calendar-month-view.tsx                            — month grid with pills
  ├── calendar-agenda-view.tsx                           — scrolling day groups
  ├── calendar-event-block.tsx                           — event rendering in week view
  ├── calendar-event-pill.tsx                            — event rendering in month view
  ├── calendar-event-popover.tsx                         — click-to-view popover
  ├── calendar-event-dialog.tsx                          — create/edit dialog
  ├── calendar-time-grid.tsx                             — shared time slot grid
  └── calendar-utils.ts                                  — date helpers, grid math
apps/desktop/src/renderer/src/hooks/use-calendar.ts      — calendar state + IPC
apps/desktop/src/renderer/src/hooks/use-calendar-events.ts — event queries + mutations
```

### Modified Files

```
packages/db-schema/src/schema/index.ts                   — export new tables
packages/db-schema/src/data-schema.ts                    — add to data schema
packages/contracts/src/ipc-channels.ts                   — add CalendarChannels
packages/contracts/src/sync-api.ts                       — add 'calendar' + 'calendar_event' to SYNC_ITEM_TYPES
packages/contracts/src/sync-payloads.ts                  — re-export calendar payloads
apps/desktop/src/main/sync/item-handlers/index.ts        — register new handlers
apps/desktop/src/main/sync/field-merge.ts                — add CALENDAR_SYNCABLE_FIELDS + CALENDAR_EVENT_SYNCABLE_FIELDS
apps/desktop/src/main/ipc/index.ts                       — register calendar handlers
apps/desktop/src/preload/index.ts                        — expose calendar API
apps/desktop/src/renderer/src/App.tsx                    — add 'calendar' to AppPage type
apps/desktop/src/renderer/src/components/app-sidebar.tsx — add Calendar nav item
```

---

## Task 1: Database Schema

**Files:**
- Create: `packages/db-schema/src/schema/calendars.ts`
- Create: `packages/db-schema/src/schema/calendar-events.ts`
- Modify: `packages/db-schema/src/schema/index.ts`
- Modify: `packages/db-schema/src/data-schema.ts`

- [ ] **Step 1: Create calendars table**

```typescript
// packages/db-schema/src/schema/calendars.ts
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'
import type { VectorClock, FieldClocks } from '@memry/contracts/sync-api'

export const calendars = sqliteTable(
  'calendars',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    color: text('color').notNull().default('#6366f1'),
    icon: text('icon'),
    position: integer('position').notNull().default(0),
    isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
    isVisible: integer('is_visible', { mode: 'boolean' }).notNull().default(true),
    providerId: text('provider_id'),
    externalCalendarId: text('external_calendar_id'),
    syncEnabled: integer('sync_enabled', { mode: 'boolean' }).notNull().default(false),
    clock: text('clock', { mode: 'json' }).$type<VectorClock>(),
    fieldClocks: text('field_clocks', { mode: 'json' }).$type<FieldClocks>(),
    syncedAt: text('synced_at'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    modifiedAt: text('modified_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (table) => [
    index('idx_calendars_provider').on(table.providerId),
    index('idx_calendars_position').on(table.position)
  ]
)

export type Calendar = typeof calendars.$inferSelect
export type NewCalendar = typeof calendars.$inferInsert
```

- [ ] **Step 2: Create calendar_events table**

```typescript
// packages/db-schema/src/schema/calendar-events.ts
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'
import type { VectorClock, FieldClocks } from '@memry/contracts/sync-api'
import { calendars } from './calendars'

export const calendarEvents = sqliteTable(
  'calendar_events',
  {
    id: text('id').primaryKey(),
    calendarId: text('calendar_id')
      .notNull()
      .references(() => calendars.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    location: text('location'),
    startAt: text('start_at').notNull(),
    endAt: text('end_at').notNull(),
    isAllDay: integer('is_all_day', { mode: 'boolean' }).notNull().default(false),
    timezone: text('timezone').notNull().default('UTC'),
    recurrenceRule: text('recurrence_rule'),
    recurrenceExceptions: text('recurrence_exceptions', { mode: 'json' }).$type<string[]>(),
    recurringEventId: text('recurring_event_id'),
    status: text('status').notNull().default('confirmed'),
    color: text('color'),
    reminders: text('reminders', { mode: 'json' }).$type<{ method: string; minutes: number }[]>(),
    attendees: text('attendees', { mode: 'json' }).$type<
      { email: string; name?: string; status?: string; isOrganizer?: boolean }[]
    >(),
    externalEventId: text('external_event_id'),
    externalICalUid: text('external_ical_uid'),
    externalEtag: text('external_etag'),
    lastExternalSync: text('last_external_sync'),
    sourceType: text('source_type').notNull().default('local'),
    clock: text('clock', { mode: 'json' }).$type<VectorClock>(),
    fieldClocks: text('field_clocks', { mode: 'json' }).$type<FieldClocks>(),
    syncedAt: text('synced_at'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    modifiedAt: text('modified_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (table) => [
    index('idx_cal_events_calendar').on(table.calendarId),
    index('idx_cal_events_start').on(table.startAt),
    index('idx_cal_events_end').on(table.endAt),
    index('idx_cal_events_external').on(table.externalEventId),
    index('idx_cal_events_source').on(table.sourceType),
    index('idx_cal_events_recurring').on(table.recurringEventId)
  ]
)

export type CalendarEvent = typeof calendarEvents.$inferSelect
export type NewCalendarEvent = typeof calendarEvents.$inferInsert
```

- [ ] **Step 3: Export from schema index and data schema**

Add to `packages/db-schema/src/schema/index.ts`:
```typescript
export * from './calendars'
export * from './calendar-events'
```

Add to `packages/db-schema/src/data-schema.ts` (import + add to schema object):
```typescript
import { calendars } from './schema/calendars'
import { calendarEvents } from './schema/calendar-events'
// add to the schema object alongside existing tables
```

- [ ] **Step 4: Generate and apply migration**

Run:
```bash
pnpm db:generate
```

Expected: New migration SQL file created in `apps/desktop/src/main/database/drizzle-data/` with CREATE TABLE statements for `calendars` and `calendar_events`.

- [ ] **Step 5: Commit**

```bash
git add packages/db-schema/src/schema/calendars.ts packages/db-schema/src/schema/calendar-events.ts packages/db-schema/src/schema/index.ts packages/db-schema/src/data-schema.ts apps/desktop/src/main/database/drizzle-data/
git commit -m "feat(calendar): add calendars and calendar_events DB schema"
```

---

## Task 2: Contracts — Zod Schemas, IPC Channels, Sync Payloads

**Files:**
- Create: `packages/contracts/src/calendar-api.ts`
- Create: `packages/contracts/src/calendar-sync-payloads.ts`
- Modify: `packages/contracts/src/ipc-channels.ts`
- Modify: `packages/contracts/src/sync-api.ts`

- [ ] **Step 1: Create calendar API Zod schemas**

```typescript
// packages/contracts/src/calendar-api.ts
import { z } from 'zod'

export const CalendarCreateSchema = z.object({
  name: z.string().min(1).max(200),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#6366f1'),
  icon: z.string().max(10).nullish(),
  isDefault: z.boolean().default(false)
})

export const CalendarUpdateSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(200).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  icon: z.string().max(10).nullish(),
  position: z.number().int().min(0).optional(),
  isDefault: z.boolean().optional(),
  isVisible: z.boolean().optional()
})

export const CalendarEventCreateSchema = z.object({
  calendarId: z.string(),
  title: z.string().min(1).max(500),
  description: z.string().max(10000).nullish(),
  location: z.string().max(1000).nullish(),
  startAt: z.string(),
  endAt: z.string(),
  isAllDay: z.boolean().default(false),
  timezone: z.string().default('UTC'),
  status: z.enum(['confirmed', 'tentative', 'cancelled']).default('confirmed'),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullish(),
  reminders: z
    .array(z.object({ method: z.string(), minutes: z.number().int().min(0) }))
    .nullish(),
  attendees: z
    .array(
      z.object({
        email: z.string().email(),
        name: z.string().optional(),
        status: z.string().optional(),
        isOrganizer: z.boolean().optional()
      })
    )
    .nullish()
})

export const CalendarEventUpdateSchema = z.object({
  id: z.string(),
  calendarId: z.string().optional(),
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(10000).nullish(),
  location: z.string().max(1000).nullish(),
  startAt: z.string().optional(),
  endAt: z.string().optional(),
  isAllDay: z.boolean().optional(),
  timezone: z.string().optional(),
  status: z.enum(['confirmed', 'tentative', 'cancelled']).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullish(),
  reminders: z
    .array(z.object({ method: z.string(), minutes: z.number().int().min(0) }))
    .nullish(),
  attendees: z
    .array(
      z.object({
        email: z.string().email(),
        name: z.string().optional(),
        status: z.string().optional(),
        isOrganizer: z.boolean().optional()
      })
    )
    .nullish()
})

export const EventsForRangeSchema = z.object({
  startDate: z.string(),
  endDate: z.string(),
  calendarIds: z.array(z.string()).optional(),
  includeTasks: z.boolean().default(true)
})

export type CalendarCreateInput = z.infer<typeof CalendarCreateSchema>
export type CalendarUpdateInput = z.infer<typeof CalendarUpdateSchema>
export type CalendarEventCreateInput = z.infer<typeof CalendarEventCreateSchema>
export type CalendarEventUpdateInput = z.infer<typeof CalendarEventUpdateSchema>
export type EventsForRangeInput = z.infer<typeof EventsForRangeSchema>
```

- [ ] **Step 2: Create calendar sync payload schemas**

```typescript
// packages/contracts/src/calendar-sync-payloads.ts
import { z } from 'zod'
import { VectorClockSchema, FieldClocksSchema } from './sync-api'

export const CalendarSyncPayloadSchema = z.object({
  name: z.string().optional(),
  color: z.string().optional(),
  icon: z.string().nullable().optional(),
  position: z.number().optional(),
  isDefault: z.boolean().optional(),
  isVisible: z.boolean().optional(),
  clock: VectorClockSchema.optional(),
  fieldClocks: FieldClocksSchema.optional(),
  createdAt: z.string().optional(),
  modifiedAt: z.string().optional()
})

export const CalendarEventSyncPayloadSchema = z.object({
  calendarId: z.string().optional(),
  title: z.string().optional(),
  description: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  startAt: z.string().optional(),
  endAt: z.string().optional(),
  isAllDay: z.boolean().optional(),
  timezone: z.string().optional(),
  recurrenceRule: z.string().nullable().optional(),
  recurrenceExceptions: z.array(z.string()).nullable().optional(),
  recurringEventId: z.string().nullable().optional(),
  status: z.string().optional(),
  color: z.string().nullable().optional(),
  reminders: z
    .array(z.object({ method: z.string(), minutes: z.number() }))
    .nullable()
    .optional(),
  attendees: z
    .array(
      z.object({
        email: z.string(),
        name: z.string().optional(),
        status: z.string().optional(),
        isOrganizer: z.boolean().optional()
      })
    )
    .nullable()
    .optional(),
  clock: VectorClockSchema.optional(),
  fieldClocks: FieldClocksSchema.optional(),
  createdAt: z.string().optional(),
  modifiedAt: z.string().optional()
})

export type CalendarSyncPayload = z.infer<typeof CalendarSyncPayloadSchema>
export type CalendarEventSyncPayload = z.infer<typeof CalendarEventSyncPayloadSchema>
```

- [ ] **Step 3: Add CalendarChannels to IPC channels**

Add to `packages/contracts/src/ipc-channels.ts`:

```typescript
export const CalendarChannels = {
  invoke: {
    EVENT_CREATE: 'calendar:event:create',
    EVENT_GET: 'calendar:event:get',
    EVENT_UPDATE: 'calendar:event:update',
    EVENT_DELETE: 'calendar:event:delete',
    EVENT_LIST: 'calendar:event:list',
    CALENDAR_CREATE: 'calendar:create',
    CALENDAR_GET: 'calendar:get',
    CALENDAR_UPDATE: 'calendar:update',
    CALENDAR_DELETE: 'calendar:delete',
    CALENDAR_LIST: 'calendar:list',
    GET_EVENTS_FOR_RANGE: 'calendar:events-for-range',
    GET_DAY_EVENTS: 'calendar:day-events'
  },
  events: {
    EVENT_CREATED: 'calendar:event:created',
    EVENT_UPDATED: 'calendar:event:updated',
    EVENT_DELETED: 'calendar:event:deleted',
    CALENDAR_CREATED: 'calendar:created',
    CALENDAR_UPDATED: 'calendar:updated',
    CALENDAR_DELETED: 'calendar:deleted'
  }
} as const

export type CalendarInvokeChannel =
  (typeof CalendarChannels.invoke)[keyof typeof CalendarChannels.invoke]
export type CalendarEventChannel =
  (typeof CalendarChannels.events)[keyof typeof CalendarChannels.events]
```

- [ ] **Step 4: Add new sync item types**

In `packages/contracts/src/sync-api.ts`, add `'calendar'` and `'calendar_event'` to the `SYNC_ITEM_TYPES` array:

```typescript
export const SYNC_ITEM_TYPES = [
  'note',
  'task',
  'project',
  'settings',
  'attachment',
  'inbox',
  'filter',
  'journal',
  'tag_definition',
  'calendar',
  'calendar_event'
] as const
```

- [ ] **Step 5: Run typecheck to verify contracts compile**

Run: `pnpm typecheck`
Expected: No new errors from contract changes (pre-existing test file errors are OK).

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/calendar-api.ts packages/contracts/src/calendar-sync-payloads.ts packages/contracts/src/ipc-channels.ts packages/contracts/src/sync-api.ts
git commit -m "feat(calendar): add calendar contracts — Zod schemas, IPC channels, sync payloads"
```

---

## Task 3: Calendar Service (Main Process CRUD)

**Files:**
- Create: `apps/desktop/src/main/calendar/calendar-service.ts`
- Create: `apps/desktop/src/main/calendar/calendar-query.ts`

- [ ] **Step 1: Write test for calendar CRUD**

Create `apps/desktop/src/main/calendar/__tests__/calendar-service.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { CalendarService } from '../calendar-service'

// Use in-memory SQLite for tests
// Setup: create test DB with schema applied, pass to CalendarService

describe('CalendarService', () => {
  let service: CalendarService

  // beforeEach: create fresh in-memory DB + apply schema

  describe('calendars', () => {
    it('creates a calendar with defaults', () => {
      const cal = service.createCalendar({ name: 'Work', color: '#ef4444' })
      expect(cal.name).toBe('Work')
      expect(cal.color).toBe('#ef4444')
      expect(cal.isDefault).toBe(false)
      expect(cal.isVisible).toBe(true)
      expect(cal.id).toBeDefined()
    })

    it('lists calendars ordered by position', () => {
      service.createCalendar({ name: 'B', color: '#000000' })
      service.createCalendar({ name: 'A', color: '#ffffff' })
      const list = service.listCalendars()
      expect(list.length).toBe(2)
      expect(list[0].position).toBeLessThanOrEqual(list[1].position)
    })

    it('updates calendar fields', () => {
      const cal = service.createCalendar({ name: 'Old', color: '#000000' })
      const updated = service.updateCalendar({ id: cal.id, name: 'New', color: '#ff0000' })
      expect(updated.name).toBe('New')
      expect(updated.color).toBe('#ff0000')
    })

    it('deletes calendar and cascades events', () => {
      const cal = service.createCalendar({ name: 'Temp', color: '#000000' })
      service.createEvent({
        calendarId: cal.id,
        title: 'Meeting',
        startAt: '2026-04-10T10:00:00Z',
        endAt: '2026-04-10T11:00:00Z'
      })
      service.deleteCalendar(cal.id)
      expect(service.getCalendar(cal.id)).toBeUndefined()
      expect(service.listEvents(cal.id)).toEqual([])
    })
  })

  describe('events', () => {
    it('creates an event', () => {
      const cal = service.createCalendar({ name: 'Work', color: '#6366f1' })
      const event = service.createEvent({
        calendarId: cal.id,
        title: 'Standup',
        startAt: '2026-04-10T09:00:00Z',
        endAt: '2026-04-10T09:30:00Z'
      })
      expect(event.title).toBe('Standup')
      expect(event.sourceType).toBe('local')
      expect(event.status).toBe('confirmed')
    })

    it('queries events for a date range', () => {
      const cal = service.createCalendar({ name: 'Work', color: '#6366f1' })
      service.createEvent({
        calendarId: cal.id,
        title: 'In range',
        startAt: '2026-04-10T09:00:00Z',
        endAt: '2026-04-10T10:00:00Z'
      })
      service.createEvent({
        calendarId: cal.id,
        title: 'Out of range',
        startAt: '2026-05-10T09:00:00Z',
        endAt: '2026-05-10T10:00:00Z'
      })
      const results = service.getEventsForRange('2026-04-01', '2026-04-30')
      expect(results.length).toBe(1)
      expect(results[0].title).toBe('In range')
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- apps/desktop/src/main/calendar/__tests__/calendar-service.test.ts`
Expected: FAIL — CalendarService does not exist yet.

- [ ] **Step 3: Implement CalendarService**

```typescript
// apps/desktop/src/main/calendar/calendar-service.ts
import { eq, and, gte, lte, asc, or } from 'drizzle-orm'
import { v4 as uuid } from 'uuid'
import { calendars, calendarEvents } from '@memry/db-schema'
import type { CalendarCreateInput, CalendarUpdateInput, CalendarEventCreateInput, CalendarEventUpdateInput } from '@memry/contracts/calendar-api'
import type { DrizzleDb } from '../sync/item-handlers/types'
import { createLogger } from '../logger'

const log = createLogger('CalendarService')

export class CalendarService {
  constructor(private db: DrizzleDb) {}

  createCalendar(input: CalendarCreateInput) {
    const id = uuid()
    const now = new Date().toISOString()
    const maxPos = this.db
      .select({ pos: calendars.position })
      .from(calendars)
      .orderBy(asc(calendars.position))
      .all()
    const position = maxPos.length > 0 ? maxPos[maxPos.length - 1].pos + 1 : 0

    this.db
      .insert(calendars)
      .values({
        id,
        name: input.name,
        color: input.color ?? '#6366f1',
        icon: input.icon ?? null,
        isDefault: input.isDefault ?? false,
        isVisible: true,
        syncEnabled: false,
        position,
        createdAt: now,
        modifiedAt: now
      })
      .run()

    return this.db.select().from(calendars).where(eq(calendars.id, id)).get()!
  }

  getCalendar(id: string) {
    return this.db.select().from(calendars).where(eq(calendars.id, id)).get()
  }

  listCalendars() {
    return this.db.select().from(calendars).orderBy(asc(calendars.position)).all()
  }

  updateCalendar(input: CalendarUpdateInput) {
    const now = new Date().toISOString()
    const updates: Record<string, unknown> = { modifiedAt: now }
    if (input.name !== undefined) updates.name = input.name
    if (input.color !== undefined) updates.color = input.color
    if (input.icon !== undefined) updates.icon = input.icon
    if (input.position !== undefined) updates.position = input.position
    if (input.isDefault !== undefined) updates.isDefault = input.isDefault
    if (input.isVisible !== undefined) updates.isVisible = input.isVisible

    this.db.update(calendars).set(updates).where(eq(calendars.id, input.id)).run()
    return this.db.select().from(calendars).where(eq(calendars.id, input.id)).get()!
  }

  deleteCalendar(id: string) {
    this.db.delete(calendars).where(eq(calendars.id, id)).run()
  }

  createEvent(input: CalendarEventCreateInput) {
    const id = uuid()
    const now = new Date().toISOString()

    this.db
      .insert(calendarEvents)
      .values({
        id,
        calendarId: input.calendarId,
        title: input.title,
        description: input.description ?? null,
        location: input.location ?? null,
        startAt: input.startAt,
        endAt: input.endAt,
        isAllDay: input.isAllDay ?? false,
        timezone: input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
        status: input.status ?? 'confirmed',
        color: input.color ?? null,
        reminders: input.reminders ?? null,
        attendees: input.attendees ?? null,
        sourceType: 'local',
        createdAt: now,
        modifiedAt: now
      })
      .run()

    return this.db.select().from(calendarEvents).where(eq(calendarEvents.id, id)).get()!
  }

  getEvent(id: string) {
    return this.db.select().from(calendarEvents).where(eq(calendarEvents.id, id)).get()
  }

  listEvents(calendarId: string) {
    return this.db
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.calendarId, calendarId))
      .orderBy(asc(calendarEvents.startAt))
      .all()
  }

  updateEvent(input: CalendarEventUpdateInput) {
    const now = new Date().toISOString()
    const updates: Record<string, unknown> = { modifiedAt: now }
    if (input.calendarId !== undefined) updates.calendarId = input.calendarId
    if (input.title !== undefined) updates.title = input.title
    if (input.description !== undefined) updates.description = input.description
    if (input.location !== undefined) updates.location = input.location
    if (input.startAt !== undefined) updates.startAt = input.startAt
    if (input.endAt !== undefined) updates.endAt = input.endAt
    if (input.isAllDay !== undefined) updates.isAllDay = input.isAllDay
    if (input.timezone !== undefined) updates.timezone = input.timezone
    if (input.status !== undefined) updates.status = input.status
    if (input.color !== undefined) updates.color = input.color
    if (input.reminders !== undefined) updates.reminders = input.reminders
    if (input.attendees !== undefined) updates.attendees = input.attendees

    this.db.update(calendarEvents).set(updates).where(eq(calendarEvents.id, input.id)).run()
    return this.db.select().from(calendarEvents).where(eq(calendarEvents.id, input.id)).get()!
  }

  deleteEvent(id: string) {
    this.db.delete(calendarEvents).where(eq(calendarEvents.id, id)).run()
  }

  getEventsForRange(startDate: string, endDate: string, calendarIds?: string[]) {
    const startISO = `${startDate}T00:00:00Z`
    const endISO = `${endDate}T23:59:59Z`

    let query = this.db
      .select()
      .from(calendarEvents)
      .where(
        and(
          lte(calendarEvents.startAt, endISO),
          gte(calendarEvents.endAt, startISO)
        )
      )
      .orderBy(asc(calendarEvents.startAt))

    const results = query.all()

    if (calendarIds && calendarIds.length > 0) {
      return results.filter((e) => calendarIds.includes(e.calendarId))
    }

    return results
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- apps/desktop/src/main/calendar/__tests__/calendar-service.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/calendar/
git commit -m "feat(calendar): add CalendarService with CRUD and range queries"
```

---

## Task 4: IPC Handlers

**Files:**
- Create: `apps/desktop/src/main/ipc/calendar-handlers.ts`
- Modify: `apps/desktop/src/main/ipc/index.ts`

- [ ] **Step 1: Implement calendar IPC handlers**

```typescript
// apps/desktop/src/main/ipc/calendar-handlers.ts
import { ipcMain, BrowserWindow } from 'electron'
import { CalendarChannels } from '@memry/contracts/ipc-channels'
import {
  CalendarCreateSchema,
  CalendarUpdateSchema,
  CalendarEventCreateSchema,
  CalendarEventUpdateSchema,
  EventsForRangeSchema
} from '@memry/contracts/calendar-api'
import { createValidatedHandler } from './validate'
import { getDatabase } from '../database'
import { CalendarService } from '../calendar/calendar-service'
import { createLogger } from '../logger'

const log = createLogger('IPC:Calendar')

function requireDatabase() {
  try {
    return getDatabase()
  } catch {
    throw new Error('No vault is open. Please open a vault first.')
  }
}

function getService() {
  return new CalendarService(requireDatabase())
}

function emit(channel: string, data: unknown) {
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send(channel, data)
  })
}

export function registerCalendarHandlers() {
  ipcMain.handle(
    CalendarChannels.invoke.CALENDAR_CREATE,
    createValidatedHandler(CalendarCreateSchema, async (data) => {
      const svc = getService()
      const cal = svc.createCalendar(data)
      emit(CalendarChannels.events.CALENDAR_CREATED, cal)
      return cal
    })
  )

  ipcMain.handle(
    CalendarChannels.invoke.CALENDAR_GET,
    async (_event, id: string) => {
      return getService().getCalendar(id)
    }
  )

  ipcMain.handle(
    CalendarChannels.invoke.CALENDAR_LIST,
    async () => {
      return getService().listCalendars()
    }
  )

  ipcMain.handle(
    CalendarChannels.invoke.CALENDAR_UPDATE,
    createValidatedHandler(CalendarUpdateSchema, async (data) => {
      const svc = getService()
      const cal = svc.updateCalendar(data)
      emit(CalendarChannels.events.CALENDAR_UPDATED, cal)
      return cal
    })
  )

  ipcMain.handle(
    CalendarChannels.invoke.CALENDAR_DELETE,
    async (_event, id: string) => {
      const svc = getService()
      svc.deleteCalendar(id)
      emit(CalendarChannels.events.CALENDAR_DELETED, { id })
      return { success: true }
    }
  )

  ipcMain.handle(
    CalendarChannels.invoke.EVENT_CREATE,
    createValidatedHandler(CalendarEventCreateSchema, async (data) => {
      const svc = getService()
      const event = svc.createEvent(data)
      emit(CalendarChannels.events.EVENT_CREATED, event)
      return event
    })
  )

  ipcMain.handle(
    CalendarChannels.invoke.EVENT_GET,
    async (_event, id: string) => {
      return getService().getEvent(id)
    }
  )

  ipcMain.handle(
    CalendarChannels.invoke.EVENT_LIST,
    async (_event, calendarId: string) => {
      return getService().listEvents(calendarId)
    }
  )

  ipcMain.handle(
    CalendarChannels.invoke.EVENT_UPDATE,
    createValidatedHandler(CalendarEventUpdateSchema, async (data) => {
      const svc = getService()
      const event = svc.updateEvent(data)
      emit(CalendarChannels.events.EVENT_UPDATED, event)
      return event
    })
  )

  ipcMain.handle(
    CalendarChannels.invoke.EVENT_DELETE,
    async (_event, id: string) => {
      const svc = getService()
      svc.deleteEvent(id)
      emit(CalendarChannels.events.EVENT_DELETED, { id })
      return { success: true }
    }
  )

  ipcMain.handle(
    CalendarChannels.invoke.GET_EVENTS_FOR_RANGE,
    createValidatedHandler(EventsForRangeSchema, async (data) => {
      const svc = getService()
      return svc.getEventsForRange(data.startDate, data.endDate, data.calendarIds)
    })
  )

  ipcMain.handle(
    CalendarChannels.invoke.GET_DAY_EVENTS,
    async (_event, date: string) => {
      const svc = getService()
      return svc.getEventsForRange(date, date)
    }
  )

  log.info('Calendar IPC handlers registered')
}
```

- [ ] **Step 2: Register in IPC index**

Add to `apps/desktop/src/main/ipc/index.ts`:
```typescript
import { registerCalendarHandlers } from './calendar-handlers'
// In the registerAllHandlers function:
registerCalendarHandlers()
```

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: No new errors from handler code.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/main/ipc/calendar-handlers.ts apps/desktop/src/main/ipc/index.ts
git commit -m "feat(calendar): add IPC handlers for calendar CRUD"
```

---

## Task 5: Sync Handlers

**Files:**
- Create: `apps/desktop/src/main/sync/item-handlers/calendar-handler.ts`
- Create: `apps/desktop/src/main/sync/item-handlers/calendar-event-handler.ts`
- Modify: `apps/desktop/src/main/sync/item-handlers/index.ts`
- Modify: `apps/desktop/src/main/sync/field-merge.ts`

- [ ] **Step 1: Add syncable field constants**

Add to `apps/desktop/src/main/sync/field-merge.ts`:

```typescript
export const CALENDAR_SYNCABLE_FIELDS = [
  'name',
  'color',
  'icon',
  'position',
  'isDefault',
  'isVisible'
] as const

export const CALENDAR_EVENT_SYNCABLE_FIELDS = [
  'calendarId',
  'title',
  'description',
  'location',
  'startAt',
  'endAt',
  'isAllDay',
  'timezone',
  'recurrenceRule',
  'recurrenceExceptions',
  'recurringEventId',
  'status',
  'color',
  'reminders',
  'attendees'
] as const
```

Also add merge helper functions following the existing `mergeTaskFields` pattern:

```typescript
export function mergeCalendarFields(
  local: Record<string, unknown>,
  remote: Record<string, unknown>,
  localFC: FieldClocks,
  remoteFC: FieldClocks
) {
  return mergeFields(local, remote, localFC, remoteFC, CALENDAR_SYNCABLE_FIELDS)
}

export function mergeCalendarEventFields(
  local: Record<string, unknown>,
  remote: Record<string, unknown>,
  localFC: FieldClocks,
  remoteFC: FieldClocks
) {
  return mergeFields(local, remote, localFC, remoteFC, CALENDAR_EVENT_SYNCABLE_FIELDS)
}
```

- [ ] **Step 2: Implement calendar sync handler**

```typescript
// apps/desktop/src/main/sync/item-handlers/calendar-handler.ts
import { eq, isNull } from 'drizzle-orm'
import { calendars } from '@memry/db-schema'
import { CalendarSyncPayloadSchema, type CalendarSyncPayload } from '@memry/contracts/calendar-sync-payloads'
import { CalendarChannels } from '@memry/contracts/ipc-channels'
import type { VectorClock } from '@memry/contracts/sync-api'
import type { SyncItemHandler, ApplyContext, ApplyResult, DrizzleDb } from './types'
import type { SyncQueueManager } from '../sync-queue-manager'
import { resolveClockConflict } from '../vector-clock'
import {
  initAllFieldClocks,
  mergeCalendarFields,
  CALENDAR_SYNCABLE_FIELDS
} from '../field-merge'
import { createLogger } from '../../logger'

const log = createLogger('Sync:Calendar')

export const calendarHandler: SyncItemHandler<CalendarSyncPayload> = {
  type: 'calendar',
  schema: CalendarSyncPayloadSchema,

  applyUpsert(ctx: ApplyContext, itemId: string, data: CalendarSyncPayload, clock: VectorClock): ApplyResult {
    return ctx.db.transaction(() => {
      const existing = ctx.db.select().from(calendars).where(eq(calendars.id, itemId)).get()
      const now = new Date().toISOString()

      if (!existing) {
        ctx.db.insert(calendars).values({
          id: itemId,
          name: data.name ?? 'Untitled',
          color: data.color ?? '#6366f1',
          icon: data.icon ?? null,
          position: data.position ?? 0,
          isDefault: data.isDefault ?? false,
          isVisible: data.isVisible ?? true,
          syncEnabled: false,
          clock,
          fieldClocks: data.fieldClocks ?? initAllFieldClocks(clock, [...CALENDAR_SYNCABLE_FIELDS]),
          syncedAt: now,
          createdAt: data.createdAt ?? now,
          modifiedAt: data.modifiedAt ?? now
        }).run()
        ctx.emit(CalendarChannels.events.CALENDAR_CREATED, { id: itemId })
        return 'applied'
      }

      const resolution = resolveClockConflict(existing.clock, clock)
      if (resolution.action === 'skip') return 'skipped'

      if (resolution.action === 'apply') {
        ctx.db.update(calendars).set({
          name: data.name ?? existing.name,
          color: data.color ?? existing.color,
          icon: data.icon !== undefined ? data.icon : existing.icon,
          position: data.position ?? existing.position,
          isDefault: data.isDefault ?? existing.isDefault,
          isVisible: data.isVisible ?? existing.isVisible,
          clock: resolution.mergedClock,
          fieldClocks: data.fieldClocks ?? existing.fieldClocks,
          syncedAt: now,
          modifiedAt: data.modifiedAt ?? now
        }).where(eq(calendars.id, itemId)).run()
      } else {
        const localFC = existing.fieldClocks ?? initAllFieldClocks(existing.clock ?? {}, [...CALENDAR_SYNCABLE_FIELDS])
        const remoteFC = data.fieldClocks ?? initAllFieldClocks(clock, [...CALENDAR_SYNCABLE_FIELDS])
        const result = mergeCalendarFields(existing as Record<string, unknown>, data as Record<string, unknown>, localFC, remoteFC)

        ctx.db.update(calendars).set({
          ...result.merged,
          clock: resolution.mergedClock,
          fieldClocks: result.mergedFieldClocks,
          syncedAt: now,
          modifiedAt: data.modifiedAt ?? now
        }).where(eq(calendars.id, itemId)).run()
      }

      ctx.emit(CalendarChannels.events.CALENDAR_UPDATED, { id: itemId })
      return 'applied'
    })
  },

  applyDelete(ctx: ApplyContext, itemId: string, clock?: VectorClock) {
    const existing = ctx.db.select().from(calendars).where(eq(calendars.id, itemId)).get()
    if (!existing) return 'skipped'

    if (clock && existing.clock) {
      const resolution = resolveClockConflict(existing.clock, clock)
      if (resolution.action === 'skip') return 'skipped'
    }

    ctx.db.delete(calendars).where(eq(calendars.id, itemId)).run()
    ctx.emit(CalendarChannels.events.CALENDAR_DELETED, { id: itemId })
    return 'applied'
  },

  fetchLocal(db: DrizzleDb, itemId: string) {
    return db.select().from(calendars).where(eq(calendars.id, itemId)).get() as Record<string, unknown> | undefined
  },

  seedUnclocked(db: DrizzleDb, deviceId: string, queue: SyncQueueManager) {
    const unclocked = db.select().from(calendars).where(isNull(calendars.clock)).all()
    let count = 0
    for (const row of unclocked) {
      const clock: VectorClock = { [deviceId]: 1 }
      const fieldClocks = initAllFieldClocks(clock, [...CALENDAR_SYNCABLE_FIELDS])
      db.update(calendars).set({ clock, fieldClocks }).where(eq(calendars.id, row.id)).run()
      queue.enqueue({ itemId: row.id, itemType: 'calendar', operation: 'upsert' })
      count++
    }
    return count
  },

  buildPushPayload(db: DrizzleDb, itemId: string) {
    const row = db.select().from(calendars).where(eq(calendars.id, itemId)).get()
    if (!row) return null
    return JSON.stringify({
      name: row.name,
      color: row.color,
      icon: row.icon,
      position: row.position,
      isDefault: row.isDefault,
      isVisible: row.isVisible,
      clock: row.clock,
      fieldClocks: row.fieldClocks,
      createdAt: row.createdAt,
      modifiedAt: row.modifiedAt
    })
  },

  markPushSynced(db: DrizzleDb, itemId: string) {
    db.update(calendars).set({ syncedAt: new Date().toISOString() }).where(eq(calendars.id, itemId)).run()
  }
}
```

- [ ] **Step 3: Implement calendar event sync handler**

```typescript
// apps/desktop/src/main/sync/item-handlers/calendar-event-handler.ts
import { eq, isNull, and } from 'drizzle-orm'
import { calendarEvents } from '@memry/db-schema'
import { CalendarEventSyncPayloadSchema, type CalendarEventSyncPayload } from '@memry/contracts/calendar-sync-payloads'
import { CalendarChannels } from '@memry/contracts/ipc-channels'
import type { VectorClock } from '@memry/contracts/sync-api'
import type { SyncItemHandler, ApplyContext, ApplyResult, DrizzleDb } from './types'
import type { SyncQueueManager } from '../sync-queue-manager'
import { resolveClockConflict } from '../vector-clock'
import {
  initAllFieldClocks,
  mergeCalendarEventFields,
  CALENDAR_EVENT_SYNCABLE_FIELDS
} from '../field-merge'

export const calendarEventHandler: SyncItemHandler<CalendarEventSyncPayload> = {
  type: 'calendar_event',
  schema: CalendarEventSyncPayloadSchema,

  applyUpsert(ctx: ApplyContext, itemId: string, data: CalendarEventSyncPayload, clock: VectorClock): ApplyResult {
    return ctx.db.transaction(() => {
      const existing = ctx.db.select().from(calendarEvents).where(eq(calendarEvents.id, itemId)).get()
      const now = new Date().toISOString()

      if (!existing) {
        ctx.db.insert(calendarEvents).values({
          id: itemId,
          calendarId: data.calendarId ?? '',
          title: data.title ?? 'Untitled',
          description: data.description ?? null,
          location: data.location ?? null,
          startAt: data.startAt ?? now,
          endAt: data.endAt ?? now,
          isAllDay: data.isAllDay ?? false,
          timezone: data.timezone ?? 'UTC',
          recurrenceRule: data.recurrenceRule ?? null,
          recurrenceExceptions: data.recurrenceExceptions ?? null,
          recurringEventId: data.recurringEventId ?? null,
          status: data.status ?? 'confirmed',
          color: data.color ?? null,
          reminders: data.reminders ?? null,
          attendees: data.attendees ?? null,
          sourceType: 'local',
          clock,
          fieldClocks: data.fieldClocks ?? initAllFieldClocks(clock, [...CALENDAR_EVENT_SYNCABLE_FIELDS]),
          syncedAt: now,
          createdAt: data.createdAt ?? now,
          modifiedAt: data.modifiedAt ?? now
        }).run()
        ctx.emit(CalendarChannels.events.EVENT_CREATED, { id: itemId })
        return 'applied'
      }

      const resolution = resolveClockConflict(existing.clock, clock)
      if (resolution.action === 'skip') return 'skipped'

      if (resolution.action === 'apply') {
        ctx.db.update(calendarEvents).set({
          calendarId: data.calendarId ?? existing.calendarId,
          title: data.title ?? existing.title,
          description: data.description !== undefined ? data.description : existing.description,
          location: data.location !== undefined ? data.location : existing.location,
          startAt: data.startAt ?? existing.startAt,
          endAt: data.endAt ?? existing.endAt,
          isAllDay: data.isAllDay ?? existing.isAllDay,
          timezone: data.timezone ?? existing.timezone,
          recurrenceRule: data.recurrenceRule !== undefined ? data.recurrenceRule : existing.recurrenceRule,
          recurrenceExceptions: data.recurrenceExceptions !== undefined ? data.recurrenceExceptions : existing.recurrenceExceptions,
          recurringEventId: data.recurringEventId !== undefined ? data.recurringEventId : existing.recurringEventId,
          status: data.status ?? existing.status,
          color: data.color !== undefined ? data.color : existing.color,
          reminders: data.reminders !== undefined ? data.reminders : existing.reminders,
          attendees: data.attendees !== undefined ? data.attendees : existing.attendees,
          clock: resolution.mergedClock,
          fieldClocks: data.fieldClocks ?? existing.fieldClocks,
          syncedAt: now,
          modifiedAt: data.modifiedAt ?? now
        }).where(eq(calendarEvents.id, itemId)).run()
      } else {
        const localFC = existing.fieldClocks ?? initAllFieldClocks(existing.clock ?? {}, [...CALENDAR_EVENT_SYNCABLE_FIELDS])
        const remoteFC = data.fieldClocks ?? initAllFieldClocks(clock, [...CALENDAR_EVENT_SYNCABLE_FIELDS])
        const result = mergeCalendarEventFields(
          existing as Record<string, unknown>,
          data as Record<string, unknown>,
          localFC,
          remoteFC
        )

        ctx.db.update(calendarEvents).set({
          ...result.merged,
          clock: resolution.mergedClock,
          fieldClocks: result.mergedFieldClocks,
          syncedAt: now,
          modifiedAt: data.modifiedAt ?? now
        }).where(eq(calendarEvents.id, itemId)).run()
      }

      ctx.emit(CalendarChannels.events.EVENT_UPDATED, { id: itemId })
      return 'applied'
    })
  },

  applyDelete(ctx: ApplyContext, itemId: string, clock?: VectorClock) {
    const existing = ctx.db.select().from(calendarEvents).where(eq(calendarEvents.id, itemId)).get()
    if (!existing) return 'skipped'

    if (clock && existing.clock) {
      const resolution = resolveClockConflict(existing.clock, clock)
      if (resolution.action === 'skip') return 'skipped'
    }

    ctx.db.delete(calendarEvents).where(eq(calendarEvents.id, itemId)).run()
    ctx.emit(CalendarChannels.events.EVENT_DELETED, { id: itemId })
    return 'applied'
  },

  fetchLocal(db: DrizzleDb, itemId: string) {
    return db.select().from(calendarEvents).where(eq(calendarEvents.id, itemId)).get() as Record<string, unknown> | undefined
  },

  seedUnclocked(db: DrizzleDb, deviceId: string, queue: SyncQueueManager) {
    const unclocked = db
      .select()
      .from(calendarEvents)
      .where(and(isNull(calendarEvents.clock), eq(calendarEvents.sourceType, 'local')))
      .all()
    let count = 0
    for (const row of unclocked) {
      const clock: VectorClock = { [deviceId]: 1 }
      const fieldClocks = initAllFieldClocks(clock, [...CALENDAR_EVENT_SYNCABLE_FIELDS])
      db.update(calendarEvents).set({ clock, fieldClocks }).where(eq(calendarEvents.id, row.id)).run()
      queue.enqueue({ itemId: row.id, itemType: 'calendar_event', operation: 'upsert' })
      count++
    }
    return count
  },

  buildPushPayload(db: DrizzleDb, itemId: string) {
    const row = db.select().from(calendarEvents).where(eq(calendarEvents.id, itemId)).get()
    if (!row || row.sourceType !== 'local') return null
    return JSON.stringify({
      calendarId: row.calendarId,
      title: row.title,
      description: row.description,
      location: row.location,
      startAt: row.startAt,
      endAt: row.endAt,
      isAllDay: row.isAllDay,
      timezone: row.timezone,
      recurrenceRule: row.recurrenceRule,
      recurrenceExceptions: row.recurrenceExceptions,
      recurringEventId: row.recurringEventId,
      status: row.status,
      color: row.color,
      reminders: row.reminders,
      attendees: row.attendees,
      clock: row.clock,
      fieldClocks: row.fieldClocks,
      createdAt: row.createdAt,
      modifiedAt: row.modifiedAt
    })
  },

  markPushSynced(db: DrizzleDb, itemId: string) {
    db.update(calendarEvents).set({ syncedAt: new Date().toISOString() }).where(eq(calendarEvents.id, itemId)).run()
  }
}
```

- [ ] **Step 4: Register handlers in index**

Add to `apps/desktop/src/main/sync/item-handlers/index.ts`:

```typescript
import { calendarHandler } from './calendar-handler'
import { calendarEventHandler } from './calendar-event-handler'

// Add to handlers Map:
['calendar', calendarHandler],
['calendar_event', calendarEventHandler],
```

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: No new errors.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/sync/item-handlers/calendar-handler.ts apps/desktop/src/main/sync/item-handlers/calendar-event-handler.ts apps/desktop/src/main/sync/item-handlers/index.ts apps/desktop/src/main/sync/field-merge.ts
git commit -m "feat(calendar): add sync handlers for calendar and calendar_event"
```

---

## Task 6: Preload API + IPC Map

**Files:**
- Modify: `apps/desktop/src/preload/index.ts`

- [ ] **Step 1: Add calendar API to preload**

Add to the `api` object in `apps/desktop/src/preload/index.ts`:

```typescript
calendar: {
  createCalendar: (data: any) => invoke(CalendarChannels.invoke.CALENDAR_CREATE, data),
  getCalendar: (id: string) => invoke(CalendarChannels.invoke.CALENDAR_GET, id),
  listCalendars: () => invoke(CalendarChannels.invoke.CALENDAR_LIST),
  updateCalendar: (data: any) => invoke(CalendarChannels.invoke.CALENDAR_UPDATE, data),
  deleteCalendar: (id: string) => invoke(CalendarChannels.invoke.CALENDAR_DELETE, id),
  createEvent: (data: any) => invoke(CalendarChannels.invoke.EVENT_CREATE, data),
  getEvent: (id: string) => invoke(CalendarChannels.invoke.EVENT_GET, id),
  listEvents: (calendarId: string) => invoke(CalendarChannels.invoke.EVENT_LIST, calendarId),
  updateEvent: (data: any) => invoke(CalendarChannels.invoke.EVENT_UPDATE, data),
  deleteEvent: (id: string) => invoke(CalendarChannels.invoke.EVENT_DELETE, id),
  getEventsForRange: (data: any) => invoke(CalendarChannels.invoke.GET_EVENTS_FOR_RANGE, data),
  getDayEvents: (date: string) => invoke(CalendarChannels.invoke.GET_DAY_EVENTS, date),

  onEventCreated: (cb: (data: any) => void) => ipcRenderer.on(CalendarChannels.events.EVENT_CREATED, (_e, d) => cb(d)),
  onEventUpdated: (cb: (data: any) => void) => ipcRenderer.on(CalendarChannels.events.EVENT_UPDATED, (_e, d) => cb(d)),
  onEventDeleted: (cb: (data: any) => void) => ipcRenderer.on(CalendarChannels.events.EVENT_DELETED, (_e, d) => cb(d)),
  onCalendarCreated: (cb: (data: any) => void) => ipcRenderer.on(CalendarChannels.events.CALENDAR_CREATED, (_e, d) => cb(d)),
  onCalendarUpdated: (cb: (data: any) => void) => ipcRenderer.on(CalendarChannels.events.CALENDAR_UPDATED, (_e, d) => cb(d)),
  onCalendarDeleted: (cb: (data: any) => void) => ipcRenderer.on(CalendarChannels.events.CALENDAR_DELETED, (_e, d) => cb(d)),
},
```

Add the import at top:
```typescript
import { CalendarChannels } from '@memry/contracts/ipc-channels'
```

- [ ] **Step 2: Regenerate IPC invoke map**

Run: `pnpm ipc:generate`
Expected: `generated-ipc-invoke-map.ts` updated with calendar channels.

- [ ] **Step 3: Run IPC contract check**

Run: `pnpm ipc:check`
Expected: PASS — all channels matched.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/preload/index.ts apps/desktop/src/main/ipc/generated-ipc-invoke-map.ts
git commit -m "feat(calendar): expose calendar API in preload + regenerate IPC map"
```

---

## Task 7: Frontend Service + Types

**Files:**
- Create: `apps/desktop/src/renderer/src/services/calendar-service.ts`

- [ ] **Step 1: Create calendar service for renderer**

```typescript
// apps/desktop/src/renderer/src/services/calendar-service.ts
export interface CalendarItem {
  id: string
  name: string
  color: string
  icon: string | null
  position: number
  isDefault: boolean
  isVisible: boolean
  providerId: string | null
  externalCalendarId: string | null
  syncEnabled: boolean
  createdAt: string
  modifiedAt: string
}

export interface CalendarEvent {
  id: string
  calendarId: string
  title: string
  description: string | null
  location: string | null
  startAt: string
  endAt: string
  isAllDay: boolean
  timezone: string
  recurrenceRule: string | null
  recurrenceExceptions: string[] | null
  recurringEventId: string | null
  status: 'confirmed' | 'tentative' | 'cancelled'
  color: string | null
  reminders: { method: string; minutes: number }[] | null
  attendees: { email: string; name?: string; status?: string; isOrganizer?: boolean }[] | null
  externalEventId: string | null
  sourceType: 'local' | 'external'
  createdAt: string
  modifiedAt: string
}

export interface CalendarEventCreateInput {
  calendarId: string
  title: string
  description?: string | null
  location?: string | null
  startAt: string
  endAt: string
  isAllDay?: boolean
  timezone?: string
  status?: 'confirmed' | 'tentative' | 'cancelled'
  color?: string | null
  reminders?: { method: string; minutes: number }[] | null
  attendees?: { email: string; name?: string; status?: string; isOrganizer?: boolean }[] | null
}

export interface CalendarEventUpdateInput {
  id: string
  calendarId?: string
  title?: string
  description?: string | null
  location?: string | null
  startAt?: string
  endAt?: string
  isAllDay?: boolean
  timezone?: string
  status?: 'confirmed' | 'tentative' | 'cancelled'
  color?: string | null
  reminders?: { method: string; minutes: number }[] | null
  attendees?: { email: string; name?: string; status?: string; isOrganizer?: boolean }[] | null
}

export type TimelineItem =
  | { type: 'event'; data: CalendarEvent }
  | { type: 'task'; data: { id: string; title: string; dueDate: string; dueTime: string | null; projectId: string; completedAt: string | null } }

export const calendarService = {
  createCalendar: (data: { name: string; color?: string; icon?: string | null; isDefault?: boolean }) =>
    window.api.calendar.createCalendar(data) as Promise<CalendarItem>,

  getCalendar: (id: string) =>
    window.api.calendar.getCalendar(id) as Promise<CalendarItem | undefined>,

  listCalendars: () =>
    window.api.calendar.listCalendars() as Promise<CalendarItem[]>,

  updateCalendar: (data: { id: string; name?: string; color?: string; icon?: string | null; position?: number; isDefault?: boolean; isVisible?: boolean }) =>
    window.api.calendar.updateCalendar(data) as Promise<CalendarItem>,

  deleteCalendar: (id: string) =>
    window.api.calendar.deleteCalendar(id) as Promise<{ success: boolean }>,

  createEvent: (data: CalendarEventCreateInput) =>
    window.api.calendar.createEvent(data) as Promise<CalendarEvent>,

  getEvent: (id: string) =>
    window.api.calendar.getEvent(id) as Promise<CalendarEvent | undefined>,

  listEvents: (calendarId: string) =>
    window.api.calendar.listEvents(calendarId) as Promise<CalendarEvent[]>,

  updateEvent: (data: CalendarEventUpdateInput) =>
    window.api.calendar.updateEvent(data) as Promise<CalendarEvent>,

  deleteEvent: (id: string) =>
    window.api.calendar.deleteEvent(id) as Promise<{ success: boolean }>,

  getEventsForRange: (startDate: string, endDate: string, calendarIds?: string[], includeTasks?: boolean) =>
    window.api.calendar.getEventsForRange({ startDate, endDate, calendarIds, includeTasks: includeTasks ?? true }) as Promise<CalendarEvent[]>,

  getDayEvents: (date: string) =>
    window.api.calendar.getDayEvents(date) as Promise<CalendarEvent[]>,

  onEventCreated: (cb: (data: CalendarEvent) => void) => window.api.calendar.onEventCreated(cb),
  onEventUpdated: (cb: (data: CalendarEvent) => void) => window.api.calendar.onEventUpdated(cb),
  onEventDeleted: (cb: (data: { id: string }) => void) => window.api.calendar.onEventDeleted(cb),
  onCalendarCreated: (cb: (data: CalendarItem) => void) => window.api.calendar.onCalendarCreated(cb),
  onCalendarUpdated: (cb: (data: CalendarItem) => void) => window.api.calendar.onCalendarUpdated(cb),
  onCalendarDeleted: (cb: (data: { id: string }) => void) => window.api.calendar.onCalendarDeleted(cb)
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/src/renderer/src/services/calendar-service.ts
git commit -m "feat(calendar): add frontend calendar service with types"
```

---

## Task 8: Sidebar Navigation + Routing

**Files:**
- Modify: `apps/desktop/src/renderer/src/App.tsx`
- Modify: `apps/desktop/src/renderer/src/components/app-sidebar.tsx`

- [ ] **Step 1: Add 'calendar' to AppPage type**

In `apps/desktop/src/renderer/src/App.tsx`, update the type:

```typescript
export type BasePage = 'inbox' | 'home' | 'journal' | 'graph' | 'calendar'
```

Add the Calendar page import and rendering in the page switch/render logic (where other pages like `tasks.tsx`, `journal.tsx` are rendered). Add:

```typescript
import { CalendarPage } from './pages/calendar'
// In the page rendering switch:
case 'calendar':
  return <CalendarPage />
```

- [ ] **Step 2: Add Calendar to sidebar nav**

In `apps/desktop/src/renderer/src/components/app-sidebar.tsx`, add to the `mainNav` array:

```typescript
{ title: 'Calendar', page: 'calendar', icon: Calendar01Icon, shortcut: '⌘⌥5' }
```

Import the icon:
```typescript
import { Calendar01Icon } from '@hugeicons/react'
```

Place it after Tasks in the nav order (Inbox, Home, Journal, Tasks, Calendar).

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/App.tsx apps/desktop/src/renderer/src/components/app-sidebar.tsx
git commit -m "feat(calendar): add Calendar to sidebar navigation and routing"
```

---

## Task 9: Calendar Page Shell + Header

**Files:**
- Create: `apps/desktop/src/renderer/src/pages/calendar.tsx`
- Create: `apps/desktop/src/renderer/src/components/calendar/calendar-header.tsx`
- Create: `apps/desktop/src/renderer/src/components/calendar/calendar-utils.ts`
- Create: `apps/desktop/src/renderer/src/hooks/use-calendar.ts`
- Create: `apps/desktop/src/renderer/src/hooks/use-calendar-events.ts`

- [ ] **Step 1: Create calendar utility functions**

```typescript
// apps/desktop/src/renderer/src/components/calendar/calendar-utils.ts
import {
  startOfWeek,
  endOfWeek,
  startOfMonth,
  endOfMonth,
  addDays,
  addWeeks,
  addMonths,
  subWeeks,
  subMonths,
  format,
  isSameDay,
  isToday,
  eachDayOfInterval,
  eachHourOfInterval,
  startOfDay,
  endOfDay,
  parseISO,
  differenceInMinutes
} from 'date-fns'

export type CalendarView = 'week' | 'month' | 'agenda'

export function getWeekRange(date: Date, weekStartsOn: 0 | 1 = 1) {
  const start = startOfWeek(date, { weekStartsOn })
  const end = endOfWeek(date, { weekStartsOn })
  return { start, end }
}

export function getMonthRange(date: Date) {
  const start = startOfMonth(date)
  const end = endOfMonth(date)
  return { start, end }
}

export function getMonthGridDays(date: Date, weekStartsOn: 0 | 1 = 1): Date[] {
  const monthStart = startOfMonth(date)
  const monthEnd = endOfMonth(date)
  const gridStart = startOfWeek(monthStart, { weekStartsOn })
  const gridEnd = endOfWeek(monthEnd, { weekStartsOn })
  return eachDayOfInterval({ start: gridStart, end: gridEnd })
}

export function navigateDate(date: Date, view: CalendarView, direction: 'prev' | 'next'): Date {
  const delta = direction === 'next' ? 1 : -1
  switch (view) {
    case 'week':
      return delta > 0 ? addWeeks(date, 1) : subWeeks(date, 1)
    case 'month':
      return delta > 0 ? addMonths(date, 1) : subMonths(date, 1)
    case 'agenda':
      return delta > 0 ? addWeeks(date, 1) : subWeeks(date, 1)
  }
}

export function formatHeaderTitle(date: Date, view: CalendarView): string {
  switch (view) {
    case 'week': {
      const { start, end } = getWeekRange(date)
      if (start.getMonth() === end.getMonth()) {
        return format(start, 'MMMM yyyy')
      }
      return `${format(start, 'MMM')} – ${format(end, 'MMM yyyy')}`
    }
    case 'month':
      return format(date, 'MMMM yyyy')
    case 'agenda':
      return format(date, 'MMMM yyyy')
  }
}

export function getEventTopAndHeight(startAt: string, endAt: string, hourHeight: number) {
  const start = parseISO(startAt)
  const dayStart = startOfDay(start)
  const end = parseISO(endAt)
  const topMinutes = differenceInMinutes(start, dayStart)
  const durationMinutes = Math.max(differenceInMinutes(end, start), 15)
  return {
    top: (topMinutes / 60) * hourHeight,
    height: (durationMinutes / 60) * hourHeight
  }
}

export function toDateKey(date: Date): string {
  return format(date, 'yyyy-MM-dd')
}

export { format, isSameDay, isToday, parseISO, addDays, eachDayOfInterval, startOfDay, endOfDay, differenceInMinutes }
```

- [ ] **Step 2: Create useCalendar hook**

```typescript
// apps/desktop/src/renderer/src/hooks/use-calendar.ts
import { useState, useCallback, useEffect } from 'react'
import { calendarService, type CalendarItem } from '@/services/calendar-service'

export function useCalendar() {
  const [calendars, setCalendars] = useState<CalendarItem[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    const list = await calendarService.listCalendars()
    setCalendars(list)
    setLoading(false)
  }, [])

  useEffect(() => {
    refresh()
    calendarService.onCalendarCreated(() => refresh())
    calendarService.onCalendarUpdated(() => refresh())
    calendarService.onCalendarDeleted(() => refresh())
  }, [refresh])

  const ensureDefaultCalendar = useCallback(async () => {
    const list = await calendarService.listCalendars()
    if (list.length === 0) {
      await calendarService.createCalendar({
        name: 'Personal',
        color: '#6366f1',
        isDefault: true
      })
      await refresh()
    }
  }, [refresh])

  const visibleCalendarIds = calendars.filter((c) => c.isVisible).map((c) => c.id)

  const defaultCalendarId = calendars.find((c) => c.isDefault)?.id ?? calendars[0]?.id

  return { calendars, loading, refresh, ensureDefaultCalendar, visibleCalendarIds, defaultCalendarId }
}
```

- [ ] **Step 3: Create useCalendarEvents hook**

```typescript
// apps/desktop/src/renderer/src/hooks/use-calendar-events.ts
import { useState, useCallback, useEffect, useRef } from 'react'
import { calendarService, type CalendarEvent } from '@/services/calendar-service'
import { format } from 'date-fns'

export function useCalendarEvents(startDate: Date, endDate: Date, calendarIds: string[]) {
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [loading, setLoading] = useState(true)
  const calendarIdsRef = useRef(calendarIds)
  calendarIdsRef.current = calendarIds

  const refresh = useCallback(async () => {
    setLoading(true)
    const start = format(startDate, 'yyyy-MM-dd')
    const end = format(endDate, 'yyyy-MM-dd')
    const list = await calendarService.getEventsForRange(start, end, calendarIdsRef.current)
    setEvents(list)
    setLoading(false)
  }, [startDate, endDate])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    calendarService.onEventCreated(() => refresh())
    calendarService.onEventUpdated(() => refresh())
    calendarService.onEventDeleted(() => refresh())
  }, [refresh])

  return { events, loading, refresh }
}
```

- [ ] **Step 4: Create calendar header component**

```typescript
// apps/desktop/src/renderer/src/components/calendar/calendar-header.tsx
import { type CalendarView, formatHeaderTitle, navigateDate } from './calendar-utils'
import type { CalendarItem } from '@/services/calendar-service'
import { cn } from '@/lib/utils'

interface CalendarHeaderProps {
  currentDate: Date
  view: CalendarView
  calendars: CalendarItem[]
  onDateChange: (date: Date) => void
  onViewChange: (view: CalendarView) => void
  onToggleCalendarVisibility: (id: string) => void
  onNewEvent: () => void
}

const VIEW_OPTIONS: { value: CalendarView; label: string }[] = [
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'agenda', label: 'Agenda' }
]

export function CalendarHeader({
  currentDate,
  view,
  calendars,
  onDateChange,
  onViewChange,
  onToggleCalendarVisibility,
  onNewEvent
}: CalendarHeaderProps) {
  return (
    <div className="flex items-center justify-between px-4 py-2 border-b border-border">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">{formatHeaderTitle(currentDate, view)}</h1>
        <div className="flex gap-1">
          <button
            className="px-2 py-1 rounded-md bg-secondary text-muted-foreground hover:text-foreground"
            onClick={() => onDateChange(navigateDate(currentDate, view, 'prev'))}
          >
            ←
          </button>
          <button
            className="px-2 py-1 rounded-md bg-secondary text-muted-foreground hover:text-foreground"
            onClick={() => onDateChange(navigateDate(currentDate, view, 'next'))}
          >
            →
          </button>
        </div>
        <button
          className="px-3 py-1 rounded-md bg-secondary text-sm text-muted-foreground hover:text-foreground"
          onClick={() => onDateChange(new Date())}
        >
          Today
        </button>
      </div>

      <div className="flex items-center gap-3">
        <div className="flex rounded-lg bg-secondary overflow-hidden border border-border">
          {VIEW_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              className={cn(
                'px-3 py-1.5 text-sm transition-colors',
                view === opt.value
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              )}
              onClick={() => onViewChange(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <button
          className="px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium"
          onClick={onNewEvent}
        >
          + New Event
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Create calendar page shell**

```typescript
// apps/desktop/src/renderer/src/pages/calendar.tsx
import { useState, useCallback, useEffect } from 'react'
import { CalendarHeader } from '@/components/calendar/calendar-header'
import { CalendarWeekView } from '@/components/calendar/calendar-week-view'
import { CalendarMonthView } from '@/components/calendar/calendar-month-view'
import { CalendarAgendaView } from '@/components/calendar/calendar-agenda-view'
import { type CalendarView, getWeekRange, getMonthRange } from '@/components/calendar/calendar-utils'
import { useCalendar } from '@/hooks/use-calendar'
import { useCalendarEvents } from '@/hooks/use-calendar-events'
import { calendarService } from '@/services/calendar-service'
import { createLogger } from '@/lib/logger'

const log = createLogger('Page:Calendar')

export function CalendarPage() {
  const [currentDate, setCurrentDate] = useState(new Date())
  const [view, setView] = useState<CalendarView>('week')
  const [showEventDialog, setShowEventDialog] = useState(false)
  const [selectedSlot, setSelectedSlot] = useState<{ date: Date; time?: string } | null>(null)

  const { calendars, visibleCalendarIds, defaultCalendarId, ensureDefaultCalendar } = useCalendar()

  useEffect(() => {
    ensureDefaultCalendar()
  }, [ensureDefaultCalendar])

  const dateRange = view === 'month' ? getMonthRange(currentDate) : getWeekRange(currentDate)
  const { events } = useCalendarEvents(dateRange.start, dateRange.end, visibleCalendarIds)

  const handleToggleVisibility = useCallback(async (id: string) => {
    const cal = calendars.find((c) => c.id === id)
    if (cal) {
      await calendarService.updateCalendar({ id, isVisible: !cal.isVisible })
    }
  }, [calendars])

  const handleNewEvent = useCallback(() => {
    setSelectedSlot({ date: new Date() })
    setShowEventDialog(true)
  }, [])

  const handleSlotClick = useCallback((date: Date, time?: string) => {
    setSelectedSlot({ date, time })
    setShowEventDialog(true)
  }, [])

  return (
    <div className="flex flex-col h-full">
      <CalendarHeader
        currentDate={currentDate}
        view={view}
        calendars={calendars}
        onDateChange={setCurrentDate}
        onViewChange={setView}
        onToggleCalendarVisibility={handleToggleVisibility}
        onNewEvent={handleNewEvent}
      />

      <div className="flex-1 overflow-hidden">
        {view === 'week' && (
          <CalendarWeekView
            currentDate={currentDate}
            events={events}
            calendars={calendars}
            onSlotClick={handleSlotClick}
          />
        )}
        {view === 'month' && (
          <CalendarMonthView
            currentDate={currentDate}
            events={events}
            calendars={calendars}
            onDayClick={(date) => {
              setCurrentDate(date)
              setView('week')
            }}
            onSlotClick={handleSlotClick}
          />
        )}
        {view === 'agenda' && (
          <CalendarAgendaView
            currentDate={currentDate}
            events={events}
            calendars={calendars}
          />
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/pages/calendar.tsx apps/desktop/src/renderer/src/components/calendar/ apps/desktop/src/renderer/src/hooks/use-calendar.ts apps/desktop/src/renderer/src/hooks/use-calendar-events.ts
git commit -m "feat(calendar): add calendar page shell with header and hooks"
```

---

## Task 10: Week View

**Files:**
- Create: `apps/desktop/src/renderer/src/components/calendar/calendar-week-view.tsx`
- Create: `apps/desktop/src/renderer/src/components/calendar/calendar-event-block.tsx`
- Create: `apps/desktop/src/renderer/src/components/calendar/calendar-time-grid.tsx`

- [ ] **Step 1: Create time grid component**

```typescript
// apps/desktop/src/renderer/src/components/calendar/calendar-time-grid.tsx
const HOURS = Array.from({ length: 24 }, (_, i) => i)
const HOUR_HEIGHT = 48

interface TimeGridProps {
  children: React.ReactNode
}

export function TimeGrid({ children }: TimeGridProps) {
  return (
    <div className="relative">
      {HOURS.map((hour) => (
        <div
          key={hour}
          className="flex border-b border-border/30"
          style={{ height: HOUR_HEIGHT }}
        >
          <div className="w-14 pr-2 text-right text-xs text-muted-foreground -translate-y-2 shrink-0">
            {hour === 0 ? '' : `${hour % 12 || 12} ${hour < 12 ? 'AM' : 'PM'}`}
          </div>
          <div className="flex-1 relative">{/* event blocks rendered as children */}</div>
        </div>
      ))}
      {children}
    </div>
  )
}

export { HOUR_HEIGHT, HOURS }
```

- [ ] **Step 2: Create event block component**

```typescript
// apps/desktop/src/renderer/src/components/calendar/calendar-event-block.tsx
import type { CalendarEvent, CalendarItem } from '@/services/calendar-service'
import { getEventTopAndHeight } from './calendar-utils'
import { HOUR_HEIGHT } from './calendar-time-grid'

interface EventBlockProps {
  event: CalendarEvent
  calendar?: CalendarItem
  onClick?: (event: CalendarEvent) => void
}

export function CalendarEventBlock({ event, calendar, onClick }: EventBlockProps) {
  const color = event.color ?? calendar?.color ?? '#6366f1'
  const { top, height } = getEventTopAndHeight(event.startAt, event.endAt, HOUR_HEIGHT)

  const startTime = new Date(event.startAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const endTime = new Date(event.endAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  return (
    <button
      className="absolute left-1 right-1 rounded-md px-2 py-1 text-left overflow-hidden cursor-pointer transition-opacity hover:opacity-90"
      style={{
        top,
        height: Math.max(height, 20),
        backgroundColor: `${color}20`,
        borderLeft: `3px solid ${color}`
      }}
      onClick={() => onClick?.(event)}
    >
      <div className="text-xs font-medium truncate" style={{ color }}>{event.title}</div>
      {height > 30 && (
        <div className="text-[10px] opacity-70" style={{ color }}>
          {startTime} – {endTime}
        </div>
      )}
      {height > 50 && event.location && (
        <div className="text-[10px] opacity-60 truncate" style={{ color }}>
          📍 {event.location}
        </div>
      )}
    </button>
  )
}
```

- [ ] **Step 3: Create week view component**

```typescript
// apps/desktop/src/renderer/src/components/calendar/calendar-week-view.tsx
import { useMemo, useRef } from 'react'
import type { CalendarEvent, CalendarItem } from '@/services/calendar-service'
import { CalendarEventBlock } from './calendar-event-block'
import { HOUR_HEIGHT } from './calendar-time-grid'
import {
  getWeekRange,
  eachDayOfInterval,
  format,
  isToday,
  isSameDay,
  toDateKey,
  parseISO
} from './calendar-utils'
import { cn } from '@/lib/utils'

interface WeekViewProps {
  currentDate: Date
  events: CalendarEvent[]
  calendars: CalendarItem[]
  onSlotClick: (date: Date, time?: string) => void
  onEventClick?: (event: CalendarEvent) => void
}

const HOURS = Array.from({ length: 24 }, (_, i) => i)
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export function CalendarWeekView({ currentDate, events, calendars, onSlotClick, onEventClick }: WeekViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const { start, end } = getWeekRange(currentDate)
  const days = eachDayOfInterval({ start, end })

  const calendarMap = useMemo(
    () => new Map(calendars.map((c) => [c.id, c])),
    [calendars]
  )

  const allDayEvents = useMemo(
    () => events.filter((e) => e.isAllDay),
    [events]
  )

  const timedEvents = useMemo(
    () => events.filter((e) => !e.isAllDay),
    [events]
  )

  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>()
    for (const event of timedEvents) {
      const key = toDateKey(parseISO(event.startAt))
      const existing = map.get(key) ?? []
      existing.push(event)
      map.set(key, existing)
    }
    return map
  }, [timedEvents])

  return (
    <div className="flex flex-col h-full">
      {/* Day headers */}
      <div className="flex border-b border-border shrink-0">
        <div className="w-14 shrink-0" />
        {days.map((day, i) => (
          <div
            key={i}
            className={cn(
              'flex-1 text-center py-2 border-l border-border/30',
              isToday(day) && 'bg-primary/5'
            )}
          >
            <div className="text-xs text-muted-foreground">{WEEKDAYS[i]}</div>
            <div
              className={cn(
                'text-lg',
                isToday(day)
                  ? 'bg-primary text-primary-foreground rounded-full w-8 h-8 flex items-center justify-center mx-auto'
                  : 'text-foreground'
              )}
            >
              {format(day, 'd')}
            </div>
          </div>
        ))}
      </div>

      {/* All-day row */}
      {allDayEvents.length > 0 && (
        <div className="flex border-b border-border shrink-0 min-h-[28px]">
          <div className="w-14 shrink-0 text-[10px] text-muted-foreground pr-2 text-right pt-1">all-day</div>
          {days.map((day, i) => {
            const dayEvents = allDayEvents.filter((e) => {
              const eStart = parseISO(e.startAt)
              const eEnd = parseISO(e.endAt)
              return day >= eStart && day <= eEnd
            })
            return (
              <div key={i} className="flex-1 border-l border-border/30 px-1 py-0.5">
                {dayEvents.map((e) => {
                  const color = e.color ?? calendarMap.get(e.calendarId)?.color ?? '#6366f1'
                  return (
                    <div
                      key={e.id}
                      className="text-[10px] px-1.5 py-0.5 rounded truncate cursor-pointer"
                      style={{ backgroundColor: `${color}20`, color, borderLeft: `2px solid ${color}` }}
                      onClick={() => onEventClick?.(e)}
                    >
                      {e.title}
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      )}

      {/* Time grid */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="flex">
          {/* Time labels */}
          <div className="w-14 shrink-0">
            {HOURS.map((hour) => (
              <div key={hour} style={{ height: HOUR_HEIGHT }} className="pr-2 text-right">
                <span className="text-xs text-muted-foreground -translate-y-2 block">
                  {hour === 0 ? '' : `${hour % 12 || 12} ${hour < 12 ? 'AM' : 'PM'}`}
                </span>
              </div>
            ))}
          </div>

          {/* Day columns */}
          {days.map((day, i) => {
            const key = toDateKey(day)
            const dayEvents = eventsByDay.get(key) ?? []
            return (
              <div
                key={i}
                className={cn(
                  'flex-1 relative border-l border-border/30',
                  isToday(day) && 'bg-primary/[0.02]'
                )}
                style={{ borderLeftWidth: isToday(day) ? 2 : 1, borderLeftColor: isToday(day) ? 'var(--primary)' : undefined }}
              >
                {HOURS.map((hour) => (
                  <div
                    key={hour}
                    style={{ height: HOUR_HEIGHT }}
                    className="border-b border-border/20 cursor-pointer hover:bg-primary/5"
                    onClick={() => onSlotClick(day, `${String(hour).padStart(2, '0')}:00`)}
                  />
                ))}
                {dayEvents.map((event) => (
                  <CalendarEventBlock
                    key={event.id}
                    event={event}
                    calendar={calendarMap.get(event.calendarId)}
                    onClick={onEventClick}
                  />
                ))}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Verify the app builds**

Run: `pnpm typecheck`
Expected: No new errors (pre-existing test file errors OK).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/calendar/calendar-week-view.tsx apps/desktop/src/renderer/src/components/calendar/calendar-event-block.tsx apps/desktop/src/renderer/src/components/calendar/calendar-time-grid.tsx
git commit -m "feat(calendar): add week view with time grid and event blocks"
```

---

## Task 11: Month View

**Files:**
- Create: `apps/desktop/src/renderer/src/components/calendar/calendar-month-view.tsx`
- Create: `apps/desktop/src/renderer/src/components/calendar/calendar-event-pill.tsx`

- [ ] **Step 1: Create event pill component**

```typescript
// apps/desktop/src/renderer/src/components/calendar/calendar-event-pill.tsx
import type { CalendarEvent, CalendarItem } from '@/services/calendar-service'

interface EventPillProps {
  event: CalendarEvent
  calendar?: CalendarItem
  onClick?: (event: CalendarEvent) => void
}

export function CalendarEventPill({ event, calendar, onClick }: EventPillProps) {
  const color = event.color ?? calendar?.color ?? '#6366f1'
  const time = event.isAllDay
    ? null
    : new Date(event.startAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

  return (
    <button
      className="w-full text-left text-[10px] px-1.5 py-0.5 rounded truncate cursor-pointer mt-0.5"
      style={{ backgroundColor: `${color}15`, color, borderLeft: `2px solid ${color}` }}
      onClick={(e) => {
        e.stopPropagation()
        onClick?.(event)
      }}
    >
      {time && <span className="opacity-70 mr-1">{time}</span>}
      {event.title}
    </button>
  )
}
```

- [ ] **Step 2: Create month view component**

```typescript
// apps/desktop/src/renderer/src/components/calendar/calendar-month-view.tsx
import { useMemo } from 'react'
import type { CalendarEvent, CalendarItem } from '@/services/calendar-service'
import { CalendarEventPill } from './calendar-event-pill'
import {
  getMonthGridDays,
  toDateKey,
  format,
  isToday,
  isSameDay,
  parseISO
} from './calendar-utils'
import { cn } from '@/lib/utils'

interface MonthViewProps {
  currentDate: Date
  events: CalendarEvent[]
  calendars: CalendarItem[]
  onDayClick: (date: Date) => void
  onSlotClick: (date: Date) => void
  onEventClick?: (event: CalendarEvent) => void
}

const MAX_EVENTS_PER_CELL = 3
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export function CalendarMonthView({ currentDate, events, calendars, onDayClick, onSlotClick, onEventClick }: MonthViewProps) {
  const days = getMonthGridDays(currentDate)

  const calendarMap = useMemo(
    () => new Map(calendars.map((c) => [c.id, c])),
    [calendars]
  )

  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>()
    for (const event of events) {
      const key = toDateKey(parseISO(event.startAt))
      const existing = map.get(key) ?? []
      existing.push(event)
      map.set(key, existing)
    }
    return map
  }, [events])

  const currentMonth = currentDate.getMonth()

  return (
    <div className="flex flex-col h-full p-2">
      {/* Weekday headers */}
      <div className="grid grid-cols-7 gap-px mb-1">
        {WEEKDAYS.map((day) => (
          <div key={day} className="text-center text-xs text-muted-foreground py-1">
            {day}
          </div>
        ))}
      </div>

      {/* Day cells */}
      <div className="grid grid-cols-7 gap-px flex-1">
        {days.map((day, i) => {
          const key = toDateKey(day)
          const dayEvents = eventsByDay.get(key) ?? []
          const isCurrentMonth = day.getMonth() === currentMonth
          const overflow = dayEvents.length - MAX_EVENTS_PER_CELL

          return (
            <div
              key={i}
              className={cn(
                'rounded-md p-1 min-h-[80px] cursor-pointer transition-colors',
                isCurrentMonth ? 'bg-card' : 'bg-card/30',
                isToday(day) && 'ring-2 ring-primary ring-inset',
                'hover:bg-accent/50'
              )}
              onClick={() => onSlotClick(day)}
              onDoubleClick={() => onDayClick(day)}
            >
              <span
                className={cn(
                  'text-sm',
                  isToday(day)
                    ? 'bg-primary text-primary-foreground rounded-full w-6 h-6 flex items-center justify-center'
                    : isCurrentMonth
                      ? 'text-foreground'
                      : 'text-muted-foreground/50'
                )}
              >
                {format(day, 'd')}
              </span>
              <div className="mt-0.5">
                {dayEvents.slice(0, MAX_EVENTS_PER_CELL).map((event) => (
                  <CalendarEventPill
                    key={event.id}
                    event={event}
                    calendar={calendarMap.get(event.calendarId)}
                    onClick={onEventClick}
                  />
                ))}
                {overflow > 0 && (
                  <div
                    className="text-[10px] text-muted-foreground mt-0.5 cursor-pointer hover:text-foreground"
                    onClick={(e) => {
                      e.stopPropagation()
                      onDayClick(day)
                    }}
                  >
                    +{overflow} more
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/calendar/calendar-month-view.tsx apps/desktop/src/renderer/src/components/calendar/calendar-event-pill.tsx
git commit -m "feat(calendar): add month view with event pills"
```

---

## Task 12: Agenda View

**Files:**
- Create: `apps/desktop/src/renderer/src/components/calendar/calendar-agenda-view.tsx`

- [ ] **Step 1: Create agenda view**

```typescript
// apps/desktop/src/renderer/src/components/calendar/calendar-agenda-view.tsx
import { useMemo } from 'react'
import type { CalendarEvent, CalendarItem } from '@/services/calendar-service'
import {
  isToday,
  format,
  parseISO,
  toDateKey,
  addDays,
  eachDayOfInterval
} from './calendar-utils'
import { cn } from '@/lib/utils'

interface AgendaViewProps {
  currentDate: Date
  events: CalendarEvent[]
  calendars: CalendarItem[]
  onEventClick?: (event: CalendarEvent) => void
}

const AGENDA_DAYS = 14

export function CalendarAgendaView({ currentDate, events, calendars, onEventClick }: AgendaViewProps) {
  const calendarMap = useMemo(
    () => new Map(calendars.map((c) => [c.id, c])),
    [calendars]
  )

  const days = useMemo(
    () => eachDayOfInterval({ start: currentDate, end: addDays(currentDate, AGENDA_DAYS - 1) }),
    [currentDate]
  )

  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>()
    for (const event of events) {
      const key = toDateKey(parseISO(event.startAt))
      const existing = map.get(key) ?? []
      existing.push(event)
      map.set(key, existing)
    }
    return map
  }, [events])

  return (
    <div className="h-full overflow-y-auto px-4 py-3">
      {days.map((day) => {
        const key = toDateKey(day)
        const dayEvents = eventsByDay.get(key) ?? []
        const today = isToday(day)

        return (
          <div key={key} className="mb-4">
            <div className="flex items-center gap-2 mb-2">
              {today && (
                <span className="bg-primary text-primary-foreground px-2 py-0.5 rounded text-xs font-semibold">
                  TODAY
                </span>
              )}
              <span className={cn('text-sm', today ? 'text-foreground' : 'text-muted-foreground')}>
                {format(day, 'EEEE, MMMM d')}
              </span>
              {dayEvents.length === 0 && (
                <span className="text-xs text-muted-foreground/50">— no events</span>
              )}
            </div>

            {dayEvents.length > 0 && (
              <div className="ml-4 flex flex-col gap-1.5">
                {dayEvents.map((event) => {
                  const cal = calendarMap.get(event.calendarId)
                  const color = event.color ?? cal?.color ?? '#6366f1'
                  const startTime = event.isAllDay
                    ? 'All day'
                    : new Date(event.startAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                  const endTime = event.isAllDay
                    ? null
                    : new Date(event.endAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

                  return (
                    <button
                      key={event.id}
                      className="flex items-center gap-3 px-3 py-2 rounded-lg bg-card border border-border/50 text-left hover:border-border transition-colors"
                      style={{ borderLeftWidth: 3, borderLeftColor: color }}
                      onClick={() => onEventClick?.(event)}
                    >
                      <div className="min-w-[80px] text-xs" style={{ color }}>
                        {startTime}{endTime ? ` – ${endTime}` : ''}
                      </div>
                      <div className="flex-1 text-sm text-foreground">{event.title}</div>
                      {event.location && (
                        <div className="text-xs text-muted-foreground truncate max-w-[150px]">
                          📍 {event.location}
                        </div>
                      )}
                      {cal && (
                        <div className="text-xs text-muted-foreground">{cal.name}</div>
                      )}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/src/renderer/src/components/calendar/calendar-agenda-view.tsx
git commit -m "feat(calendar): add agenda view with day-grouped timeline"
```

---

## Task 13: Event Creation/Edit Dialog

**Files:**
- Create: `apps/desktop/src/renderer/src/components/calendar/calendar-event-dialog.tsx`

- [ ] **Step 1: Create event dialog**

```typescript
// apps/desktop/src/renderer/src/components/calendar/calendar-event-dialog.tsx
import { useState, useCallback } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { calendarService, type CalendarEvent, type CalendarItem } from '@/services/calendar-service'
import { format, parseISO } from './calendar-utils'
import { toast } from 'sonner'

interface EventDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  calendars: CalendarItem[]
  defaultCalendarId: string
  initialDate?: Date
  initialTime?: string
  editEvent?: CalendarEvent | null
  onSaved?: () => void
}

export function CalendarEventDialog({
  open,
  onOpenChange,
  calendars,
  defaultCalendarId,
  initialDate,
  initialTime,
  editEvent,
  onSaved
}: EventDialogProps) {
  const isEditing = !!editEvent

  const defaultStart = initialDate ?? new Date()
  const defaultStartTime = initialTime ?? '09:00'
  const defaultEndTime = (() => {
    const [h, m] = defaultStartTime.split(':').map(Number)
    return `${String(h + 1).padStart(2, '0')}:${String(m).padStart(2, '0')}`
  })()

  const [title, setTitle] = useState(editEvent?.title ?? '')
  const [calendarId, setCalendarId] = useState(editEvent?.calendarId ?? defaultCalendarId)
  const [startDate, setStartDate] = useState(
    editEvent ? format(parseISO(editEvent.startAt), 'yyyy-MM-dd') : format(defaultStart, 'yyyy-MM-dd')
  )
  const [startTime, setStartTime] = useState(
    editEvent ? format(parseISO(editEvent.startAt), 'HH:mm') : defaultStartTime
  )
  const [endDate, setEndDate] = useState(
    editEvent ? format(parseISO(editEvent.endAt), 'yyyy-MM-dd') : format(defaultStart, 'yyyy-MM-dd')
  )
  const [endTime, setEndTime] = useState(
    editEvent ? format(parseISO(editEvent.endAt), 'HH:mm') : defaultEndTime
  )
  const [isAllDay, setIsAllDay] = useState(editEvent?.isAllDay ?? false)
  const [location, setLocation] = useState(editEvent?.location ?? '')
  const [description, setDescription] = useState(editEvent?.description ?? '')
  const [saving, setSaving] = useState(false)

  const handleSave = useCallback(async () => {
    if (!title.trim()) return
    setSaving(true)

    const startAt = isAllDay ? `${startDate}T00:00:00Z` : `${startDate}T${startTime}:00Z`
    const endAt = isAllDay ? `${endDate}T23:59:59Z` : `${endDate}T${endTime}:00Z`

    try {
      if (isEditing && editEvent) {
        await calendarService.updateEvent({
          id: editEvent.id,
          title: title.trim(),
          calendarId,
          startAt,
          endAt,
          isAllDay,
          location: location.trim() || null,
          description: description.trim() || null
        })
        toast.success('Event updated')
      } else {
        await calendarService.createEvent({
          calendarId,
          title: title.trim(),
          startAt,
          endAt,
          isAllDay,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          location: location.trim() || null,
          description: description.trim() || null
        })
        toast.success('Event created')
      }
      onSaved?.()
      onOpenChange(false)
    } catch (err) {
      toast.error('Failed to save event')
    } finally {
      setSaving(false)
    }
  }, [title, calendarId, startDate, startTime, endDate, endTime, isAllDay, location, description, isEditing, editEvent, onSaved, onOpenChange])

  const handleDelete = useCallback(async () => {
    if (!editEvent) return
    await calendarService.deleteEvent(editEvent.id)
    toast.success('Event deleted')
    onOpenChange(false)
  }, [editEvent, onOpenChange])

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-50" />
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-card border border-border rounded-xl shadow-xl w-[480px] max-h-[85vh] overflow-y-auto z-50 p-6">
          <Dialog.Title className="text-lg font-semibold mb-4">
            {isEditing ? 'Edit Event' : 'New Event'}
          </Dialog.Title>

          <div className="flex flex-col gap-3">
            <input
              autoFocus
              placeholder="Event title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-secondary border border-border text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              onKeyDown={(e) => e.key === 'Enter' && handleSave()}
            />

            <select
              value={calendarId}
              onChange={(e) => setCalendarId(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-secondary border border-border text-foreground text-sm"
            >
              {calendars.map((cal) => (
                <option key={cal.id} value={cal.id}>{cal.name}</option>
              ))}
            </select>

            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input type="checkbox" checked={isAllDay} onChange={(e) => setIsAllDay(e.target.checked)} />
              All day
            </label>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Start</label>
                <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)}
                  className="w-full px-3 py-1.5 rounded-lg bg-secondary border border-border text-foreground text-sm" />
                {!isAllDay && (
                  <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)}
                    className="w-full px-3 py-1.5 rounded-lg bg-secondary border border-border text-foreground text-sm mt-1" />
                )}
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">End</label>
                <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)}
                  className="w-full px-3 py-1.5 rounded-lg bg-secondary border border-border text-foreground text-sm" />
                {!isAllDay && (
                  <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)}
                    className="w-full px-3 py-1.5 rounded-lg bg-secondary border border-border text-foreground text-sm mt-1" />
                )}
              </div>
            </div>

            <input
              placeholder="Location or URL"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-secondary border border-border text-foreground text-sm"
            />

            <textarea
              placeholder="Description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 rounded-lg bg-secondary border border-border text-foreground text-sm resize-none"
            />
          </div>

          <div className="flex items-center justify-between mt-6">
            {isEditing ? (
              <button
                onClick={handleDelete}
                className="px-3 py-1.5 rounded-lg text-sm text-destructive hover:bg-destructive/10"
              >
                Delete
              </button>
            ) : (
              <div />
            )}
            <div className="flex gap-2">
              <Dialog.Close asChild>
                <button className="px-4 py-1.5 rounded-lg text-sm text-muted-foreground hover:text-foreground">
                  Cancel
                </button>
              </Dialog.Close>
              <button
                onClick={handleSave}
                disabled={!title.trim() || saving}
                className="px-4 py-1.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50"
              >
                {saving ? 'Saving...' : isEditing ? 'Update' : 'Create'}
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
```

- [ ] **Step 2: Wire dialog into calendar page**

Update `apps/desktop/src/renderer/src/pages/calendar.tsx` — add the dialog import and state:

```typescript
import { CalendarEventDialog } from '@/components/calendar/calendar-event-dialog'

// In the JSX, after the view container:
<CalendarEventDialog
  open={showEventDialog}
  onOpenChange={setShowEventDialog}
  calendars={calendars}
  defaultCalendarId={defaultCalendarId ?? ''}
  initialDate={selectedSlot?.date}
  initialTime={selectedSlot?.time}
/>
```

- [ ] **Step 3: Run typecheck + verify build**

Run: `pnpm typecheck`
Expected: No new errors.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/src/components/calendar/calendar-event-dialog.tsx apps/desktop/src/renderer/src/pages/calendar.tsx
git commit -m "feat(calendar): add event creation/edit dialog"
```

---

## Task 14: Event Quick Popover

**Files:**
- Create: `apps/desktop/src/renderer/src/components/calendar/calendar-event-popover.tsx`

- [ ] **Step 1: Create event popover**

```typescript
// apps/desktop/src/renderer/src/components/calendar/calendar-event-popover.tsx
import * as Popover from '@radix-ui/react-popover'
import type { CalendarEvent, CalendarItem } from '@/services/calendar-service'
import { format, parseISO } from './calendar-utils'

interface EventPopoverProps {
  event: CalendarEvent
  calendar?: CalendarItem
  children: React.ReactNode
  onEdit: (event: CalendarEvent) => void
  onDelete: (eventId: string) => void
}

export function CalendarEventPopover({ event, calendar, children, onEdit, onDelete }: EventPopoverProps) {
  const color = event.color ?? calendar?.color ?? '#6366f1'
  const start = parseISO(event.startAt)
  const end = parseISO(event.endAt)

  const timeLabel = event.isAllDay
    ? 'All day'
    : `${format(start, 'h:mm a')} – ${format(end, 'h:mm a')}`

  const dateLabel = format(start, 'EEEE, MMMM d, yyyy')

  return (
    <Popover.Root>
      <Popover.Trigger asChild>{children}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="bg-card border border-border rounded-xl shadow-xl w-[280px] p-4 z-50"
          sideOffset={4}
          align="start"
        >
          <div className="flex items-start gap-2 mb-3">
            <div className="w-3 h-3 rounded-full mt-1 shrink-0" style={{ backgroundColor: color }} />
            <div>
              <div className="font-medium text-foreground">{event.title}</div>
              <div className="text-xs text-muted-foreground mt-0.5">{dateLabel}</div>
              <div className="text-xs" style={{ color }}>{timeLabel}</div>
            </div>
          </div>

          {event.location && (
            <div className="text-xs text-muted-foreground mb-2">📍 {event.location}</div>
          )}

          {calendar && (
            <div className="text-xs text-muted-foreground mb-3">
              <span className="inline-block w-2 h-2 rounded-full mr-1" style={{ backgroundColor: calendar.color }} />
              {calendar.name}
            </div>
          )}

          <div className="flex gap-2 pt-2 border-t border-border">
            <button
              onClick={() => onEdit(event)}
              className="flex-1 px-3 py-1.5 rounded-lg bg-secondary text-sm text-foreground hover:bg-accent"
            >
              Edit
            </button>
            <button
              onClick={() => onDelete(event.id)}
              className="px-3 py-1.5 rounded-lg text-sm text-destructive hover:bg-destructive/10"
            >
              Delete
            </button>
          </div>

          <Popover.Arrow className="fill-border" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
```

- [ ] **Step 2: Wire popover into event blocks and pills**

Update `CalendarEventBlock` and `CalendarEventPill` to wrap their content in `CalendarEventPopover`. Pass `onEdit` and `onDelete` callbacks from the parent views, which bubble up to `CalendarPage` to open the edit dialog or delete.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/calendar/calendar-event-popover.tsx
git commit -m "feat(calendar): add event quick popover with edit/delete"
```

---

## Task 15: Default Calendar Seeding + Final Verification

**Files:**
- Modify: `apps/desktop/src/main/ipc/calendar-handlers.ts` (add init logic)

- [ ] **Step 1: Add default calendar creation on vault open**

In the vault open handler (or calendar handler registration), ensure a default "Personal" calendar is created if none exist. Add to `registerCalendarHandlers`:

```typescript
ipcMain.handle(CalendarChannels.invoke.CALENDAR_LIST, async () => {
  const svc = getService()
  const list = svc.listCalendars()
  if (list.length === 0) {
    svc.createCalendar({ name: 'Personal', color: '#6366f1', isDefault: true })
    return svc.listCalendars()
  }
  return list
})
```

- [ ] **Step 2: Run full verification suite**

Run:
```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm ipc:check
```

Expected: All pass (pre-existing test file typecheck errors OK).

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "feat(calendar): P1 complete — local calendar with week/month/agenda views"
```

---

## Summary

**14 tasks** covering the complete P1 local calendar:

| # | Component | Key Files |
|---|-----------|-----------|
| 1 | DB Schema | `packages/db-schema/src/schema/calendars.ts`, `calendar-events.ts` |
| 2 | Contracts | `packages/contracts/src/calendar-api.ts`, `calendar-sync-payloads.ts` |
| 3 | Service | `apps/desktop/src/main/calendar/calendar-service.ts` |
| 4 | IPC Handlers | `apps/desktop/src/main/ipc/calendar-handlers.ts` |
| 5 | Sync Handlers | `item-handlers/calendar-handler.ts`, `calendar-event-handler.ts` |
| 6 | Preload | `apps/desktop/src/preload/index.ts` |
| 7 | Frontend Service | `renderer/src/services/calendar-service.ts` |
| 8 | Navigation | `App.tsx`, `app-sidebar.tsx` |
| 9 | Page + Header | `pages/calendar.tsx`, `calendar-header.tsx`, hooks |
| 10 | Week View | `calendar-week-view.tsx`, `calendar-event-block.tsx` |
| 11 | Month View | `calendar-month-view.tsx`, `calendar-event-pill.tsx` |
| 12 | Agenda View | `calendar-agenda-view.tsx` |
| 13 | Event Dialog | `calendar-event-dialog.tsx` |
| 14 | Popover + Verify | `calendar-event-popover.tsx`, default calendar seed |

**Next plans (separate docs):**
- **P2:** Google Calendar sync (OAuth, adapter, incremental sync, LWW merge)
- **P3:** Rich features (recurrence, attendees, reminders, multi-calendar management)
- **P4:** Polish (keyboard shortcuts, drag between calendars, search, day panel)
