import { BrowserWindow } from 'electron'
import { store } from './store'
import { persistKeysAndRegisterDevice } from './sync/device-registration'
import { yDocToMarkdown } from './sync/blocknote-converter'
import { getCrdtProvider } from './sync/crdt-provider'
import { getWritebackDebugState } from './sync/crdt-writeback'
import { getCrdtQueue, getNetworkMonitor } from './sync/runtime'
import { getDatabase } from './database'
import { sql } from 'drizzle-orm'
import { CalendarChannels, TasksChannels } from '@memry/contracts/ipc-channels'

export interface SyncTestBootstrapInput {
  email: string
  setupToken: string
  masterKeyBase64: string
  signingSecretKeyBase64: string
  kdfSalt: string
  keyVerifier: string
  skipSetup?: boolean
}

export interface CalendarProjectionSeedInput {
  day: string
  importedTitle: string
  taskTitle: string
  reminderTitle: string
  snoozeTitle: string
}

interface MemryTestHooks {
  bootstrapSyncDevice(input: SyncTestBootstrapInput): Promise<{ deviceId: string }>
  setNetworkOnlineForTests(online: boolean): Promise<void>
  getCrdtPendingCount(): Promise<number>
  seedCalendarProjection(input: CalendarProjectionSeedInput): Promise<void>
  getCrdtDocMarkdown(noteId: string): Promise<string | null>
  getWritebackDebugState(noteId: string): Promise<{
    pending: boolean
    scheduledCount: number
    performedCount: number
    lastMarkdown: string | null
    lastError: string | null
  } | null>
}

declare global {
  var __memryTestHooks: MemryTestHooks | undefined
}

export function registerTestHooks(): void {
  if (process.env.NODE_ENV !== 'test') {
    return
  }

  const toLocalIso = (day: string, hours: number, minutes: number): string => {
    const [year, month, date] = day.split('-').map(Number)
    return new Date(year, month - 1, date, hours, minutes, 0, 0).toISOString()
  }

  globalThis.__memryTestHooks = {
    async bootstrapSyncDevice(input: SyncTestBootstrapInput): Promise<{ deviceId: string }> {
      const deviceId = await persistKeysAndRegisterDevice(
        Buffer.from(input.masterKeyBase64, 'base64'),
        Buffer.from(input.signingSecretKeyBase64, 'base64'),
        input.setupToken,
        input.kdfSalt,
        input.keyVerifier,
        input.skipSetup ?? false
      )

      store.set('sync', {
        ...store.get('sync'),
        email: input.email,
        recoveryPhraseConfirmed: true
      })

      return { deviceId }
    },

    async setNetworkOnlineForTests(online: boolean): Promise<void> {
      const network = getNetworkMonitor()
      if (!network) {
        throw new Error('Sync runtime is not initialized')
      }

      network.setOnlineForTests(online)
    },

    async getCrdtPendingCount(): Promise<number> {
      return getCrdtQueue()?.getOutstandingCount() ?? 0
    },

    async seedCalendarProjection(input: CalendarProjectionSeedInput): Promise<void> {
      const db = getDatabase()
      const createdAt = new Date(Date.now() - 60 * 60 * 1000).toISOString()
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
      const project = db.get<{ id: string }>(sql`
        SELECT id
        FROM projects
        ORDER BY created_at ASC
        LIMIT 1
      `)

      if (!project) {
        throw new Error('No default project available for calendar test seeding')
      }

      db.run(sql`
        INSERT INTO tasks (
          id,
          project_id,
          status_id,
          title,
          description,
          position,
          due_date,
          due_time,
          created_at,
          modified_at
        )
        VALUES (
          ${'calendar-e2e-task'},
          ${project.id},
          ${null},
          ${input.taskTitle},
          ${'Auto-seeded for calendar e2e'},
          ${1},
          ${input.day},
          ${null},
          ${createdAt},
          ${createdAt}
        )
      `)

      db.run(sql`
        INSERT INTO reminders (
          id,
          target_type,
          target_id,
          remind_at,
          title,
          note,
          status,
          created_at,
          modified_at
        )
        VALUES (
          ${'calendar-e2e-reminder'},
          ${'journal'},
          ${input.day},
          ${toLocalIso(input.day, 11, 0)},
          ${input.reminderTitle},
          ${'Take with breakfast'},
          ${'pending'},
          ${createdAt},
          ${createdAt}
        )
      `)

      db.run(sql`
        INSERT INTO inbox_items (
          id,
          type,
          title,
          content,
          snoozed_until,
          snooze_reason,
          processing_status,
          capture_source,
          created_at,
          modified_at
        )
        VALUES (
          ${'calendar-e2e-snooze'},
          ${'note'},
          ${input.snoozeTitle},
          ${'Seeded snoozed inbox item'},
          ${toLocalIso(input.day, 15, 30)},
          ${'Later today'},
          ${'complete'},
          ${'quick-capture'},
          ${createdAt},
          ${createdAt}
        )
      `)

      db.run(sql`
        INSERT INTO calendar_sources (
          id,
          provider,
          kind,
          account_id,
          remote_id,
          title,
          timezone,
          color,
          is_primary,
          is_selected,
          is_memry_managed,
          sync_status,
          clock,
          created_at,
          modified_at
        )
        VALUES (
          ${'calendar-e2e-google-source'},
          ${'google'},
          ${'calendar'},
          ${'google-account-e2e'},
          ${'google-calendar-e2e'},
          ${'Work'},
          ${timezone},
          ${'#2563eb'},
          ${0},
          ${1},
          ${0},
          ${'ok'},
          ${JSON.stringify({ 'device-e2e': 1 })},
          ${createdAt},
          ${createdAt}
        )
      `)

      db.run(sql`
        INSERT INTO calendar_external_events (
          id,
          source_id,
          remote_event_id,
          remote_etag,
          remote_updated_at,
          title,
          description,
          start_at,
          end_at,
          timezone,
          is_all_day,
          status,
          raw_payload,
          clock,
          created_at,
          modified_at
        )
        VALUES (
          ${'calendar-e2e-external'},
          ${'calendar-e2e-google-source'},
          ${'google-event-e2e'},
          ${'etag-e2e'},
          ${createdAt},
          ${input.importedTitle},
          ${'Imported from Google'},
          ${toLocalIso(input.day, 9, 30)},
          ${toLocalIso(input.day, 10, 30)},
          ${timezone},
          ${0},
          ${'confirmed'},
          ${JSON.stringify({ summary: input.importedTitle })},
          ${JSON.stringify({ 'device-e2e': 1 })},
          ${createdAt},
          ${createdAt}
        )
      `)

      BrowserWindow.getAllWindows().forEach((win) => {
        win.webContents.send(CalendarChannels.events.CHANGED, {
          entityType: 'calendar_external_event',
          id: 'calendar-e2e-external'
        })
        win.webContents.send(TasksChannels.events.CREATED, {
          task: { id: 'calendar-e2e-task' }
        })
      })
    },

    async getCrdtDocMarkdown(noteId: string): Promise<string | null> {
      const doc = getCrdtProvider().getDoc(noteId)
      if (!doc) {
        return null
      }
      return yDocToMarkdown(doc)
    },

    async getWritebackDebugState(noteId: string) {
      return getWritebackDebugState(noteId)
    }
  }
}
