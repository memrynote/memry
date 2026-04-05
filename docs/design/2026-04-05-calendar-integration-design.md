# Calendar Integration — Design Spec

**Date:** 2026-04-05
**Status:** Approved
**Author:** Kaan + Claude

## Overview

Full calendar experience inside memry with two-way Google Calendar sync. Users manage their entire schedule without leaving the app. Tasks with due dates appear alongside calendar events in a unified timeline.

## Goals

- New top-level "Calendar" page with week, month, and agenda views (switchable)
- Native calendar events: create, edit, delete, drag-to-reschedule, recurrence, attendees, reminders
- Two-way Google Calendar sync (first provider, others later)
- Tasks with due dates visible on the calendar (read-only, visually distinct from events)
- Multiple sub-calendars (Work, Personal, etc.) with color coding and visibility toggles
- Offline-first: local events E2E encrypted via existing sync pipeline; Google events cached unencrypted
- Full notifications via native OS notifications

## Architecture: Native Data Model + Provider Adapters

memry owns its data model. External providers connect through adapter interfaces.

```
calendar_events table (native model)
        ↕ SyncItemHandler (memry ↔ memry, E2E encrypted)
        ↕ Provider adapter layer
  ┌─────────────┬──────────────┐
  │ GoogleAdapter│ AppleAdapter │  (future)
  │ (REST API v3)│ (EventKit)  │
  └─────────────┴──────────────┘
```

Two independent sync paths:
- **Path 1 (memry ↔ memry):** Local events sync between devices via existing sync engine. E2E encrypted. Uses `SyncItemHandler` strategy pattern.
- **Path 2 (memry ↔ Google):** `CalendarSyncService` polls Google every 3-5 min. Incremental sync via Google sync tokens. LWW conflict resolution with etag-based stale detection.

These paths share the `calendar_events` table but are otherwise decoupled.

## Data Model

### `calendars` table

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | UUID |
| `name` | text | "Work", "Personal", etc. |
| `color` | text | Hex color for event pills |
| `icon` | text nullable | Emoji/icon |
| `position` | integer | Sort order |
| `isDefault` | boolean | One default calendar for quick event creation |
| `isVisible` | boolean | Toggle visibility on/off in calendar view |
| `providerId` | text FK nullable | Links to `calendar_provider_accounts` if synced externally |
| `externalCalendarId` | text nullable | ID on provider side (Google calendar ID) |
| `syncEnabled` | boolean | Whether two-way sync is active |
| `clock` | JSON | VectorClock — memry-to-memry sync |
| `fieldClocks` | JSON | FieldClocks — field-level merge |
| `syncedAt` | text nullable | Last memry sync timestamp |
| `createdAt` | text | ISO timestamp |
| `modifiedAt` | text | ISO timestamp |

### `calendar_events` table

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | UUID |
| `calendarId` | text FK | Which sub-calendar owns this |
| `title` | text | Event title |
| `description` | text nullable | Rich text / notes |
| `location` | text nullable | Physical address or URL |
| `startAt` | text | ISO datetime with timezone |
| `endAt` | text | ISO datetime with timezone |
| `isAllDay` | boolean | All-day event flag |
| `timezone` | text | IANA timezone (e.g., `Europe/Istanbul`) |
| `recurrenceRule` | text nullable | RRULE string (RFC 5545) |
| `recurrenceExceptions` | text nullable | JSON array of excluded dates |
| `status` | text | `confirmed` / `tentative` / `cancelled` |
| `color` | text nullable | Override calendar-level color |
| `reminders` | text nullable | JSON array of `{method, minutes}` |
| `attendees` | text nullable | JSON array of `{email, name, status, isOrganizer}` |
| `externalEventId` | text nullable | Google event ID for synced events |
| `externalICalUid` | text nullable | iCalendar UID for cross-provider identity |
| `externalEtag` | text nullable | Google etag for change detection |
| `lastExternalSync` | text nullable | Last successful sync timestamp |
| `recurringEventId` | text FK nullable | Points to parent recurring event (for single-occurrence edits) |
| `sourceType` | text | `local` (created in memry) or `external` (pulled from Google) |
| `clock` | JSON nullable | VectorClock — memry sync (local events only) |
| `fieldClocks` | JSON nullable | FieldClocks — field-level merge (local events only) |
| `syncedAt` | text nullable | Last memry sync timestamp |
| `createdAt` | text | ISO timestamp |
| `modifiedAt` | text | ISO timestamp |

Indexes: `calendarId`, `startAt`, `endAt`, `externalEventId`, `sourceType`.

### `calendar_provider_accounts` table

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | UUID |
| `provider` | text | `google` (future: `apple`, `outlook`) |
| `email` | text | Account email for display |
| `accessToken` | text | Encrypted with vault key |
| `refreshToken` | text | Encrypted with vault key |
| `tokenExpiresAt` | text | ISO timestamp |
| `syncCursor` | text nullable | Google sync token for incremental sync |
| `webhookChannelId` | text nullable | Reserved for future webhook support |
| `webhookExpiry` | text nullable | Reserved for future webhook support |
| `createdAt` | text | ISO timestamp |
| `modifiedAt` | text | ISO timestamp |

## Provider Adapter Interface

```typescript
interface CalendarProviderAdapter {
  readonly provider: 'google' | 'apple' | 'outlook'

  authorize(): Promise<AuthResult>
  refreshAuth(account: ProviderAccount): Promise<AuthResult>
  revokeAuth(account: ProviderAccount): Promise<void>

  listCalendars(account: ProviderAccount): Promise<ExternalCalendar[]>

  fetchEvents(account: ProviderAccount, calendarId: string, opts: FetchOpts): Promise<ExternalEvent[]>
  createEvent(account: ProviderAccount, calendarId: string, event: CalendarEventData): Promise<ExternalEvent>
  updateEvent(account: ProviderAccount, calendarId: string, eventId: string, event: CalendarEventData): Promise<ExternalEvent>
  deleteEvent(account: ProviderAccount, calendarId: string, eventId: string): Promise<void>

  incrementalSync(account: ProviderAccount, calendarId: string, syncToken: string): Promise<SyncResult>
  setupWebhook(account: ProviderAccount, calendarId: string): Promise<WebhookChannel>
  teardownWebhook(account: ProviderAccount, channelId: string): Promise<void>
}
```

### Google Adapter

- **Auth:** OAuth 2.0 via Electron `BrowserWindow`. Scopes: `calendar.events`, `calendar.readonly`. Tokens encrypted at rest with vault key.
- **Token refresh:** Check `tokenExpiresAt` before every API call. Silent refresh via refresh token. If refresh fails (revoked), mark account disconnected + prompt re-auth.
- **Incremental sync:** First call fetches rolling 6-month window (3 back, 3 forward) + returns `syncToken`. Subsequent calls use `syncToken` for delta changes only.
- **No webhooks for v1:** Desktop app has no public URL. Poll every 3-5 minutes when online. Webhook support reserved for future sync-server relay.
- **Conflict resolution:** Etag-based stale detection. Before pushing, compare etags. If stale, pull latest, run LWW merge by `modifiedAt`, then push resolved version.
- **Rate limits:** Google allows 1M queries/day per project, 100/100s per user. 3-5 min polling is well within limits.

### Identity Mapping

```
memry event.id (UUID)  ←→  externalEventId (Google event ID)
                            externalICalUid (RFC 5545 UID)
```

- Local → Google: store returned Google event ID + iCalUid after first push.
- Google → Local: match by `externalEventId`, fall back to `iCalUid`.
- No match found: new event — insert with `sourceType: 'external'`.

## Google OAuth Flow

App auth (email/password) and Google Calendar auth are fully independent.

1. User navigates to **Settings → Connections**
2. Clicks "Connect Google Calendar" button
3. Main process opens `BrowserWindow` → Google OAuth consent URL
4. User grants calendar permissions
5. Google redirects to `http://localhost:{port}/callback`
6. Main process captures auth code, exchanges for tokens
7. Tokens encrypted + stored in `calendar_provider_accounts`
8. Window closes, app fetches calendar list
9. User toggles which calendars to sync
10. Multiple Google accounts supported (work + personal)

Disconnect: revoke token via Google API, delete `calendar_provider_accounts` row, delete cached external events for that account.

## Calendar UI

### Navigation

New top-level "Calendar" page in the sidebar, alongside Inbox, Tasks, Journal.

### Page Header

- Current month/year title
- Prev/Next navigation arrows
- "Today" button (jumps to current date)
- View toggle: Week / Month / Agenda (segmented control)
- "+ New Event" button (opens creation dialog, uses default calendar)
- Calendar filter chips (colored dots + names, click to toggle visibility)

### Week View (default)

- 7-day column grid with hourly time slots
- Today column: indigo left border + subtle background tint
- All-day events: top row spanning columns
- Events: solid left-border (calendar color) + filled background tint
- Tasks: dashed indigo border + checkbox prefix, placed at due time or end of day
- Multi-hour events span rows proportionally
- Click empty slot → quick inline creation (title only, Enter to save)
- Drag event block → reschedule (updates startAt/endAt, pushes to Google if synced)

### Month View

- Standard month grid, 7 columns
- Event pills per day cell, colored by calendar
- Tasks as dashed-outline pills with checkbox
- "+N more" overflow when >2-3 events per cell (click → day detail)
- Click day number → jump to week view centered on that day
- Today: indigo outline + filled date number
- Click empty day cell → create all-day event

### Agenda View

- Vertical scrolling list grouped by day
- Each event row: time range, title, calendar source tag, location
- Tasks interleaved with events, dashed border + "due today" label
- Empty days shown collapsed ("Saturday, April 11 — no events")
- Past days hidden by default, scrolls infinitely forward
- "TODAY" badge on current day group

### Visual Language

| Element | Style |
|---------|-------|
| Calendar events | Solid left-border (calendar color), filled background tint, time range |
| Tasks (due date) | Dashed indigo border, transparent background, checkbox prefix |
| Today | Indigo highlight (column border in week, cell outline in month, badge in agenda) |
| Google-sourced events | Calendar color + "Google" source label in agenda view |

### Event Editor Dialog

| Field | UI | Notes |
|-------|-----|-------|
| Title | Text input | Required, auto-focused |
| Calendar | Dropdown | Select sub-calendar |
| Date/Time | Start + End pickers | Extends existing `due-date-picker` pattern |
| All Day | Toggle | Hides time pickers when on |
| Timezone | Dropdown | Defaults to system tz, shown only when toggled |
| Recurrence | Dropdown + custom dialog | Reuses existing `custom-repeat-dialog` |
| Location | Text input | Address or URL, URLs auto-linkified |
| Description | Rich text | BlockNote mini-editor |
| Reminders | Multi-row | Default: 15 min. Add/remove. Method + minutes. |
| Attendees | Email chips input | Type + Enter. Shows RSVP status for Google events. |
| Color | Color dot picker | Override calendar color (optional) |

Event quick-popover on click: title, time, location, calendar badge, Edit/Delete buttons.

## Notifications & Reminders

### Local Events

When a local calendar event has reminders, create rows in the existing `reminders` table:
- `targetType: 'calendar_event'`
- `targetId: event.id`
- `remindAt: event.startAt - reminder.minutes`

The existing `ReminderService` fires these through the standard pipeline. Reuses existing snooze UI (5 min / 15 min / 1 hour / custom).

### External Events (Google)

`CalendarReminderService` runs in main process on a 30-second timer:
- Queries external events where `startAt - reminder.minutes` is within the next 60 seconds
- Fires native OS notification via Electron `Notification` API
- Shows: event title, time, calendar name, location

This avoids creating `reminders` rows for external events (which change frequently during sync).

### Reminder Mapping

- Google `popup` → memry `notification`
- Google `email` → stored but not fired locally (Google handles email reminders server-side)

### Behavior on Event Changes

If event time changes (local edit or sync), reminders auto-recalculate:
- Local events: update `remindAt` in reminders table
- External events: next poll picks up new time, `CalendarReminderService` computes on-the-fly

## Multiple Calendars

### Management

Accessible from **Settings → Calendars** (sub-tab alongside Connections):

- Auto-create one "Personal" calendar on first launch (`isDefault: true`)
- Create new: name, color, icon
- Google calendars appear after connecting account, with sync toggles per calendar
- Visibility toggles shown in calendar header chips

### Sync Behavior

- Local calendars (no provider): sync between memry devices via `calendar` sync handler, E2E encrypted
- Google calendars: events fetched per-calendar using provider adapter. Each calendar has independent `syncCursor`.
- Multiple Google accounts: each account connects separately via Settings → Connections. Each has its own calendars.

## IPC Channels

```typescript
CalendarChannels = {
  invoke: {
    EVENT_CREATE, EVENT_GET, EVENT_UPDATE, EVENT_DELETE, EVENT_LIST,
    CALENDAR_CREATE, CALENDAR_GET, CALENDAR_UPDATE, CALENDAR_DELETE, CALENDAR_LIST,
    GET_EVENTS_FOR_RANGE,
    GET_DAY_EVENTS,
    PROVIDER_CONNECT, PROVIDER_DISCONNECT, PROVIDER_LIST,
    PROVIDER_LIST_CALENDARS, PROVIDER_SYNC_NOW,
    UPDATE_RSVP,
  },
  events: {
    EVENT_CREATED, EVENT_UPDATED, EVENT_DELETED,
    CALENDAR_CREATED, CALENDAR_UPDATED, CALENDAR_DELETED,
    SYNC_STATUS_CHANGED,
    PROVIDER_CONNECTED, PROVIDER_DISCONNECTED,
  }
}
```

`GET_EVENTS_FOR_RANGE` is the workhorse: joins `calendar_events` + `tasks` (by dueDate) for a date range, respects calendar visibility, returns unified timeline. Powers all three views.

## New Sync Item Types

```typescript
SYNC_ITEM_TYPES = [
  ...existing,
  'calendar',
  'calendar_event',
]
```

Only `sourceType: 'local'` events enter memry-to-memry sync. External events are per-device cache.

### Sync Handlers

- **`calendar-handler.ts`** — `SyncItemHandler<Calendar>`. Field-level merge for name, color, position, isVisible, isDefault.
- **`calendar-event-handler.ts`** — `SyncItemHandler<CalendarEvent>`. Field-level merge for `CALENDAR_EVENT_SYNCABLE_FIELDS`: title, description, startAt, endAt, isAllDay, timezone, recurrenceRule, recurrenceExceptions, location, status, color, reminders, attendees, calendarId. Filters to `sourceType === 'local'` only.

## Services Layer

```
src/main/calendar/
  ├── calendar-service.ts          // CRUD for calendars + events
  ├── calendar-sync-service.ts     // Google poll loop, push/pull, LWW merge
  ├── calendar-reminder-service.ts // notifications for external events
  ├── adapters/
  │   ├── types.ts                 // CalendarProviderAdapter interface
  │   └── google-adapter.ts        // Google Calendar API v3
  └── utils/
      ├── recurrence.ts            // RRULE parsing/generation
      └── time-utils.ts            // timezone conversion, range queries
```

## Recurrence Exception Handling

Editing a single occurrence of a recurring event:

1. User clicks an occurrence in the calendar → "Edit this event" or "Edit all events" prompt
2. **Edit all:** modifies the parent event's `recurrenceRule`. All occurrences update.
3. **Edit this occurrence:** adds the original date to `recurrenceExceptions` on the parent, creates a new standalone event at the modified time with a `recurringEventId` field pointing to the parent. This matches Google Calendar's exception model, so sync is a direct mapping.
4. **Delete this occurrence:** adds date to `recurrenceExceptions`, no new event created.

## Conflict Resolution

### memry ↔ memry (between devices)

Field-level merge using `FieldClocks`, same as tasks/projects. Per-field LWW with tick-sum comparison, ties → remote wins.

### memry ↔ Google

1. Before pushing a local change to Google, check `externalEtag` against Google's current etag
2. If match: push succeeds, save new etag
3. If stale: pull Google's version, compare `modifiedAt` timestamps (LWW), push merged result
4. Google-originated changes always apply locally (Google is authoritative for external events)

## Phased Delivery

| Phase | Scope | Shippable? |
|-------|-------|-----------|
| **P1: Local calendar** | DB schema + migrations, calendar CRUD, event CRUD, IPC channels + handlers, week/month/agenda views, quick inline creation, drag-to-reschedule, sidebar navigation entry, sync handlers for memry-to-memry | Yes |
| **P2: Google sync** | OAuth flow in Electron, Google adapter, Settings → Connections UI, incremental sync loop, LWW merge, identity mapping, sync status indicator | Yes |
| **P3: Rich features** | Recurrence (RRULE), attendees/RSVP, reminders + notifications, multiple calendars, visibility toggles, Settings → Calendars UI | Yes |
| **P4: Polish** | Drag between calendars, keyboard shortcuts (n/t/w/m/a), event search, day panel integration, performance optimization for large event sets | Yes |

Each phase is independently shippable. P1 alone delivers a working calendar. P2 makes it connected. P3 makes it feature-complete. P4 refines the experience.
